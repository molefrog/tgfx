import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Update } from "grammy/types";
import { TgfxApp } from "../src/app";
import { workspacePaths } from "../src/config";
import { StateStore } from "../src/state";
import { TelegramApi } from "../src/telegram/api";
import { withTimeout } from "../src/timeout";
import { FakeTelegram } from "./fixtures/fake-telegram";
import { confirmationData, confirmUpdate } from "./fixtures/session-confirmation";

async function harness(options: { group?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tgfx-event-controls-"));
  const home = process.env.TGFX_HOME;
  process.env.TGFX_HOME = join(dir, "home");
  const paths = workspacePaths("100", dir), log = join(dir, "fx.jsonl"), binary = join(dir, "fx");
  await writeFile(log, "");
  await writeFile(binary, `#!/bin/sh\nexport FAKE_FX_LOG='${log}'\nexec '${process.execPath}' '${resolve("tests/fixtures/fake-fx.ts")}' "$@"\n`);
  await chmod(binary, 0o700);
  const telegram = new FakeTelegram();
  const state = new StateStore(paths.database, dir);
  const waiters = new Map<string, () => void>();
  const confirmation = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const createApp = () => new TgfxApp({ paths, token: "100:offline", bot: { id: "100", username: "fake_bot", displayName: "Fake" },
    fxBinary: binary, cancelGraceMs: 100,
    config: { version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: options.group ? ["-42"] : [] },
      approvals: { chatId: "42", topicId: "0" }, output: "answer", customIcons: false },
    telegram: new TelegramApi("100:offline", telegram.url),
    log: event => {
      if (event.event === "session.confirmation") confirmation.resolve();
      if (event.event === "turn.delivered") delivered.resolve();
      if (event.event === "external.done" || event.event === "external.failed") waiters.get(String(event.id))?.();
    },
  });
  let app = createApp(), running = app.run();
  await telegram.waitForCalls("getUpdates");
  const records = async (): Promise<Array<{ event: string; value: any }>> =>
    (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { get app() { return app; }, telegram, state, paths, dir, records,
    confirmation: confirmation.promise, delivered: delivered.promise,
    async prompted(count = 1) {
      const ready = Promise.withResolvers<void>();
      const check = async () => { if ((await records()).filter(x => x.event === "prompt").length >= count) ready.resolve(); };
      const watcher = watch(log, () => { void check(); });
      try { await check(); await withTimeout(ready.promise, 5000, () => { throw new Error("FX prompt timed out"); }); }
      finally { watcher.close(); }
    },
    async done(id: string) {
      if (!["queued", "running"].includes(app.eventJob(id)?.status ?? "")) return;
      const ready = Promise.withResolvers<void>(); waiters.set(id, ready.resolve);
      await withTimeout(ready.promise, 5000, () => { throw new Error(`Event ${id} timed out`); });
    },
    async inactive() {
      const deadline = Date.now() + 5000;
      // Let the completed turn's promise callbacks release its queue tail.
      do {
        if (Date.now() >= deadline) throw new Error("Event context stayed active");
        await new Promise<void>(resolve => setImmediate(resolve));
      } while (state.activeContext(`100:${options.group ? "-42" : "42"}:0`));
    },
    async restart() {
      await app.stop(); await running;
      const polls = telegram.calls("getUpdates").length;
      app = createApp(); running = app.run();
      await telegram.waitForCalls("getUpdates", polls + 1);
    },
    async mcp() {
      const launch = (await records()).find(x => x.event === "new")!.value.mcpServers[0];
      const client = new Client({ name: "event-controls", version: "1" });
      await client.connect(new StdioClientTransport({ command: launch.command, args: launch.args,
        env: { PATH: process.env.PATH!, TGFX_INTERNAL_TELEGRAM_API_ROOT: telegram.url,
          ...Object.fromEntries(launch.env.map((e: { name: string; value: string }) => [e.name, e.value])) }, stderr: "pipe" }));
      return client;
    },
    async adminApproval() {
      const ready = Promise.withResolvers<ReturnType<StateStore["pendingApprovals"]>[number]>();
      const check = () => {
        const approval = state.pendingApprovals("100").find(a => a.kind === "telegram_admin:pins" && a.card);
        if (approval) ready.resolve(approval);
      };
      const watcher = watch(`${paths.database}-wal`, check);
      try { check(); return await withTimeout(ready.promise, 5000, () => { throw new Error("Approval card timed out"); }); }
      finally { watcher.close(); }
    },
    async close() {
      await app.stop(); await running; state.close(); await telegram.stop();
      if (home === undefined) delete process.env.TGFX_HOME; else process.env.TGFX_HOME = home;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test.each(["stop", "clear"] as const)("/%s cancels queued external work and preserves later events across restart", async command => {
  const h = await harness();
  try {
    h.app.emitExternal({ id: "first", name: "WAIT IGNORE_CANCEL", chatId: "42" });
    await h.prompted();
    const queued = { id: "queued", name: "discard this event", chatId: "42" };
    h.app.emitExternal(queued);
    h.telegram.sendUserMessage({ userId: 42, text: `/${command}` });
    if (command === "clear") {
      await h.confirmation;
      const card = await h.telegram.waitForRequest(r => r.method === "sendRichMessage" && !!confirmationData(r.payload.rich_message));
      const id = confirmationData(card.payload.rich_message)!.split(":")[1]!;
      const messageId = JSON.parse(h.state.interaction(id)!.payload_json).card.messageId;
      const { update_id: _, ...update } = confirmUpdate(card.payload.rich_message, messageId);
      h.telegram.push(update);
    }
    await h.telegram.waitForRequest(r => r.method === "sendMessage" && String(r.payload.text).includes("Stopping"));
    h.app.emitExternal({ id: "later", name: "new work", chatId: "42", steer: true });
    await h.done("later");
    expect(h.app.eventJob("later")?.status).toBe("done");
    expect(h.app.emitExternal(queued).status).toBe("cancelled");
    await h.restart();
    expect(h.app.eventJob("queued")?.status).toBe("cancelled");
    expect((await h.records()).filter(x => x.event === "prompt")).toHaveLength(2);
  } finally { await h.close(); }
});

test("an external queue tail resets Telegram notices for the next busy period", async () => {
  const h = await harness();
  const notices = () => h.telegram.calls("sendMessage").filter(r => String(r.payload.text).includes("Your message is queued"));
  try {
    h.app.emitExternal({ id: "first", name: "PERMISSION", chatId: "42" });
    const approval = await h.telegram.waitForRequest(r => r.method === "sendMessage" && r.payload.reply_markup);
    h.telegram.sendUserMessage({ userId: 42, text: "first follow-up" });
    await h.telegram.waitForRequest(r => r.method === "sendMessage" && notices().length === 1);
    h.app.emitExternal({ id: "tail", name: "finish the queue", chatId: "42" });
    h.telegram.push({ callback_query: { id: "allow-first", chat_instance: "test",
      data: approval.payload.reply_markup.inline_keyboard[0][0].callback_data,
      from: { id: 42, is_bot: false, first_name: "Owner" },
      message: { message_id: 2000, date: 1, chat: { id: 42, type: "private" } },
    } } as Omit<Update, "update_id">);
    await h.done("tail");
    await h.inactive();
    h.app.emitExternal({ id: "next", name: "WAIT", chatId: "42" });
    await h.prompted(4);
    h.telegram.sendUserMessage({ userId: 42, text: "second follow-up" });
    await h.telegram.waitForRequest(r => r.method === "sendMessage" && notices().length === 2);
    expect(notices()).toHaveLength(2);
    h.telegram.sendUserMessage({ userId: 42, text: "/stop" });
    await h.done("next");
  } finally { await h.close(); }
});

test("native Telegram Stop cancels an external live draft and revokes its context", async () => {
  const h = await harness();
  try {
    h.app.setOutput("live");
    h.app.emitExternal({ id: "draft", name: "WAIT", chatId: "42" });
    await h.prompted();
    const draft = await h.telegram.waitForRequest(r => r.method === "sendRichMessageDraft");
    h.telegram.push({ stopped_message_generation: { chat: { id: 42, type: "private" }, draft_id: String(draft.payload.draft_id) } } as unknown as Omit<Update, "update_id">);
    await h.done("draft");
    expect((await h.records()).some(x => x.event === "cancel")).toBe(true);
    expect(h.state.activeContext("100:42:0")).toBeUndefined();
    h.app.emitExternal({ id: "next", name: "next", chatId: "42" });
    await h.done("next");
    expect(h.app.eventJob("next")?.status).toBe("done");
  } finally { await h.close(); }
});

async function activeEvent() {
  const h = await harness();
  h.telegram.sendUserMessage({ userId: 42, text: "Archived message" });
  await h.delivered;
  const principals = h.state.db.query("SELECT count(*) AS count FROM telegram_principals").get();
  const messages = h.state.db.query("SELECT count(*) AS count FROM telegram_messages").get();
  h.app.emitExternal({ id: "context", name: "WAIT", chatId: "42" });
  await h.prompted(2);
  return { ...h, principals, messages };
}

test("external chat events read a fixed history snapshot without impersonating a sender", async () => {
  const h = await activeEvent(), client = await h.mcp();
  try {
    const current = h.state.activeContext("100:42:0")!;
    expect(current.message_id).toBeNull(); expect(current.message_ref).toBeNull(); expect(current.sender_ref).toBeNull();
    expect(h.state.db.query("SELECT count(*) AS count FROM telegram_principals").get()).toEqual(h.principals);
    expect(h.state.db.query("SELECT count(*) AS count FROM telegram_messages").get()).toEqual(h.messages);
    h.telegram.sendUserMessage({ userId: 42, text: "Newer queued message" });
    await h.telegram.waitForRequest(r => r.method === "getUpdates" && r.payload.offset >= 3);
    const result = await client.callTool({ name: "read_history", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain("Archived message");
    expect(JSON.stringify(result.content)).not.toContain("Newer queued message");
  } finally { await client.close(); await h.close(); }
});

test("external chat events send workspace files through Telegram MCP", async () => {
  const h = await activeEvent(), client = await h.mcp();
  try {
    await writeFile(join(h.dir, "result.txt"), "Event result");
    const result = await client.callTool({ name: "send_file", arguments: { path: "result.txt" } });
    expect(result.isError).not.toBe(true);
    expect(h.telegram.calls("sendDocument")).toHaveLength(1);
  } finally { await client.close(); await h.close(); }
});

test("external chat events require an explicit reference for message-relative tools", async () => {
  const h = await activeEvent(), client = await h.mcp();
  try {
    const result = await client.callTool({ name: "set_reaction", arguments: { emoji: "👍" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("message_ref");
    expect(h.telegram.calls("setMessageReaction")).toHaveLength(0);
  } finally { await client.close(); await h.close(); }
});

test("external event payloads do not replace owner approval for admin tools", async () => {
  const h = await harness({ group: true });
  h.telegram.chatMembers.set("-42", { status: "administrator", can_pin_messages: true,
    user: { id: 100, is_bot: true, first_name: "Bot" } });
  h.app.emitExternal({ id: "admin", name: "WAIT", chatId: "-42", payload: { approved: true, owner_id: "42" } });
  await h.prompted();
  const client = await h.mcp();
  try {
    const result = client.callTool({ name: "set_pinned_message", arguments: { text: "Event bulletin" } });
    await h.telegram.waitForRequest(r => r.method === "sendMessage" && !!r.payload.reply_markup?.inline_keyboard);
    const approval = await h.adminApproval();
    expect(h.telegram.calls("pinChatMessage")).toHaveLength(0);
    h.telegram.push({ callback_query: { id: "deny-admin", chat_instance: "test", data: `mcp:${approval.id}:deny`,
      from: { id: 42, is_bot: false, first_name: "Owner" },
      message: { message_id: approval.card!.messageId, date: 1, chat: { id: 42, type: "private" } },
    } } as Omit<Update, "update_id">);
    expect((await result).isError).toBe(true);
    expect(h.telegram.calls("pinChatMessage")).toHaveLength(0);
  } finally { await client.close(); await h.close(); }
});
