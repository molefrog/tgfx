import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { Tui, type TuiControls } from "../src/cli/tui";
import { StatusStore, type RouteLabel } from "../src/status";

const alexey: RouteLabel = { key: "100:42:0", chat: "Alexey", group: false };
const team: RouteLabel = { key: "100:-500:0", chat: "team-fx", group: true };

const idleControls: TuiControls = {
  quit: () => undefined, setOutput: () => undefined, setCustomIcons: () => undefined, setPaused: () => undefined,
};

/** A store on a fake clock, and a view that renders it at a chosen instant. */
function scene(startedAt = 1_000_000) {
  let now = startedAt;
  const store = new StatusStore({}, () => now);
  const frame = (controls: TuiControls = idleControls) => {
    const view = render(createElement(Tui, { store, controls, columns: 96, now: () => now }));
    return { text: view.lastFrame() ?? "", view };
  };
  return { store, frame, advance: (ms: number) => { now += ms; } };
}

/** Waits for the view to catch up with input; bounded so a miss fails fast. */
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

describe("live wire status", () => {
  test("shows a failed settings save even when the log is hidden", () => {
    const { store, frame } = scene();
    store.apply({ type: "settings", settings: { saveError: "Setting not saved" } });
    expect(frame().text).toContain("not saved");
  });
  test("draws the telegram-tgfx-fx wire and waits when nothing is happening", () => {
    const { frame } = scene();
    const { text } = frame();
    const [wire, routes, bay] = text.split("\n");
    expect(wire).toMatch(/telegram ●[─·]+ 𝒕𝒈\(𝒇x\) ┈+ ● 𝒇x/);
    expect(routes).toContain("waiting for a message");
    expect(bay).toMatch(/f format\s+p pause ○.*l log ○.*q quit/);
    expect(text).not.toContain("live");
    expect(text.split("\n").length).toBe(3);
  });

  test("a failed poll breaks the left segment and counts down to the retry", () => {
    const { store, frame, advance } = scene();
    store.apply({ type: "poll", state: "reconnecting", retryMs: 4_000 });
    advance(1_200);
    const wire = frame().text.split("\n")[0]!;
    expect(wire).toContain("╌");
    expect(wire).toContain("retry 3s");
    store.apply({ type: "poll", state: "listening" });
    expect(frame().text.split("\n")[0]).not.toContain("retry");
  });

  test("an incoming message rides the left segment with the sender's name", () => {
    const { store, frame, advance } = scene();
    store.apply({ type: "inbound", route: alexey, who: "Alexey" });
    advance(600);
    const wire = frame().text.split("\n")[0]!;
    expect(wire.indexOf("▶ Alexey")).toBeGreaterThan(0);
    expect(wire.indexOf("▶ Alexey")).toBeLessThan(wire.indexOf("𝒕𝒈(𝒇x)"));
  });

  test("a running turn gets a route line with its glyph trace and tool count", () => {
    const { store, frame, advance } = scene();
    store.apply({ type: "session", route: alexey, state: "ready" });
    store.apply({ type: "turn", route: alexey, state: "started", who: "Alexey", text: "fix the flaky renderer test" });
    for (const glyph of ["⋯", "·", "▪", "▫"] as const) {
      advance(1_000);
      store.apply({ type: "turn", route: alexey, state: "event", glyph });
    }
    const [wire, route] = frame().text.split("\n");
    expect(wire).toMatch(/[◐◓◑◒] 𝒇x/);
    expect(route).toContain("Alexey");
    expect(route).toContain("fix the flaky");
    expect(route).toContain("⋯·▪▫");
    expect(route).toContain("4s · 1 tool");
  });

  test("a group line names the chat, the speaker, and the messages waiting behind the turn", () => {
    const { store, frame } = scene();
    store.apply({ type: "turn", route: team, state: "started", who: "Ivan", text: "deploy notes" });
    store.apply({ type: "queue", route: team, waiting: 2 });
    const route = frame().text.split("\n")[1]!;
    expect(route).toContain("team-fx › Ivan");
    expect(route).toContain("+2 waiting");
  });

  test("two busy routes stack under one wire and the fx node counts them", () => {
    const { store, frame } = scene();
    store.apply({ type: "turn", route: alexey, state: "started", who: "Alexey", text: "one" });
    store.apply({ type: "turn", route: team, state: "started", who: "Ivan", text: "two" });
    const lines = frame().text.split("\n");
    expect(lines[0]).toContain("𝒇x ×2");
    expect(lines[1]).toContain("Alexey");
    expect(lines[2]).toContain("team-fx");
    expect(lines.length).toBe(4);
  });

  test("waiting for approval marks the route and the fx node", () => {
    const { store, frame } = scene();
    store.apply({ type: "turn", route: alexey, state: "started", who: "Alexey", text: "rm -rf build" });
    store.apply({ type: "turn", route: alexey, state: "event", glyph: "!" });
    store.apply({ type: "turn", route: alexey, state: "waiting", waiting: true });
    const [wire, route] = frame().text.split("\n");
    expect(wire).toContain("! 𝒇x");
    expect(route).toContain("approval");
    store.apply({ type: "turn", route: alexey, state: "waiting", waiting: false });
    expect(frame().text.split("\n")[1]).not.toContain("approval");
  });

  test("a finished turn keeps its line with the outcome and age, and sends a packet back", () => {
    const { store, frame, advance } = scene();
    store.apply({ type: "session", route: alexey, state: "ready" });
    store.apply({ type: "turn", route: alexey, state: "started", who: "Alexey", text: "hi" });
    store.apply({ type: "turn", route: alexey, state: "finished", outcome: "delivered", seconds: 3.2 });
    advance(400);
    const [wire, routes] = frame().text.split("\n");
    expect(wire).toContain("◀ ✓");
    expect(routes).toContain("Alexey");
    expect(routes).toContain("hi");
    expect(routes).toContain("delivered · 3.2s");
    expect(routes).toContain("0s ago");
    expect(routes).not.toContain("session");
  });

  test("running turns sort above finished ones, newest finished first", () => {
    const { store, frame, advance } = scene();
    store.apply({ type: "turn", route: alexey, state: "started", who: "Alexey", text: "first" });
    store.apply({ type: "turn", route: alexey, state: "finished", outcome: "failed", seconds: 1 });
    advance(60_000);
    store.apply({ type: "turn", route: team, state: "started", who: "Ann", text: "second" });
    store.apply({ type: "turn", route: team, state: "finished", outcome: "delivered", seconds: 1 });
    const other: RouteLabel = { key: "100:7:0", chat: "Bob", group: false };
    store.apply({ type: "turn", route: other, state: "started", who: "Bob", text: "busy" });
    const [, first, second, third] = frame().text.split("\n");
    expect(first).toContain("Bob");
    expect(second).toContain("team-fx");
    expect(third).toContain("Alexey");
    expect(third).toContain("failed");
    expect(third).toContain("1m ago");
  });

  test("a finished line folds into the idle summary after a day", () => {
    const { store, frame, advance } = scene();
    store.apply({ type: "session", route: alexey, state: "ready" });
    store.apply({ type: "turn", route: alexey, state: "started", who: "Alexey", text: "hi" });
    store.apply({ type: "turn", route: alexey, state: "finished", outcome: "delivered", seconds: 3.2 });
    advance(24 * 3_600_000 - 1);
    expect(frame().text.split("\n")[1]).not.toContain("session");
    advance(2);
    const [, routes] = frame().text.split("\n");
    expect(routes).toContain("idle · 1 session");
    expect(routes).toContain("Alexey");
    expect(routes).toContain("24h ago");
  });

  test("each route line carries its own session's model and follows a picker change", () => {
    const { store, frame } = scene();
    store.apply({ type: "session", route: alexey, state: "ready", model: "zai/glm-5.3-flash" });
    store.apply({ type: "session", route: team, state: "ready", model: "anthropic/claude-opus-5" });
    store.apply({ type: "turn", route: alexey, state: "started", who: "Alexey", text: "one" });
    store.apply({ type: "turn", route: team, state: "started", who: "Ivan", text: "two" });
    let lines = frame().text.split("\n");
    expect(lines[0]).not.toContain("glm");
    expect(lines[1]).toContain("0 tools · zai/glm-5.3-flash");
    expect(lines[2]).toContain("0 tools · anthropic/claude-opus-5");
    store.apply({ type: "model", route: alexey, model: "anthropic/claude-sonnet-5" });
    store.apply({ type: "turn", route: alexey, state: "finished", outcome: "delivered", seconds: 2 });
    store.apply({ type: "turn", route: team, state: "finished", outcome: "delivered", seconds: 1 });
    lines = frame().text.split("\n");
    expect(lines[1]).toContain("Alexey");
    expect(lines[1]).toContain("delivered");
    expect(lines[1]).toContain("· anthropic/claude-sonnet-5");
  });

  test("yolo is a checkmark by quit, not a switch", () => {
    const { store, frame } = scene();
    expect(frame().text.split("\n")[2]).not.toContain("yolo");
    store.apply({ type: "settings", settings: { yolo: true } });
    const bay = frame().text.split("\n")[2]!;
    expect(bay).toMatch(/✓ yolo\s+q quit/);
    expect(bay).not.toContain("y yolo");
  });

  test("the wire assembles from tgfx outwards as startup steps finish", () => {
    const { store, frame, advance } = scene();
    store.apply({ type: "boot", step: "fx", state: "running" });
    let [wire, line] = frame().text.split("\n");
    expect(wire).toMatch(/telegram ○┈+ 𝒕𝒈\(𝒇x\) ┈+ [◐◓◑◒] 𝒇x$/);
    expect(line).toContain("starting · checking fx");

    store.apply({ type: "boot", step: "fx", state: "done", detail: "zai/glm-5.3-flash" });
    store.apply({ type: "boot", step: "telegram", state: "done", detail: "@moi_bot" });
    store.apply({ type: "boot", step: "lock", state: "done" });
    store.apply({ type: "boot", step: "menus", state: "running" });
    advance(1_800);
    [wire, line] = frame().text.split("\n");
    expect(wire).toMatch(/^@moi_bot ●┈+ 𝒕𝒈\(𝒇x\) ┈+ ● 𝒇x$/);
    expect(line).toContain("fx ✓ · bot ✓ · lock ✓ · installing menus  1.8s");

    store.apply({ type: "boot", step: "menus", state: "done" });
    store.apply({ type: "boot", step: "polling", state: "done" });
    [wire, line] = frame().text.split("\n");
    expect(wire).toMatch(/^@moi_bot ●[─·]+ 𝒕𝒈\(𝒇x\)/);
    expect(line).toContain("idle");
  });

  test("a failed startup step breaks its segment and names the reason", () => {
    const { store, frame } = scene();
    store.apply({ type: "boot", step: "fx", state: "done", detail: "m" });
    store.apply({ type: "boot", step: "telegram", state: "failed", detail: "401 Unauthorized" });
    const [wire, line] = frame().text.split("\n");
    expect(wire).toContain("✕ 401 Unauthorized");
    expect(wire).toContain("╌");
    expect(line).toContain("bot ✕ 401 Unauthorized");
  });

  test("pausing shows on the wire instead of the listening flow", () => {
    const { store, frame } = scene();
    store.apply({ type: "settings", settings: { paused: true } });
    const [wire, , bay] = frame().text.split("\n");
    expect(wire).toContain("paused");
    expect(bay).toContain("p pause ●");
  });

  test("l opens a log tail below the switches and q quits", async () => {
    const { store, frame } = scene();
    store.logLine("polling.started · @bot");
    let quit = false;
    const { view, text } = frame({ ...idleControls, quit: () => { quit = true; } });
    expect(text).not.toContain("polling.started");
    view.stdin.write("l");
    await until(() => (view.lastFrame() ?? "").includes("polling.started"));
    expect(view.lastFrame()!.split("\n").at(-1)).toContain("polling.started");
    view.stdin.write("q");
    await until(() => quit);
    view.unmount();
  });

  test("f opens the format menu under the bay and shows the values only then", async () => {
    const { frame } = scene();
    const { view, text } = frame();
    expect(text).not.toContain("● on");
    view.stdin.write("f");
    await until(() => (view.lastFrame() ?? "").includes("▸ style"));
    const lines = view.lastFrame()!.split("\n");
    expect(lines[2]).toContain("f format ▾");
    expect(lines[3]).toMatch(/▸ style\s+Live with activity\s+Stream the answer/);
    expect(lines[4]).toMatch(/icons\s+● on\s+custom emoji/);
    expect(lines[5]).toContain("←→ change");
    view.stdin.write("");
    await until(() => !(view.lastFrame() ?? "").includes("style"));
    view.unmount();
  });

  test("arrows move the cursor, space and ←→ step the focused option through its values", async () => {
    const { store, frame } = scene();
    const flips: string[] = [];
    const { view } = frame({
      ...idleControls,
      setOutput: (output) => { flips.push(`output:${output}`); store.apply({ type: "settings", settings: { output } }); },
      setCustomIcons: (on) => { flips.push(`icons:${on}`); store.apply({ type: "settings", settings: { customIcons: on } }); },
      setPaused: (on) => flips.push(`pause:${on}`),
    });
    view.stdin.write("f");
    await until(() => (view.lastFrame() ?? "").includes("▸ style"));
    view.stdin.write("[B");
    await until(() => (view.lastFrame() ?? "").includes("▸ icons"));
    view.stdin.write(" ");
    await until(() => flips.length === 1);
    view.stdin.write("[A");
    await until(() => (view.lastFrame() ?? "").includes("▸ style"));
    view.stdin.write("[C");
    await until(() => flips.length === 2);
    view.stdin.write("[D");
    await until(() => flips.length === 3);
    expect(flips).toEqual(["icons:false", "output:answer", "output:live"]);
    await until(() => /▸ style\s+Live with activity/.test(view.lastFrame() ?? ""));
    view.stdin.write("p");
    await until(() => flips.length === 4);
    expect(flips[3]).toBe("pause:true");
    view.unmount();
  });
});

