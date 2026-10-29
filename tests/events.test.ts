import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TgfxApp } from "../src/app";
import { eventPrompt, EventJournal } from "../src/events";
import { discoverEventsSocket, eventRequest, listenEvents } from "../src/event-socket";
import { saveConfig, workspacePaths } from "../src/config";
import type { TelegramApi } from "../src/telegram/api";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const d = await mkdtemp(join(tmpdir(), "tgfx-events-")); dirs.push(d); return d; }

test("event IDs deduplicate canonical payloads and reject changed content", () => {
  const db = new Database(":memory:");
  try {
    const journal = new EventJournal(db, "/workspace", "1");
    expect(journal.accept({ id: "mail:1", name: "email.received", payload: { b: 2, a: 1 } }).fresh).toBe(true);
    expect(journal.accept({ id: "mail:1", name: "email.received", payload: { a: 1, b: 2 } }).fresh).toBe(false);
    expect(() => journal.accept({ id: "mail:1", name: "different" })).toThrow("different content");
    journal.mark("mail:1", "running");
    journal.accept({ id: "mail:2", name: "email.received" });
    expect(journal.recover().map(e => e.id)).toEqual(["mail:2"]);
    expect(journal.get("mail:1")?.status).toBe("interrupted");
  } finally { db.close(); }
});

test("external envelope has no fabricated Telegram sender or message", () => {
  const envelope = JSON.parse((eventPrompt({ id: "1", name: "email.received", payload: { message_id: "m1" }, steer: false })[0] as { text: string }).text);
  expect(envelope.telegram_message).toBeUndefined();
  expect(envelope.external_event.source).toBe("tgfx:emit");
  expect(envelope.external_event.scope).toEqual({ kind: "background" });
  expect(envelope.external_event.sender).toBeUndefined();
  expect(envelope.external_event.message).toBeUndefined();
});

test("private event socket handles requests and removes itself on close", async () => {
  const d = await directory();
  const socket = join(d, "events.sock");
  const server = await listenEvents(socket, async value => ({ received: value }));
  try { expect(await eventRequest(socket, { test: 1 })).toEqual({ received: { test: 1 } }); }
  finally { await server.close(); }
  expect(await Bun.file(socket).exists()).toBe(false);
});

