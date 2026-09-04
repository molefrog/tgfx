import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Update } from "grammy/types";
import { TgfxApp } from "../src/app";
import { StateStore } from "../src/state";
import { loadConfig, workspacePaths } from "../src/config";
import { TelegramApi } from "../src/telegram/api";
import { FakeTelegram } from "./fixtures/fake-telegram";
import type { StatusEvent } from "../src/status";
import type { OutputMode } from "../src/types";
import { withTimeout } from "../src/timeout";
import { normalizeMessageUpdate } from "../src/telegram/normalize";

async function harness(options: { failedLoad?: boolean; output?: OutputMode; group?: boolean; recoveredClear?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tgfx-controls-"));
  const home = process.env.TGFX_HOME;
  process.env.TGFX_HOME = join(root, "home");
  const paths = workspacePaths("100", root);
  const binary = join(root, "fx");
  const log = join(root, "fx.log");
  await writeFile(binary, [
    "#!/bin/sh", `export FAKE_FX_LOG='${log}'`,
    ...(options.failedLoad ? ["export FAKE_FX_FAIL_LOAD=1"] : []),
    `exec '${process.execPath}' '${resolve("tests/fixtures/fake-fx.ts")}' "$@"`, "",
  ].join("\n"));
  await chmod(binary, 0o700);
  const telegram = new FakeTelegram();
  const state = new StateStore(paths.database);
  const chat = options.group ? "-42" : "42";
  const route = { key: `100:${chat}:0`, botId: "100", chatId: chat, topicId: "0", chatKind: options.group ? "supergroup" as const : "private" as const };
  if (options.failedLoad) {
    state.ensureRoute(route);
    state.setRouteSession(route.key, "stale-session");
  }
  if (options.recoveredClear) {
    const message = normalizeMessageUpdate({ id: "100", username: "fake_bot", displayName: "Fake" }, {
      update_id: 0, message: { message_id: 1, date: 1, chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false, first_name: "User" }, text: "/clear" },
    } as Update)!;
    state.ensureRoute(route);
    state.ingestUpdate({ botId: "100", updateId: 0, routeKey: route.key, payload: { kind: "message", message }, authorized: true });
  }
  const statuses: StatusEvent[] = [];
  const listeners = new Set<() => void>();
  const contexts: Array<string | undefined> = [];
  const app = new TgfxApp({
    paths, config: { version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: options.group ? [chat] : [] },
      approvals: { chatId: "42", topicId: "0" }, output: options.output ?? "live", customIcons: false },
    bot: { id: "100", username: "fake_bot", displayName: "Fake" }, token: "100:offline", fxBinary: binary,
    telegram: new TelegramApi("100:offline", telegram.url), log: () => undefined,
    status: (event) => {
      statuses.push(event);
      if (event.type === "turn" && event.state === "started") contexts.push(state.activeContext(route.key)?.context_ref);
      for (const listener of listeners) listener();
    },
  });
  const running = app.run();
  await telegram.waitForCalls("getUpdates");
  return {
    app, state, telegram, route, contexts, paths,
    send(text: string) {
      if (!options.group) return telegram.sendUserMessage({ userId: 42, text });
      const body = text.startsWith("/") ? text : `@fake_bot ${text}`;
      return telegram.push({ message: {
        message_id: 100 + telegram.requests.length, date: Math.floor(Date.now() / 1000),
        chat: { id: Number(chat), type: "supergroup", title: "Test" },
        from: { id: 42, is_bot: false, first_name: "User" }, text: body,
        entities: body.startsWith("@") ? [{ type: "mention", offset: 0, length: 9 }] : [],
      } } as Omit<Update, "update_id">);
    },
    click(data: string) {
      return telegram.push({ callback_query: { id: `click-${telegram.requests.length}`, chat_instance: "test",
        from: { id: 42, is_bot: false, first_name: "User" }, data,
        message: { message_id: 2000, date: 1, chat: { id: Number(chat), type: options.group ? "supergroup" : "private" } },
      } } as Omit<Update, "update_id">);
    },
    async status(stateName: "started" | "finished", count = 1) {
      const matches = () => statuses.filter(e => e.type === "turn" && e.state === stateName).length >= count;
      if (matches()) return;
      const ready = Promise.withResolvers<void>();
      const listener = () => { if (matches()) ready.resolve(); };
      listeners.add(listener);
      try { await withTimeout(ready.promise, 8000, () => { throw new Error(`Missing turn ${stateName}`); }); }
      finally { listeners.delete(listener); }
    },
    accepted(id: number) { return telegram.waitForRequest(r => r.method === "getUpdates" && r.payload.offset > id); },
    async events(): Promise<Array<{ event: string; value: any }>> {
      return (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    },
    async close() {
      await app.stop(); await running; state.close(); await telegram.stop();
      if (home === undefined) delete process.env.TGFX_HOME; else process.env.TGFX_HOME = home;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test.each(["format", "cost", "model"])("/%s preserves the running task's context", async command => {
  const h = await harness();
  try {
    h.send("WAIT"); await h.status("started");
    const context = h.state.activeContext(h.route.key)!;
    const id = h.send(`/${command}`); await h.accepted(id);
    // The completed command is durable before inspecting its effect on the context.
    await h.telegram.waitForRequest(r => command === "cost" ? r.method === "sendRichMessage" : r.method === "sendMessage");
    expect(h.state.activeContext(h.route.key)?.context_ref).toBe(context.context_ref);
    h.send("/stop"); await h.status("finished");
    expect(h.state.activeContext(h.route.key)).toBeUndefined();
  } finally { await h.close(); }
});

test("shutdown waits for the last settings change to reach disk", async () => {
  const h = await harness();
  try {
    h.app.setOutput("answer");
    h.app.setCustomIcons(false);
    await h.app.stop();
    const saved = (await loadConfig(h.paths))!;
    expect(saved.output).toBe("answer");
    expect(saved.customIcons).toBeFalse();
  } finally { await h.close(); }
});

test("a failed settings save is exposed to the running view", async () => {
  const h = await harness();
  try {
    await mkdir(h.paths.config, { recursive: true });
    h.app.setOutput("answer");
    await h.app.stop();
    expect(h.app.settings().saveError).toContain("not saved");
  } finally { await h.close(); }
});

test("a replacement session retains the new request's tool access and bootstrap", async () => {
  const h = await harness({ failedLoad: true });
  try {
    h.send("hello"); await h.status("finished");
    expect(h.contexts[0]).toBeDefined();
    const prompt = (await h.events()).find(e => e.event === "prompt")!;
    const envelope = JSON.parse(prompt.value.prompt[0].text).telegram_message;
    expect(envelope.session_bootstrap).toBeDefined();
    expect(envelope.context_ref).toBe(h.contexts[0]);
  } finally { await h.close(); }
});

test("a new request replaces a crashed agent without replaying the failed request", async () => {
  const h = await harness();
  try {
    h.send("CRASH_AGENT"); await h.status("finished");
    await h.telegram.waitForRequest(r => r.method === "sendMessage" && String(r.payload.text).includes("could not finish"));
    h.send("hello"); await h.status("finished", 2);
    const events = await h.events();
    expect(events.filter(e => e.event === "initialize")).toHaveLength(2);
    expect(events.filter(e => e.event === "prompt")).toHaveLength(2);
    expect(h.telegram.calls("sendRichMessage")).toHaveLength(1);
  } finally { await h.close(); }
});

test("an unfinished FX response reports failure and the next request still works", async () => {
  const h = await harness({ output: "answer" });
  try {
    const id = h.send("STOP_REASON=max_output_tokens");
    await h.telegram.waitForRequest(r => r.method === "sendMessage" && String(r.payload.text).includes("unfinished"));
    expect(h.state.db.query("SELECT status FROM telegram_inbox WHERE update_id = ?").get(id))
      .toEqual({ status: "failed" });
    expect(h.telegram.calls("sendRichMessage")).toHaveLength(0);
    h.send("hello");
    await h.status("finished", 2);
    const events = await h.events();
    expect(events.filter(e => e.event === "prompt")).toHaveLength(2);
    expect(events.filter(e => e.event === "initialize")).toHaveLength(1);
    expect(h.telegram.calls("sendRichMessage")).toHaveLength(1);
  } finally { await h.close(); }
});

test("a recovered clear command does not wait on its own queue", async () => {
  const h = await harness({ recoveredClear: true });
  try {
    await h.telegram.waitForRequest(r => r.method === "sendMessage" && String(r.payload.text).includes("fresh conversation"));
    h.send("hello"); await h.status("finished");
    expect(h.telegram.calls("sendRichMessage")).toHaveLength(1);
  } finally { await h.close(); }
});

test("clear arriving in the same batch as a request leaves the route usable", async () => {
  const h = await harness();
  try {
    h.send("WAIT");
    h.send("/clear");
    await h.telegram.waitForRequest(r => r.method === "sendMessage" && String(r.payload.text).includes("fresh conversation"));
    h.send("hello");
    await h.telegram.waitForCalls("sendRichMessage");
    expect(h.telegram.calls("sendRichMessage")).toHaveLength(1);
  } finally { await h.close(); }
});

test.each([{ output: "answer" as const }, { group: true }])("/stop works without a private live draft (%j)", async options => {
  const h = await harness(options);
  try {
    h.send("WAIT"); await h.status("started");
    h.send("/stop"); await h.status("finished");
    expect(h.telegram.calls("sendRichMessageDraft")).toHaveLength(0);
    expect(h.telegram.calls("sendMessage").some(r => String(r.payload.text).includes("cancelled"))).toBeTrue();
  } finally { await h.close(); }
});

test("/clear terminates an uncooperative task and runs later requests in a fresh session", async () => {
  const h = await harness({ output: "answer" });
  try {
    h.send("WAIT IGNORE_CANCEL"); await h.status("started");
    h.send("discard this queued request");
    h.send("/clear");
    await h.telegram.waitForRequest(r => r.method === "sendMessage" && String(r.payload.text).includes("Stopping"));
    h.send("after clear");
    await h.status("finished", 2);
    const events = await h.events();
    expect(events.filter(e => e.event === "prompt")).toHaveLength(2);
    expect(events.filter(e => e.event === "new")).toHaveLength(2);
    expect(h.state.db.query("SELECT status FROM telegram_inbox WHERE update_id=2").get()).toEqual({ status: "discarded" });
  } finally { await h.close(); }
}, 10000);

test("model navigation responds during a task and selection applies to the next turn", async () => {
  const h = await harness();
  try {
    h.send("WAIT"); await h.status("started");
    h.send("/model");
    const card = await h.telegram.waitForRequest(r => r.method === "sendMessage" && r.payload.reply_markup);
    const data = card.payload.reply_markup.inline_keyboard[0][0].callback_data as string;
    h.click(data);
    await h.telegram.waitForCalls("editMessageText");
    const id = data.split(":")[1]!;
    const options = JSON.parse(h.state.interaction(id)!.payload_json).options;
    h.click(`model:${id}:s.1`);
    await h.telegram.waitForRequest(r => r.method === "editMessageText" && String(r.payload.text).includes("next turn"));
    expect((await h.events()).filter(e => e.event === "set_config_option")).toHaveLength(0);
    h.send("/stop"); await h.status("finished");
    h.send("next"); await h.status("finished", 2);
    expect((await h.events()).find(e => e.event === "set_config_option")?.value.value).toBe(options[1].value);
  } finally { await h.close(); }
});