describe("status store", () => {
  test("does not notify the view when a repeated glyph is suppressed", () => {
    const store = new StatusStore({}, () => 0);
    const event = { type: "turn", route: alexey, state: "event", glyph: "·" } as const;
    store.apply(event);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    const revision = store.revision;
    store.apply(event);
    unsubscribe();
    expect(notifications).toBe(0);
    expect(store.revision).toBe(revision);
  });

  test("notifies the view when a suppressed glyph carries a renamed chat", () => {
    const store = new StatusStore({}, () => 0);
    const event = { type: "turn", route: alexey, state: "event", glyph: "·" } as const;
    store.apply(event);
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    store.apply({ ...event, route: { ...alexey, chat: "New name" } });
    unsubscribe();
    expect(notifications).toBe(1);
    expect(store.snapshot().routes[0]!.chat).toBe("New name");
  });

  test("merges a repeated glyph inside the merge window and keeps it after", () => {
    let now = 0;
    const store = new StatusStore({}, () => now);
    store.apply({ type: "turn", route: alexey, state: "started", who: "Alexey", text: "" });
    for (const step of [0, 100, 300, 1_500]) {
      now = step;
      store.apply({ type: "turn", route: alexey, state: "event", glyph: "·" });
    }
    expect(store.snapshot().routes[0]!.trace.join("")).toBe("··");
  });

  test("keeps only the last forty glyphs of a long turn", () => {
    let now = 0;
    const store = new StatusStore({}, () => now);
    store.apply({ type: "turn", route: alexey, state: "started", who: "Alexey", text: "" });
    for (let index = 0; index < 60; index++) {
      now += 1_000;
      store.apply({ type: "turn", route: alexey, state: "event", glyph: index % 2 ? "▪" : "▫" });
    }
    expect(store.snapshot().routes[0]!.trace.length).toBe(40);
  });

  test("forgets packets once they have crossed the wire", () => {
    let now = 0;
    const store = new StatusStore({}, () => now);
    store.apply({ type: "inbound", route: alexey, who: "Alexey" });
    expect(store.snapshot().packets.length).toBe(1);
    now = 5_000;
    expect(store.snapshot().packets.length).toBe(0);
  });
});
