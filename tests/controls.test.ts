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
import { confirmationData } from "./fixtures/session-confirmation";

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
  let confirmations = 0;
  const createApp = () => new TgfxApp({
    paths, config: { version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: options.group ? [chat] : [] },
      approvals: { chatId: "42", topicId: "0" }, output: options.output ?? "live", customIcons: false },
    bot: { id: "100", username: "fake_bot", displayName: "Fake" }, token: "100:offline", fxBinary: binary, cancelGraceMs: 250,
    telegram: new TelegramApi("100:offline", telegram.url), log: event => {
      if (event.event === "session.confirmation") confirmations++;
      for (const listener of listeners) listener();
    },
    status: (event) => {
      statuses.push(event);
      if (event.type === "turn" && event.state === "started") contexts.push(state.activeContext(route.key)?.context_ref);
      for (const listener of listeners) listener();
    },
  });
  let app = createApp();
  let running = app.run();
  await telegram.waitForCalls("getUpdates");
  let clicks = 0;
  return {
    get app() { return app; }, state, telegram, route, contexts, paths,
    async restart() {
      await app.stop(); await running;
      const polls = telegram.calls("getUpdates").length;
      app = createApp();
      running = app.run();
      await telegram.waitForCalls("getUpdates", polls + 1);
    },
    send(text: string) {
      if (!options.group) return telegram.sendUserMessage({ userId: 42, text });
      const body = /^\/\w+$/.test(text) ? `${text}@fake_bot` : text.startsWith("/") ? text : `@fake_bot ${text}`;
      return telegram.push({ message: {
        message_id: 100 + telegram.requests.length, date: Math.floor(Date.now() / 1000),
        chat: { id: Number(chat), type: "supergroup", title: "Test" },
        from: { id: 42, is_bot: false, first_name: "User" }, text: body,
        entities: body.startsWith("@") ? [{ type: "mention", offset: 0, length: 9 }] : [],
      } } as Omit<Update, "update_id">);
    },
    click(data: string, overrides: { userId?: number; messageId?: number; topicId?: number; chatId?: number } = {}) {
      return telegram.push({ callback_query: { id: `click-${++clicks}`, chat_instance: "test",
        from: { id: overrides.userId ?? 42, is_bot: false, first_name: "User" }, data,
        message: { message_id: overrides.messageId ?? 2000, date: 1,
          ...(overrides.topicId ? { message_thread_id: overrides.topicId } : {}),
          chat: { id: overrides.chatId ?? Number(chat), type: options.group ? "supergroup" : "private" } },
      } } as Omit<Update, "update_id">);
    },
    async confirmation(count = 1) {
      const cards = () => telegram.calls("sendRichMessage")
        .filter(r => confirmationData(r.payload.rich_message));
      if (confirmations < count) {
        const ready = Promise.withResolvers<void>();
        const listener = () => { if (confirmations >= count) ready.resolve(); };
        listeners.add(listener);
        try { await withTimeout(ready.promise, 5000, () => { throw new Error("Missing confirmation"); }); }
        finally { listeners.delete(listener); }
      }
      const rich = cards()[count - 1]!.payload.rich_message;
      const confirm = confirmationData(rich)!;
      const id = confirm.split(":")[1]!;
      const card = JSON.parse(state.interaction(id)!.payload_json).card;
      return { id, confirm, cancel: confirmationData(rich, "cancel")!, messageId: card.messageId };
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
      const text = await readFile(log, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
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
    const card = await h.confirmation();
    h.click(card.confirm, card);
    await h.telegram.waitForRequest(r => r.method === "sendMessage" && String(r.payload.text).includes("fresh conversation"));
    h.send("hello"); await h.status("finished");
    expect(h.telegram.calls("sendRichMessage")).toHaveLength(2);
  } finally { await h.close(); }
});

test("clear survives a restart before the next message without resuming an empty session", async () => {
  const h = await harness({ failedLoad: true });
  try {
    h.send("/clear");
    const card = await h.confirmation();
    h.click(card.confirm, card);
    await h.telegram.waitForRequest(r => r.method === "sendMessage" && String(r.payload.text).includes("fresh conversation"));
    await h.restart();
    expect(h.state.ensureRoute(h.route).session_id).toBeNull();
    h.send("hello after restart"); await h.status("finished");
    const events = await h.events();
    expect(events.filter(e => e.event === "new")).toHaveLength(1);
    expect(events.filter(e => e.event === "load")).toHaveLength(0);
    expect(h.telegram.calls("sendMessage").some(r => String(r.payload.text).includes("resumed"))).toBeFalse();
    expect(h.telegram.calls("sendRichMessage")).toHaveLength(2);
  } finally { await h.close(); }
});

test("clear arriving in the same batch as a request leaves the route usable", async () => {
  const h = await harness();
  try {
    h.send("WAIT");
    h.send("/clear");
    const card = await h.confirmation();
    h.click(card.confirm, card);
    await h.telegram.waitForRequest(r => r.method === "sendMessage" && String(r.payload.text).includes("fresh conversation"));
    h.send("hello");
    await h.telegram.waitForCalls("sendRichMessage", 2);
    expect(h.telegram.calls("sendRichMessage")).toHaveLength(2);
  } finally { await h.close(); }
});

