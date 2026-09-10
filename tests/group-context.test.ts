import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Update } from "grammy/types";
import { TgfxApp } from "../src/app";
import { loadConfig, saveConfig, workspacePaths } from "../src/config";
import { StateStore } from "../src/state";
import { TelegramApi } from "../src/telegram/api";
import { withTimeout } from "../src/timeout";
import { FakeTelegram } from "./fixtures/fake-telegram";
import type { TgfxConfig } from "../src/types";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(overrides: Partial<TgfxConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "tgfx-group-context-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  process.env.TGFX_HOME = join(root, "home");
  const paths = workspacePaths("100", root);
  const log = join(root, "fx.jsonl");
  const binary = join(root, "fx");
  await Bun.write(binary, `#!${process.execPath}\nprocess.env.FAKE_FX_LOG=${JSON.stringify(log)};\nawait import(${JSON.stringify(resolve("tests/fixtures/fake-fx.ts"))});\n`);
  await chmod(binary, 0o700);
  const config: TgfxConfig = { version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: ["-9"] },
    approvals: { chatId: "42", topicId: "0" }, output: "answer", customIcons: false, ...overrides };
  await saveConfig(paths, config, overrides);
  const telegram = new FakeTelegram();
  const api = new TelegramApi("100:fake", telegram.url);
  const events: string[] = [];
  const listeners = new Set<() => void>();
  const app = new TgfxApp({ config, paths, bot: { id: "100", username: "fake_bot", displayName: "Bot" },
    token: "100:fake", fxBinary: binary, telegram: api,
    log: (event) => { events.push(event.event); for (const notify of listeners) notify(); },
  });
  const running = app.run();
  cleanup.push(async () => { await app.stop(); await running; await telegram.stop(); });
  await telegram.waitForCalls("getUpdates");
  let messageId = 0;
  return {
    app, paths, telegram, api,
    send(text: string, extra: Record<string, unknown> = {}, editedId?: number) {
      const id = editedId ?? ++messageId;
      const message = { message_id: id, date: id,
        chat: { id: -9, type: "supergroup", title: "Team" },
        from: { id: 43, is_bot: false, first_name: "Grace" }, text,
        ...(text.startsWith("@fake_bot") ? { entities: [{ type: "mention", offset: 0, length: 9 }] } : {}), ...extra };
      const updateId = telegram.push({ [editedId ? "edited_message" : "message"]: message } as Omit<Update, "update_id">);
      return { id, acknowledged: () => telegram.waitForRequest((r) => r.method === "getUpdates" && r.payload.offset > updateId) };
    },
    wait(event: string, count = 1) {
      const done = Promise.withResolvers<void>();
      const check = () => { if (events.filter((e) => e === event).length >= count) done.resolve(); };
      listeners.add(check); check();
      return withTimeout(done.promise, 5_000, () => { throw new Error(`Missing ${event}`); })
        .finally(() => listeners.delete(check));
    },
    async prompts(): Promise<Array<Array<{ type: string; text: string }>>> {
      if (!await Bun.file(log).exists()) return [];
      return (await Bun.file(log).text()).trim().split("\n").map((l) => JSON.parse(l))
        .filter((e) => e.event === "prompt").map((e) => e.value.prompt);
    },
  };
}

function context(prompt: Array<{ text: string }>) {
  return prompt.map((b) => { try { return JSON.parse(b.text).telegram_context; } catch { return undefined; } }).find(Boolean);
}

function holdRequest(api: TelegramApi, method: string) {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  api.api.config.use(async (next, name, payload, signal) => {
    if (name === method) { entered.resolve(); await released.promise; }
    return next(name, payload, signal);
  });
  return {
    entered: () => withTimeout(entered.promise, 5_000, () => { throw new Error(`Missing ${method}`); }),
    release: () => released.resolve(),
  };
}

async function drainQueue(h: Awaited<ReturnType<typeof setup>>) {
  h.send("/queue_drained@fake_bot");
  await h.telegram.waitForRequest((r) => r.method === "sendMessage" && r.payload.text.includes("Unknown command /queue_drained"));
}

test("a group discussion stays quiet and becomes context for the mention", async () => {
  const h = await setup();
  const ordinary = h.send("ship Friday"); await ordinary.acknowledged();
  expect(await h.prompts()).toHaveLength(0);
  h.send("@fake_bot save our decision"); await h.wait("turn.delivered");
  const prompts = await h.prompts();
  expect(prompts).toHaveLength(1);
  expect(context(prompts[0]!).messages[0].text).toBe("ship Friday");
});

test("live policy changes affect future messages and persist", async () => {
  const h = await setup();
  await h.send("background").acknowledged();
  h.app.setReplyPolicy("-9", "all");
  h.send("please help"); await h.wait("turn.delivered");
  expect(await h.prompts()).toHaveLength(1);
  await h.app.stop();
  expect((await loadConfig(h.paths))?.chatReplies?.["-9"]).toBe("all");
});

test("unauthorized speech never reaches the archive or prompt", async () => {
  const h = await setup({ access: { userIds: ["42"], chatIds: [] } });
  await h.send("private stranger content").acknowledged();
  h.send("@fake_bot help", { from: { id: 42, is_bot: false, first_name: "Ada" } });
  await h.wait("turn.delivered");
  expect(context((await h.prompts())[0]!)).toBeUndefined();
  const state = new StateStore(h.paths.database, h.paths.workspace);
  try { expect(JSON.stringify(state.history.read("100:-9:0", state.history.latestSeq("100:-9:0")))).not.toContain("stranger content"); }
  finally { state.close(); }
});

test("an edit can add the first mention without repeating an already processed request", async () => {
  const h = await setup();
  const first = h.send("background"); await first.acknowledged();
  h.send("@fake_bot help", {}, first.id); await h.wait("turn.delivered");
  await h.send("@fake_bot corrected", {}, first.id).acknowledged();
  h.send("@fake_bot another task"); await h.wait("turn.delivered", 2);
  expect(await h.prompts()).toHaveLength(2);
});

test.each([
  { text: "@fake_bot original", method: "getChatMember" },
  { text: "/compact@fake_bot", method: "sendRichMessage" },
])("editing $text during preparation does not run it twice", async ({ text, method }) => {
  const h = await setup();
  const held = holdRequest(h.api, method);
  try {
    const first = h.send(text);
    await held.entered();
    await h.send("@fake_bot corrected", {}, first.id).acknowledged();
  } finally { held.release(); }
  await drainQueue(h);
  expect(await h.prompts()).toHaveLength(1);
});

test("an edit replaces a request still queued behind preparation", async () => {
  const h = await setup();
  const held = holdRequest(h.api, "getChatMember");
  try {
    h.send("@fake_bot first");
    await held.entered();
    const queued = h.send("@fake_bot original");
    await queued.acknowledged();
    await h.send("@fake_bot corrected", {}, queued.id).acknowledged();
  } finally { held.release(); }
  await drainQueue(h);
  const prompts = await h.prompts();
  expect(prompts).toHaveLength(2);
  expect(prompts[1]!.some((block) => block.text.includes("@fake_bot corrected"))).toBeTrue();
});