async function fixture() {
  const d = await directory();
  process.env.TGFX_HOME = join(d, "home");
  const path = workspacePaths("100", d);
  const log = join(d, "fx.jsonl");
  const binary = join(d, "fx");
  await writeFile(log, "");
  await writeFile(binary, `#!/bin/sh\nexport FAKE_FX_LOG=${JSON.stringify(log)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("tests/fixtures/fake-fx.ts"))} "$@"\n`);
  await chmod(binary, 0o700);
  const delivered: unknown[] = [];
  const waiters = new Map<string, () => void>();
  const app = new TgfxApp({
    config: { version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" }, output: "answer", customIcons: false },
    paths: path, token: "100:fake", bot: { id: "100", displayName: "Bot" }, fxBinary: binary,
    telegram: {
      getWebhookInfo: async () => ({ url: "" }), setCommands: async () => true, deleteCommands: async () => true,
      getUpdates: async (_o: number, _t: number, signal: AbortSignal) => new Promise(resolve => {
        if (signal.aborted) resolve([]); else signal.addEventListener("abort", () => resolve([]), { once: true });
      }),
      sendTyping: async () => true,
      sendRich: async (_chat: string, value: unknown) => { delivered.push(value); return { message_id: 1 }; },
    } as unknown as TelegramApi,
    log: event => { if (event.event === "external.done" || event.event === "external.failed") waiters.get(String(event.id))?.(); },
  });
  return { app, log, delivered, directory: d, done(id: string) {
    return new Promise<void>(resolve => { waiters.set(id, resolve); if (["done", "failed"].includes(app.eventJob(id)?.status ?? "")) resolve(); });
  } };
}

test("background events persist results without Telegram delivery or MCP credentials", async () => {
  const f = await fixture();
  const running = f.app.run();
  try {
    f.app.emitExternal({ id: "background", name: "email.received", payload: { message_id: "one" } });
    await f.done("background");
    expect(f.app.eventJob("background")).toMatchObject({ status: "done", result: "fake streamed text" });
    expect(f.delivered).toEqual([]);
    const records = (await readFile(f.log, "utf8")).trim().split("\n").map(x => JSON.parse(x));
    const session = records.find(x => x.event === "new");
    expect(session.value.mcpServers).toEqual([]);
  } finally { await f.app.stop(); await running; }
});

test("chat and background sessions independently receive shared memory updates", async () => {
  const f = await fixture();
  const path = join(f.directory, "MEMORY.md");
  await writeFile(path, "# First\nShared fact.\n");
  const running = f.app.run();
  try {
    for (const [id, chatId] of [["dm-first", "42"], ["bg-first", undefined]] as const) {
      f.app.emitExternal({ id, name: "test", ...(chatId ? { chatId } : {}) });
      await f.done(id);
    }
    await writeFile(path, "# First\nShared fact.\n\n# Second\nNew fact.\n");
    for (const [id, chatId] of [["dm-next", "42"], ["bg-next", undefined]] as const) {
      f.app.emitExternal({ id, name: "test", ...(chatId ? { chatId } : {}) });
      await f.done(id);
    }
    const prompts = (await readFile(f.log, "utf8")).trim().split("\n").map(x => JSON.parse(x))
      .filter(x => x.event === "prompt").map(x => x.value.prompt[0].text);
    expect(prompts.slice(0, 2).every(text => text.includes('<memory source="MEMORY.md">'))).toBe(true);
    expect(prompts.slice(2).every(text => text.includes('action="append"') && !text.includes("Shared fact"))).toBe(true);
  } finally { await f.app.stop(); await running; }
});

test("chat event responds in the authorized destination and rejects arbitrary chats", async () => {
  const f = await fixture();
  const running = f.app.run();
  try {
    expect(() => f.app.emitExternal({ name: "test", chatId: "999" })).toThrow("allowed chat");
    f.app.emitExternal({ id: "chat", name: "test", chatId: "42" });
    await f.done("chat");
    expect(f.app.eventJob("chat")?.status).toBe("done");
    expect(f.delivered.length).toBe(1);
  } finally { await f.app.stop(); await running; }
});

test("steering joins an active event while ordinary events remain queued", async () => {
  const f = await fixture();
  const running = f.app.run();
  const prompted = new Promise<void>(resolveReady => {
    const watcher = watch(f.log, async () => {
      if ((await readFile(f.log, "utf8")).includes('"event":"prompt"')) { watcher.close(); resolveReady(); }
    });
  });
  try {
    f.app.emitExternal({ id: "first", name: "WAIT" });
    await prompted;
    f.app.emitExternal({ id: "second", name: "queued" });
    expect(f.app.eventJob("second")?.status).toBe("queued");
    f.app.emitExternal({ id: "steer", name: "steering", steer: true });
    await f.done("first"); await f.done("second");
    expect(f.app.eventJob("steer")?.status).toBe("done");
    const records = (await readFile(f.log, "utf8")).trim().split("\n").map(x => JSON.parse(x));
    expect(records.find(x => x.event === "steer")).toBeDefined();
  } finally { await f.app.stop(); await running; }
});


test("emit discovers the configured workspace and rejects another runtime workspace", async () => {
  const d = await directory();
  const original = process.env.TGFX_HOME;
  const socketOverride = process.env.TGFX_EVENTS_SOCKET;
  process.env.TGFX_HOME = join(d, "home");
  delete process.env.TGFX_EVENTS_SOCKET;
  try {
    const paths = workspacePaths("100", d);
    await saveConfig(paths, { version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" }, output: "answer", customIcons: false });
    await mkdir(join(paths.lockInfo, ".."), { recursive: true });
    await writeFile(paths.lockInfo, JSON.stringify({ workspace: d }));
    expect(await discoverEventsSocket(d)).toBe(paths.database.replace(/\.db$/, ".events.sock"));
    await writeFile(paths.lockInfo, JSON.stringify({ workspace: join(d, "other") }));
    await expect(discoverEventsSocket(d)).rejects.toThrow("different workspace");
  } finally {
    if (original === undefined) delete process.env.TGFX_HOME; else process.env.TGFX_HOME = original;
    if (socketOverride === undefined) delete process.env.TGFX_EVENTS_SOCKET; else process.env.TGFX_EVENTS_SOCKET = socketOverride;
  }
});

test("emit CLI submits structured payloads over the socket", async () => {
  const d = await directory();
  const socket = join(d, "events.sock");
  let received: unknown;
  const server = await listenEvents(socket, async request => {
    received = request;
    return { id: "cli-test", status: "queued", destination: "100:background" };
  });
  try {
    const child = Bun.spawn([process.execPath, resolve("src/index.ts"), "emit", "email.received",
      "--id", "cli-test", "--payload", '{"message_id":"one"}'], {
      env: { ...process.env, TGFX_EVENTS_SOCKET: socket }, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output).status).toBe("queued");
    expect(received).toEqual({ op: "emit", event: { name: "email.received", id: "cli-test",
      payload: { message_id: "one" }, steer: false } });
  } finally { await server.close(); }
});

test("emit --wait exits with failure when a queued event is cancelled", async () => {
  const socket = join(await directory(), "events.sock");
  const server = await listenEvents(socket, async request => ({ id: "cancelled", destination: "100:42:0",
    status: (request as { op: string }).op === "emit" ? "queued" : "cancelled" }));
  try {
    const child = Bun.spawn([process.execPath, resolve("src/index.ts"), "emit", "test", "--wait"], {
      env: { ...process.env, TGFX_EVENTS_SOCKET: socket }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(1);
    expect(JSON.parse(output).status).toBe("cancelled");
  } finally { await server.close(); }
});