test.each(["clear", "compact"])("/%s waits for confirmation and cancellation preserves the running task", async action => {
  const h = await harness();
  try {
    h.send("WAIT"); await h.status("started");
    const context = h.state.activeContext(h.route.key)!.context_ref;
    h.send(`/${action}`);
    const card = await h.confirmation();
    expect(h.state.activeContext(h.route.key)?.context_ref).toBe(context);
    expect((await h.events()).filter(e => e.event === "prompt")).toHaveLength(1);
    expect((await h.events()).some(e => e.event === "cancel")).toBeFalse();
    h.click(card.cancel, card);
    await h.telegram.waitForRequest(r => r.method === "editMessageText" && JSON.stringify(r.payload).includes("Cancelled"));
    expect(h.state.activeContext(h.route.key)?.context_ref).toBe(context);
    h.send("/stop"); await h.status("finished");
    expect((await h.events()).filter(e => e.event === "prompt")).toHaveLength(1);
  } finally { await h.close(); }
});

test("only the requesting group member can confirm, and repeated clicks do not clear twice", async () => {
  const h = await harness({ group: true });
  try {
    h.send("hello"); await h.status("finished");
    const generation = h.state.ensureRoute(h.route).generation;
    h.send("/clear");
    const card = await h.confirmation();
    h.click(card.confirm, { ...card, userId: 99 });
    await h.telegram.waitForRequest(r => r.method === "answerCallbackQuery" && String(r.payload.text).includes("Only"));
    expect(h.state.ensureRoute(h.route).generation).toBe(generation);
    expect(h.state.interaction(card.id)?.state).toBe("pending");
    h.click(card.confirm, card);
    await h.telegram.waitForRequest(r => r.method === "sendMessage" && String(r.payload.text).includes("fresh conversation"));
    h.click(card.confirm, card);
    await h.telegram.waitForRequest(r => r.method === "answerCallbackQuery" && String(r.payload.text).includes("expired"));
    expect(h.state.ensureRoute(h.route).generation).toBe(generation + 1);
  } finally { await h.close(); }
});

test.each(["expired", "wrong message", "wrong topic", "wrong chat", "superseded"])("rejects a %s confirmation", async reason => {
  const h = await harness({ group: true });
  try {
    h.send("/clear");
    const card = await h.confirmation();
    const generation = h.state.ensureRoute(h.route).generation;
    if (reason === "expired") h.state.db.query("UPDATE telegram_interactions SET expires_at=? WHERE interaction_id=?")
      .run("2000-01-01T00:00:00.000Z", card.id);
    if (reason === "superseded") { h.send("/compact"); await h.confirmation(2); }
    h.click(card.confirm, { ...card,
      ...(reason === "wrong message" ? { messageId: card.messageId + 1 } : {}),
      ...(reason === "wrong topic" ? { topicId: 10 } : {}),
      ...(reason === "wrong chat" ? { chatId: -43 } : {}),
    });
    await h.telegram.waitForRequest(r => r.method === "answerCallbackQuery" && String(r.payload.text).includes("expired"));
    expect(h.state.ensureRoute(h.route).generation).toBe(generation);
    expect(await h.events()).toHaveLength(0);
  } finally { await h.close(); }
});

test("a pending confirmation survives restart and compacts only after its button is pressed", async () => {
  const h = await harness({ output: "answer" });
  try {
    h.send("/compact");
    const card = await h.confirmation();
    await h.restart();
    expect(await h.events()).toHaveLength(0);
    h.click(card.confirm, card);
    await h.telegram.waitForRequest(r => r.method === "editMessageText" && JSON.stringify(r.payload).includes("compacted"));
    const prompts = (await h.events()).filter(e => e.event === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.value.prompt).toEqual([{ type: "text", text: "/compact" }]);
  } finally { await h.close(); }
});

test("stop discards confirmed compaction queued behind an active task", async () => {
  const h = await harness();
  try {
    h.send("WAIT"); await h.status("started");
    h.send("/compact");
    const card = await h.confirmation();
    h.click(card.confirm, card);
    await h.telegram.waitForRequest(r => r.method === "editMessageText" && JSON.stringify(r.payload).includes("queued"));
    h.send("/stop"); await h.status("finished");
    h.send("next"); await h.status("finished", 2);
    const prompts = (await h.events()).filter(e => e.event === "prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts.every(p => p.value.prompt[0]?.text !== "/compact")).toBeTrue();
  } finally { await h.close(); }
});

test("confirmed compaction waits for the current task to finish", async () => {
  const h = await harness({ output: "answer" });
  try {
    h.send("PERMISSION");
    const approval = await h.telegram.waitForRequest(r => r.method === "sendMessage" && r.payload.reply_markup);
    const context = h.state.activeContext(h.route.key)!.context_ref;
    h.send("/compact");
    const card = await h.confirmation();
    h.click(card.confirm, card);
    await h.telegram.waitForRequest(r => r.method === "editMessageText" && JSON.stringify(r.payload).includes("queued"));
    expect(h.state.activeContext(h.route.key)?.context_ref).toBe(context);
    expect((await h.events()).filter(e => e.event === "prompt")).toHaveLength(1);
    h.click(approval.payload.reply_markup.inline_keyboard[0][0].callback_data);
    await h.status("finished");
    await h.telegram.waitForRequest(r => r.method === "editMessageText" && JSON.stringify(r.payload).includes("compacted"));
    const prompts = (await h.events()).filter(e => e.event === "prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.value.prompt).toEqual([{ type: "text", text: "/compact" }]);
  } finally { await h.close(); }
});

test.each([{ output: "answer" as const }, { group: true }])("/stop works without a private live draft (%j)", async options => {
  const h = await harness(options);
  try {
    h.send("WAIT"); await h.status("started");
    h.send("group" in options ? "/stop@fake_bot" : "/stop"); await h.status("finished");
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
    const card = await h.confirmation();
    h.click(card.confirm, card);
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
