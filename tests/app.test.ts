import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InputRichMessageWithoutUpload, Message, Update } from "grammy/types";
import { TgfxApp } from "../src/app";
import type { StatusEvent } from "../src/status";
import { workspacePaths, type WorkspacePaths } from "../src/config";
import { StateStore } from "../src/state";
import type { TelegramApi } from "../src/telegram/api";
import type { TgfxConfig } from "../src/types";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Bot state lives under TGFX_HOME now; point it inside the test workspace. */
function testPaths(workspace: string, botId = "100"): WorkspacePaths {
  process.env.TGFX_HOME = join(workspace, "tgfx-home");
  return workspacePaths(botId, workspace);
}

async function fakeFx(directory: string, log?: string): Promise<string> {
  const binary = join(directory, "fx");
  const fixture = resolve("tests/fixtures/fake-fx.ts");
  await writeFile(binary, [
    "#!/bin/sh",
    ...(log ? [`export FAKE_FX_LOG=${JSON.stringify(log)}`] : []),
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} \"$@\"`,
    "",
  ].join("\n"));
  await chmod(binary, 0o700);
  return binary;
}

function update(updateId: number, userId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 10,
      date: Math.floor(Date.now() / 1_000),
      chat: { id: userId, type: "private", first_name: `User ${userId}` },
      from: { id: userId, is_bot: false, first_name: `User ${userId}` },
      text,
    },
  } as Update;
}

describe("tgfx host pipeline", () => {
  test("accepts only an allowed update and delivers its streamed FX result durably", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-"));
    temporary.push(workspace);
    const paths = testPaths(workspace);
    const fxBinary = await fakeFx(workspace);
    const config: TgfxConfig = {
      version: 1,
      activeBotId: "100",
      access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      streaming: true, expandStreamingTools: true, updateEveryMs: 10, customIcons: true,
    };
    const drafts: InputRichMessageWithoutUpload[] = [];
    const finals: InputRichMessageWithoutUpload[] = [];
    const commands: string[] = [];
    let firstPoll = true;
    let delivered!: () => void;
    const permanent = new Promise<void>((resolve) => { delivered = resolve; });
    const telegram = {
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
        if (firstPoll) {
          firstPoll = false;
          return [update(1, 99, "unauthorized"), update(2, 42, "hello")];
        }
        return new Promise<Update[]>((resolve) => {
          if (signal?.aborted) resolve([]);
          else signal?.addEventListener("abort", () => resolve([]), { once: true });
        });
      },
      setCommands: async (chatId: string) => { commands.push(`set:${chatId}`); return true as const; },
      deleteCommands: async (chatId: string) => { commands.push(`delete:${chatId}`); return true as const; },
      sendRichDraft: async (_chat: string, _draft: number, rich: InputRichMessageWithoutUpload) => {
        drafts.push(rich);
        return true as const;
      },
      sendRich: async (_chat: string, rich: InputRichMessageWithoutUpload) => {
        finals.push(rich);
        delivered();
        return { message_id: 500 } as Message.TextMessage;
      },
      sendText: async () => ({ message_id: 501 }) as Message.TextMessage,
    } as unknown as TelegramApi;

    const app = new TgfxApp({
      config, paths, token: "100:offline", bot: { id: "100", username: "test_bot", displayName: "Bot" },
      telegram, fxBinary, log: () => undefined,
    });
    const running = app.run();
    await Promise.race([permanent, Bun.sleep(5_000).then(() => { throw new Error("final delivery timed out"); })]);
    await app.stop();
    await running;

    expect(drafts.length).toBeGreaterThan(0);
    expect(finals).toEqual([{ blocks: [{ type: "paragraph", text: "fake streamed text" }] }]);
    expect(commands).toContain("set:42");
    expect(commands).toContain("delete:42");
    const state = new StateStore(paths.database);
    try {
      expect(state.nextOffset("100")).toBe(3);
      expect(state.db.query("SELECT count(*) AS count FROM telegram_inbox").get()).toEqual({ count: 1 });
      expect(state.db.query("SELECT status,payload_json FROM telegram_inbox").get()).toEqual({
        status: "done", payload_json: null,
      });
      expect(state.db.query("SELECT status,telegram_message_id FROM telegram_outbox").get()).toEqual({
        status: "sent", telegram_message_id: "500",
      });
      expect(state.messageReferenceByTelegramId("100", "42", "500")?.owned_by_bot).toBe(1);
      expect(state.activeContext("100:42:0")).toBeUndefined();
      expect(state.route("100:42:0")?.last_prompt_json).toBeNull();
    } finally { state.close(); }
  });

  test("uses the model-picker custom icon flag for MCP and FX tool rows", async () => {
    const run = async (customIcons: boolean) => {
      const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-mcp-icons-"));
      temporary.push(workspace);
      const paths = testPaths(workspace);
      const fxBinary = await fakeFx(workspace);
      const config: TgfxConfig = {
        version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
        approvals: { chatId: "42", topicId: "0" },
        streaming: false, expandStreamingTools: true, updateEveryMs: 10,
        customIcons,
      };
      let firstPoll = true;
      let packLookups = 0;
      let final: InputRichMessageWithoutUpload | undefined;
      let delivered!: () => void;
      const permanent = new Promise<void>((resolve) => { delivered = resolve; });
      const telegram = {
        getWebhookInfo: async () => ({ url: "" }),
        getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
          if (firstPoll) { firstPoll = false; return [update(1, 42, "MCP_TOOL FX_TOOL")]; }
          return new Promise<Update[]>((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
        },
        setCommands: async () => true as const,
        deleteCommands: async () => true as const,
        getStickerSet: async () => {
          packLookups++;
          return {
            name: "tgfx", title: "tgfx icons", sticker_type: "custom_emoji",
            stickers: Array.from({ length: 159 }, (_, index) => ({ custom_emoji_id: `emoji-${index}` })),
          };
        },
        sendRich: async (_chat: string, rich: InputRichMessageWithoutUpload) => {
          final = rich;
          delivered();
          return { message_id: 510 } as Message.TextMessage;
        },
        sendText: async () => ({ message_id: 511 }) as Message.TextMessage,
      } as unknown as TelegramApi;
      const app = new TgfxApp({
        config, paths, token: "100:offline", bot: { id: "100", username: "test_bot", displayName: "Bot" },
        telegram, fxBinary, log: () => undefined,
      });
      const running = app.run();
      await Promise.race([permanent, Bun.sleep(5_000).then(() => { throw new Error("MCP icon delivery timed out"); })]);
      await app.stop();
      await running;
      return { final, packLookups };
    };

    const enabled = await run(true);
    expect(enabled.packLookups).toBe(1);
    // Exact pack positions are covered by mcp-icons.test.ts; here only the
    // config flag wiring matters: icons from the looked-up pack reach the rows.
    expect(JSON.stringify(enabled.final)).toContain('"custom_emoji_id":"emoji-');

    const disabled = await run(false);
    expect(disabled.packLookups).toBe(0);
    expect(JSON.stringify(disabled.final)).not.toContain("custom_emoji");
  });

  test("downloads sticker images before teaching the agent their name and file ID", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-sticker-"));
    temporary.push(workspace);
    const paths = testPaths(workspace);
    const logPath = join(workspace, "fx-events.jsonl");
    const fxBinary = await fakeFx(workspace, logPath);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      streaming: true, expandStreamingTools: true, updateEveryMs: 10, customIcons: true,
    };
    const stickerUpdate = update(1, 42, "") as any;
    delete stickerUpdate.message.text;
    stickerUpdate.message.sticker = {
      file_id: "secret-file-id", file_unique_id: "stable-sticker-id",
      width: 512, height: 512, is_animated: false, is_video: false,
      set_name: "FriendlyFrogs", emoji: "🐸", file_size: 7,
    };
    let firstPoll = true;
    let delivered!: () => void;
    const permanent = new Promise<void>((resolve) => { delivered = resolve; });
    const telegram = {
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
        if (firstPoll) { firstPoll = false; return [stickerUpdate as Update]; }
        return new Promise<Update[]>((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
      },
      setCommands: async () => true as const,
      deleteCommands: async () => true as const,
      downloadFile: async (fileId: string) => {
        expect(fileId).toBe("secret-file-id");
        return { filePath: "stickers/frog.webp", response: new Response("webp!!!") };
      },
      sendRichDraft: async () => true as const,
      sendRich: async () => { delivered(); return { message_id: 700 } as Message.TextMessage; },
      sendText: async () => ({ message_id: 701 }) as Message.TextMessage,
    } as unknown as TelegramApi;
    const app = new TgfxApp({
      config, paths, token: "100:offline", bot: { id: "100", username: "test_bot", displayName: "Bot" },
      telegram, fxBinary, log: () => undefined,
    });
    const running = app.run();
    await Promise.race([permanent, Bun.sleep(5_000).then(() => { throw new Error("sticker turn timed out"); })]);
    const events = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const prompt = events.find((event) => event.event === "prompt").value.prompt;
    const envelope = JSON.parse(prompt[0].text).telegram_message;
    expect(envelope.attachments[0]).toMatchObject({
      kind: "sticker", state: "local",
      sticker: {
        file_id: "secret-file-id", name: "FriendlyFrogs", emoji: "🐸",
        image: { state: "local", mime: "image/webp" },
      },
    });
    const imagePath = envelope.attachments[0].sticker.image.path;
    expect(await realpath(imagePath)).toStartWith(await realpath(tmpdir()));
    expect(await realpath(imagePath)).not.toStartWith(await realpath(paths.workspace));
    expect(await readFile(imagePath, "utf8")).toBe("webp!!!");
    await app.stop();
    await running;
    await expect(readFile(imagePath)).rejects.toThrow();
  });

  test("injects the session bootstrap directive on the first turn of a new session only", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-bootstrap-"));
    temporary.push(workspace);
    const paths = testPaths(workspace);
    const logPath = join(workspace, "fx-events.jsonl");
    const fxBinary = await fakeFx(workspace, logPath);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      streaming: true, expandStreamingTools: true, updateEveryMs: 10, customIcons: true,
    };
    let poll = 0;
    let deliveries = 0;
    let delivered!: () => void;
    const permanent = new Promise<void>((resolve) => { delivered = resolve; });
    const telegram = {
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
        poll += 1;
        if (poll === 1) return [update(1, 42, "first message")];
        if (poll === 2) return [update(2, 42, "second message")];
        return new Promise<Update[]>((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
      },
      setCommands: async () => true as const,
      deleteCommands: async () => true as const,
      sendRichDraft: async () => true as const,
      sendRich: async () => {
        deliveries += 1;
        if (deliveries === 2) delivered();
        return { message_id: 700 + deliveries } as Message.TextMessage;
      },
      sendText: async () => ({ message_id: 799 }) as Message.TextMessage,
    } as unknown as TelegramApi;
    const app = new TgfxApp({
      config, paths, token: "100:offline", bot: { id: "100", username: "test_bot", displayName: "Bot" },
      telegram, fxBinary, log: () => undefined,
    });
    const running = app.run();
    await Promise.race([permanent, Bun.sleep(5_000).then(() => { throw new Error("bootstrap turns timed out"); })]);
    await app.stop();
    await running;
    const events = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const prompts = events.filter((event) => event.event === "prompt").map((event) => event.value.prompt);
    expect(prompts.length).toBe(2);
    const first = JSON.parse(prompts[0][0].text).telegram_message;
    const second = JSON.parse(prompts[1][0].text).telegram_message;
    expect(first.session_bootstrap).toContain("mcp_features");
    expect(first.session_bootstrap).toContain("telegram://guidelines");
    expect(second.session_bootstrap).toBeUndefined();
  });

  test("cancels the matching turn when Telegram reports draft generation stopped", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-cancel-"));
    temporary.push(workspace);
    const paths = testPaths(workspace);
    const fxBinary = await fakeFx(workspace);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      streaming: true, expandStreamingTools: true, updateEveryMs: 10, customIcons: true,
    };
    const texts: string[] = [];
    let phase = 0;
    let activeDraftId = 0;
    let draftReady!: () => void;
    const draft = new Promise<void>((resolve) => { draftReady = resolve; });
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    const telegram = {
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
        if (phase === 0) {
          phase = 1;
          return [update(1, 42, "WAIT")];
        }
        if (phase === 1) {
          phase = 2;
          await draft;
          return [{
            update_id: 2,
            stopped_message_generation: {
              chat: { id: 42, type: "private", first_name: "User 42" },
              // The Bot API serializes draft_id as a string, unlike the number we send.
              draft_id: String(activeDraftId),
            },
          } as unknown as Update];
        }
        return new Promise<Update[]>((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
      },
      setCommands: async () => true as const,
      deleteCommands: async () => true as const,
      sendText: async (_chat: string, text: string) => {
        texts.push(text);
        if (text === "𝒇x turn cancelled.") cancelled();
        return { message_id: 600 } as Message.TextMessage;
      },
      sendRichDraft: async (_chat: string, draftId: number) => {
        activeDraftId = draftId;
        draftReady();
        return true as const;
      },
      sendRich: async () => { throw new Error("cancelled turn must not produce a final"); },
    } as unknown as TelegramApi;
    const app = new TgfxApp({
      config, paths, token: "100:offline", bot: { id: "100", username: "test_bot", displayName: "Bot" },
      telegram, fxBinary, log: () => undefined,
    });
    const running = app.run();
    await Promise.race([cancellation, Bun.sleep(5_000).then(() => { throw new Error("cancellation timed out"); })]);
    await app.stop();
    await running;
    expect(texts).toContain("𝒇x turn cancelled.");
    expect(texts).not.toContain("Cancelling the active 𝒇x turn…");
    const state = new StateStore(paths.database);
    try {
      expect(state.db.query("SELECT count(*) AS count FROM telegram_outbox").get()).toEqual({ count: 0 });
      expect(state.nextOffset("100")).toBe(3);
      expect(state.db.query("SELECT count(*) AS count FROM telegram_inbox WHERE status='done'").get()).toEqual({ count: 1 });
      expect(state.activeContext("100:42:0")).toBeUndefined();
      expect(state.route("100:42:0")?.last_prompt_json).toBeNull();
    } finally { state.close(); }
  });

  test("opens /model while a stopped turn is still winding down", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-cancel-model-"));
    temporary.push(workspace);
    const paths = testPaths(workspace);
    const fxBinary = await fakeFx(workspace);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      streaming: true, expandStreamingTools: true, updateEveryMs: 10,
      customIcons: false,
    };
    const sequence: string[] = [];
    let phase = 0;
    let activeDraftId = 0;
    let draftReady!: () => void;
    const draft = new Promise<void>((resolve) => { draftReady = resolve; });
    let modelReady!: () => void;
    const model = new Promise<void>((resolve) => { modelReady = resolve; });
    let cancelled!: () => void;
    const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
    const telegram = {
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
        if (phase === 0) { phase = 1; return [update(1, 42, "WAIT")]; }
        if (phase === 1) {
          phase = 2;
          await draft;
          return [{
            update_id: 2,
            stopped_message_generation: {
              chat: { id: 42, type: "private", first_name: "User 42" },
              // The Bot API serializes draft_id as a string, unlike the number we send.
              draft_id: String(activeDraftId),
            },
          } as unknown as Update];
        }
        if (phase === 2) { phase = 3; sequence.push("model-update"); return [update(3, 42, "/model")]; }
        return new Promise<Update[]>((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
      },
      setCommands: async () => true as const,
      deleteCommands: async () => true as const,
      sendText: async (_chat: string, text: string) => {
        if (text === "𝒇x turn cancelled.") {
          await Bun.sleep(250);
          sequence.push("cancelled");
          cancelled();
        }
        if (text.startsWith("Choose model:")) { sequence.push("model"); modelReady(); }
        return { message_id: 610 } as Message.TextMessage;
      },
      sendRichDraft: async (_chat: string, draftId: number) => {
        activeDraftId = draftId;
        draftReady();
        return true as const;
      },
      sendRich: async () => { throw new Error("cancelled turn must not produce a final"); },
    } as unknown as TelegramApi;
    const app = new TgfxApp({
      config, paths, token: "100:offline", bot: { id: "100", username: "test_bot", displayName: "Bot" },
      telegram, fxBinary, log: () => undefined,
    });
    const running = app.run();
    await Promise.race([
      Promise.all([model, cancellation]),
      Bun.sleep(5_000).then(() => { throw new Error("stop/model sequence timed out"); }),
    ]);
    await app.stop();
    await running;
    expect(sequence).toEqual(["model-update", "model", "cancelled"]);
  });

  test("exposes /clear, /compact, and /model and uses a Thinking draft while streaming", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-commands-"));
    temporary.push(workspace);
    const paths = testPaths(workspace);
    const logPath = join(workspace, "fx-events.jsonl");
    const fxBinary = await fakeFx(workspace, logPath);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      streaming: true, expandStreamingTools: true, updateEveryMs: 10, customIcons: true,
    };
    const texts: string[] = [];
    const menus: Array<Array<{ command: string }>> = [];
    const drafts: InputRichMessageWithoutUpload[] = [];
    const finals: InputRichMessageWithoutUpload[] = [];
    let firstPoll = true;
    let delivered!: () => void;
    const permanent = new Promise<void>((resolve) => { delivered = resolve; });
    const telegram = {
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
        if (firstPoll) {
          firstPoll = false;
          return [
            update(1, 42, "/unknown"),
            update(2, 42, "/status"),
            update(3, 42, "/compact"),
            update(4, 42, "/clear"),
          ];
        }
        return new Promise<Update[]>((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
      },
      setCommands: async (_chat: string, menu: Array<{ command: string }>) => { menus.push(menu); return true as const; },
      deleteCommands: async () => true as const,
      sendText: async (_chat: string, text: string) => {
        texts.push(text);
        if (text === "✓ Started a fresh conversation") delivered();
        return { message_id: 700 } as Message.TextMessage;
      },
      sendRichDraft: async (_chat: string, _draftId: number, rich: InputRichMessageWithoutUpload) => {
        drafts.push(rich);
        return true as const;
      },
      sendRich: async (_chat: string, rich: InputRichMessageWithoutUpload) => {
        finals.push(rich);
        return { message_id: 701 } as Message.TextMessage;
      },
      editRich: async () => { throw new Error("streaming compact must not edit a regular message"); },
    } as unknown as TelegramApi;
    const app = new TgfxApp({
      config, paths, token: "100:offline", bot: { id: "100", username: "test_bot", displayName: "Bot" },
      telegram, fxBinary, log: () => undefined,
    });
    const running = app.run();
    await Promise.race([permanent, Bun.sleep(5_000).then(() => { throw new Error("command delivery timed out"); })]);
    await app.stop();
    await running;

    expect(texts).toContain("Unknown command /unknown.");
    expect(texts).toContain("Unknown command /status.");
    expect(texts).toContain("✓ Started a fresh conversation");
    const commands = menus.at(-1)?.map((entry) => entry.command) ?? [];
    expect(commands).toEqual(["clear", "compact", "model", "cost"]);
    expect(drafts).toEqual([{
      blocks: [{
        type: "thinking",
        text: [{
          type: "custom_emoji",
          custom_emoji_id: "5573473356579078196",
          alternative_text: "🙂",
        }, " Compacting conversation..."],
      }],
    }]);
    expect(finals).toEqual([{
      blocks: [{ type: "paragraph", text: "✓ Conversation compacted" }],
    }]);
    const events = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((entry) => entry.event === "prompt").map((entry) => entry.value.prompt)).toEqual([
      [{ type: "text", text: "/compact" }],
    ]);
    expect(events.filter((entry) => entry.event === "new")).toHaveLength(2);
    expect(events.filter((entry) => entry.event === "close")).toHaveLength(1);
  });

  test("switches the route model through the live /model button flow with custom icons disabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-model-picker-"));
    temporary.push(workspace);
    const paths = testPaths(workspace);
    const logPath = join(workspace, "fx-events.jsonl");
    const fxBinary = await fakeFx(workspace, logPath);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      streaming: true, expandStreamingTools: true, updateEveryMs: 10,
      customIcons: false,
    };
    let phase = 0;
    let packLookups = 0;
    let providerData = "";
    let selectionData = "";
    let pickerReady!: () => void;
    const picker = new Promise<void>((resolve) => { pickerReady = resolve; });
    let modelsReady!: () => void;
    const models = new Promise<void>((resolve) => { modelsReady = resolve; });
    let selected!: () => void;
    const selection = new Promise<void>((resolve) => { selected = resolve; });
    const edits: string[] = [];
    const callbackAnswers: string[] = [];
    const callback = (updateId: number, data: string): Update => ({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        chat_instance: "instance",
        data,
        from: { id: 42, is_bot: false, first_name: "Ada" },
        message: {
          message_id: 720,
          date: Math.floor(Date.now() / 1_000),
          chat: { id: 42, type: "private", first_name: "Ada" },
          text: "model picker",
        },
      },
    } as Update);
    const telegram = {
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
        if (phase === 0) {
          phase = 1;
          return [update(1, 42, "/model")];
        }
        if (phase === 1) {
          phase = 2;
          await picker;
          return [callback(2, providerData)];
        }
        if (phase === 2) {
          phase = 3;
          await models;
          return [callback(3, selectionData)];
        }
        return new Promise<Update[]>((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
      },
      setCommands: async () => true as const,
      deleteCommands: async () => true as const,
      getStickerSet: async () => {
        packLookups += 1;
        throw new Error("disabled custom icons must not load the pack");
      },
      sendText: async (_chat: string, text: string, _topic: string, options?: any) => {
        if (text.startsWith("Choose model:")) {
          expect(options.parse_mode).toBe("HTML");
          const providerButton = options.reply_markup.inline_keyboard.flat()
            .find((button: { text: string }) => button.text.startsWith("OpenAI ·"));
          expect(providerButton).not.toHaveProperty("icon_custom_emoji_id");
          providerData = providerButton.callback_data;
          pickerReady();
        }
        return { message_id: 720 } as Message.TextMessage;
      },
      answerCallback: async (id: string) => { callbackAnswers.push(id); return true as const; },
      editText: async (_chat: string, _message: number, text: string, options?: any) => {
        edits.push(text);
        if (text.startsWith("Choose model:")) {
          expect(options.parse_mode).toBe("HTML");
          const modelButton = options.reply_markup.inline_keyboard.flat()
            .find((button: { text: string }) => button.text === "gpt-5.6-luna");
          expect(modelButton).not.toHaveProperty("icon_custom_emoji_id");
          selectionData = modelButton.callback_data;
          modelsReady();
        } else if (text.startsWith("Model changed to")) selected();
        return true;
      },
    } as unknown as TelegramApi;
    const app = new TgfxApp({
      config, paths, token: "100:offline", bot: { id: "100", username: "test_bot", displayName: "Bot" },
      telegram, fxBinary, log: () => undefined,
    });
    const running = app.run();
    await Promise.race([selection, Bun.sleep(5_000).then(() => { throw new Error("model selection timed out"); })]);
    await app.stop();
    await running;

    expect(edits[0]).toBe("Choose model: <b>fake-default</b>");
    expect(edits[1]).toBe("Model changed to\n\n<b>openai/gpt-5.6-luna</b>");
    expect(packLookups).toBe(0);
    expect(callbackAnswers).toEqual(["callback-2", "callback-3"]);
    const events = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.find((entry) => entry.event === "set_config_option")?.value).toEqual({
      sessionId: "fake-new-session",
      configId: "model",
      value: "openai/gpt-5.6-luna",
    });
  });

  test("renders /cost and switches its reporting period with buttons", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-cost-"));
    temporary.push(workspace);
    const paths = testPaths(workspace);
    const logPath = join(workspace, "fx-events.jsonl");
    const fxBinary = await fakeFx(workspace, logPath);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      streaming: true, expandStreamingTools: true, updateEveryMs: 10, customIcons: true,
    };
    let phase = 0;
    let sevenDayCallback = "";
    let reportReady!: () => void;
    const reportSent = new Promise<void>((resolve) => { reportReady = resolve; });
    let editReady!: () => void;
    const reportEdited = new Promise<void>((resolve) => { editReady = resolve; });
    const sent: Array<{ rich: InputRichMessageWithoutUpload; options: any }> = [];
    const edited: Array<{ rich: InputRichMessageWithoutUpload; options: any }> = [];
    const callbackAnswers: string[] = [];
    const telegram = {
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
        if (phase === 0) {
          phase = 1;
          return [update(1, 42, "/cost")];
        }
        if (phase === 1) {
          phase = 2;
          await reportSent;
          return [{
            update_id: 2,
            callback_query: {
              id: "cost-callback", chat_instance: "instance", data: sevenDayCallback,
              from: { id: 42, is_bot: false, first_name: "Ada" },
              message: {
                message_id: 740, date: Math.floor(Date.now() / 1_000),
                chat: { id: 42, type: "private", first_name: "Ada" }, text: "Usage",
              },
            },
          } as Update];
        }
        return new Promise<Update[]>((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
      },
      setCommands: async () => true as const,
      deleteCommands: async () => true as const,
      sendRich: async (_chat: string, rich: InputRichMessageWithoutUpload, _topic: string, options: any) => {
        sent.push({ rich, options });
        sevenDayCallback = options.reply_markup.inline_keyboard.flat()
          .find((button: { text: string }) => button.text === "7 days").callback_data;
        reportReady();
        return { message_id: 740 } as Message.TextMessage;
      },
      answerCallback: async (id: string) => {
        callbackAnswers.push(id);
        return true as const;
      },
      editRich: async (_chat: string, _message: number, rich: InputRichMessageWithoutUpload, options: any) => {
        edited.push({ rich, options });
        editReady();
        return true;
      },
      sendText: async () => { throw new Error("cost report should not fall back to plain text"); },
    } as unknown as TelegramApi;
    const app = new TgfxApp({
      config, paths, token: "100:offline", bot: { id: "100", username: "test_bot", displayName: "Bot" },
      telegram, fxBinary, log: () => undefined,
    });
    const running = app.run();
    await Promise.race([reportEdited, Bun.sleep(5_000).then(() => { throw new Error("cost report timed out"); })]);
    await app.stop();
    await running;

    expect(sent[0]?.rich.blocks?.some((block) => block.type === "table")).toBeTrue();
    expect(sevenDayCallback).toBe("cost:7d");
    expect(edited[0]?.rich.blocks?.some((block) => block.type === "table")).toBeTrue();
    expect(edited[0]?.options.reply_markup.inline_keyboard.flat()).toContainEqual({
      text: "7 days", callback_data: "cost:n",
    });
    expect(callbackAnswers).toEqual(["cost-callback"]);
    const events = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((entry) => entry.event === "usage").map((entry) => entry.value.period)).toEqual(["24h", "7d"]);
  });

  test("edits one regular progress message for /compact when streaming is disabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-compact-final-"));
    temporary.push(workspace);
    const paths = testPaths(workspace);
    const fxBinary = await fakeFx(workspace);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      streaming: false, expandStreamingTools: true, updateEveryMs: 10, customIcons: true,
    };
    const sent: InputRichMessageWithoutUpload[] = [];
    const edits: Array<{ messageId: number; rich: InputRichMessageWithoutUpload }> = [];
    let firstPoll = true;
    let edited!: () => void;
    const completed = new Promise<void>((resolve) => { edited = resolve; });
    const telegram = {
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
        if (firstPoll) {
          firstPoll = false;
          return [update(1, 42, "/compact")];
        }
        return new Promise<Update[]>((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
      },
      setCommands: async () => true as const,
      deleteCommands: async () => true as const,
      sendText: async () => ({ message_id: 710 }) as Message.TextMessage,
      sendRichDraft: async () => { throw new Error("final mode must not send a draft"); },
      sendRich: async (_chat: string, rich: InputRichMessageWithoutUpload) => {
        sent.push(rich);
        return { message_id: 711 } as Message.TextMessage;
      },
      editRich: async (_chat: string, messageId: number, rich: InputRichMessageWithoutUpload) => {
        edits.push({ messageId, rich });
        edited();
        return true as const;
      },
    } as unknown as TelegramApi;
    const app = new TgfxApp({
      config, paths, token: "100:offline", bot: { id: "100", username: "test_bot", displayName: "Bot" },
      telegram, fxBinary, log: () => undefined,
    });
    const running = app.run();
    await Promise.race([completed, Bun.sleep(5_000).then(() => { throw new Error("compact edit timed out"); })]);
    await app.stop();
    await running;

    expect(sent).toEqual([{
      blocks: [{
        type: "paragraph",
        text: [{
          type: "custom_emoji",
          custom_emoji_id: "5573473356579078196",
          alternative_text: "🙂",
        }, " Compacting conversation..."],
      }],
    }]);
    expect(edits).toEqual([{
      messageId: 711,
      rich: { blocks: [{ type: "paragraph", text: "✓ Conversation compacted" }] },
    }]);
  });

  test("resolves an FX permission callback immediately when the control chat is the active route", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-permission-"));
    temporary.push(workspace);
    const paths = testPaths(workspace);
    const logPath = join(workspace, "fx-events.jsonl");
    const fxBinary = await fakeFx(workspace, logPath);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      streaming: true, expandStreamingTools: true, updateEveryMs: 10, customIcons: true,
    };
    let phase = 0;
    let approvalData!: string;
    let cardReady!: () => void;
    const card = new Promise<void>((resolve) => { cardReady = resolve; });
    let delivered!: () => void;
    const permanent = new Promise<void>((resolve) => { delivered = resolve; });
    const callbackAnswers: string[] = [];
    const markupEdits: unknown[] = [];
    const telegram = {
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
        if (phase === 0) {
          phase = 1;
          return [update(1, 42, "PERMISSION")];
        }
        if (phase === 1) {
          phase = 2;
          await card;
          return [{
            update_id: 2,
            callback_query: {
              id: "callback-1", chat_instance: "instance", data: approvalData,
              from: { id: 42, is_bot: false, first_name: "Ada" },
              message: {
                message_id: 800, date: Math.floor(Date.now() / 1_000),
                chat: { id: 42, type: "private", first_name: "Ada" }, text: "permission",
              },
            },
          }] as Update[];
        }
        return new Promise<Update[]>((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
      },
      setCommands: async () => true as const,
      deleteCommands: async () => true as const,
      sendText: async (_chat: string, _text: string, _topic: string, options?: any) => {
        const data = options?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
        if (typeof data === "string" && data.startsWith("fxp:")) {
          approvalData = data;
          cardReady();
          return { message_id: 800 } as Message.TextMessage;
        }
        return { message_id: 801 } as Message.TextMessage;
      },
      answerCallback: async (_id: string, text?: string) => { if (text) callbackAnswers.push(text); return true as const; },
      editReplyMarkup: async (_chat: string, _message: number, markup: unknown) => { markupEdits.push(markup); return true; },
      sendRichDraft: async () => true as const,
      sendRich: async () => { delivered(); return { message_id: 802 } as Message.TextMessage; },
    } as unknown as TelegramApi;
    const app = new TgfxApp({
      config, paths, token: "100:offline", bot: { id: "100", username: "test_bot", displayName: "Bot" },
      telegram, fxBinary, log: () => undefined,
    });
    const running = app.run();
    await Promise.race([permanent, Bun.sleep(5_000).then(() => { throw new Error("permission flow timed out"); })]);
    await app.stop();
    await running;

    expect(callbackAnswers).toContain("Allow once");
    expect(markupEdits).toContainEqual({
      inline_keyboard: [[{ text: "Resolved · Allow once", callback_data: "resolved" }]],
    });
    const events = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.find((entry) => entry.event === "permission_result")?.value.outcome.optionId).toBe("allow");
    const state = new StateStore(paths.database);
    try {
      expect(state.db.query("SELECT state,result_json FROM telegram_interactions WHERE kind='fx_permission'").get()).toEqual({
        state: "resolved", result_json: JSON.stringify("allow"),
      });
    } finally { state.close(); }
  });
});

describe("tgfx status feed", () => {
  test("reports a turn to the status view from arrival to delivery", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-status-"));
    temporary.push(workspace);
    const paths = testPaths(workspace);
    const fxBinary = await fakeFx(workspace);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      streaming: true, expandStreamingTools: true, updateEveryMs: 10, customIcons: false,
    };
    let firstPoll = true;
    let delivered!: () => void;
    const permanent = new Promise<void>((resolve) => { delivered = resolve; });
    const telegram = {
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
        if (firstPoll) { firstPoll = false; return [update(1, 42, "hello")]; }
        return new Promise<Update[]>((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
      },
      setCommands: async () => true as const,
      deleteCommands: async () => true as const,
      sendRichDraft: async () => true as const,
      sendRich: async () => { delivered(); return { message_id: 520 } as Message.TextMessage; },
      sendText: async () => ({ message_id: 521 }) as Message.TextMessage,
    } as unknown as TelegramApi;
    const events: StatusEvent[] = [];
    const app = new TgfxApp({
      config, paths, token: "100:offline", bot: { id: "100", username: "test_bot", displayName: "Bot" },
      telegram, fxBinary, log: () => undefined, status: (event) => events.push(event),
    });
    const running = app.run();
    await Promise.race([permanent, Bun.sleep(5_000).then(() => { throw new Error("final delivery timed out"); })]);
    await app.stop();
    await running;

    const kinds = events.map((event) =>
      event.type === "turn" || event.type === "session" ? `${event.type}.${event.state}`
        : event.type === "boot" ? `boot.${event.step}.${event.state}` : event.type);
    expect(kinds.slice(0, 3)).toEqual(["boot.menus.running", "boot.menus.done", "boot.polling.done"]);
    expect(kinds.indexOf("inbound")).toBeLessThan(kinds.indexOf("session.starting"));
    expect(kinds.indexOf("session.starting")).toBeLessThan(kinds.indexOf("session.ready"));
    expect(kinds.indexOf("turn.started")).toBeLessThan(kinds.indexOf("turn.event"));
    expect(kinds.at(-1)).toBe("turn.finished");
    const inbound = events.find((event) => event.type === "inbound");
    expect(inbound).toMatchObject({ who: "User 42", route: { key: "100:42:0", chat: "User 42", group: false } });
    const glyphs = events.flatMap((event) => event.type === "turn" && event.state === "event" ? [event.glyph] : []);
    expect(glyphs).toContain("·");
    const finished = events.at(-1);
    expect(finished).toMatchObject({ type: "turn", state: "finished", outcome: "delivered" });
    expect(typeof (finished as { seconds: number }).seconds).toBe("number");
  });

  test("pausing holds the poll loop until it is resumed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-pause-"));
    temporary.push(workspace);
    const paths = testPaths(workspace);
    const fxBinary = await fakeFx(workspace);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      streaming: true, expandStreamingTools: true, updateEveryMs: 10, customIcons: false,
    };
    let resumed = false;
    let pollsBeforeResume = 0;
    let polls = 0;
    let menusInstalled!: () => void;
    const menus = new Promise<void>((resolve) => { menusInstalled = resolve; });
    let firstPolled!: () => void;
    const first = new Promise<void>((resolve) => { firstPolled = resolve; });
    const telegram = {
      getWebhookInfo: async () => ({ url: "" }),
      getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
        polls++;
        if (!resumed) pollsBeforeResume++;
        firstPolled();
        return new Promise<Update[]>((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
      },
      setCommands: async () => { menusInstalled(); return true as const; },
      deleteCommands: async () => true as const,
      sendText: async () => ({ message_id: 530 }) as Message.TextMessage,
    } as unknown as TelegramApi;
    const events: StatusEvent[] = [];
    const app = new TgfxApp({
      config, paths, token: "100:offline", bot: { id: "100", username: "test_bot", displayName: "Bot" },
      telegram, fxBinary, log: () => undefined, status: (event) => events.push(event),
    });
    app.setPaused(true);
    expect(app.settings().paused).toBe(true);
    const running = app.run();
    // Installing menus is the last awaited step before the poll loop parks on
    // the gate; one macrotask flush lets it get there.
    await menus;
    await new Promise((resolve) => setImmediate(resolve));
    expect(polls).toBe(0);
    resumed = true;
    app.setPaused(false);
    await first;
    expect(pollsBeforeResume).toBe(0);
    expect(events.filter((event) => event.type === "settings").map((event) => (event as { settings: { paused: boolean } }).settings.paused)).toEqual([true, false]);
    await app.stop();
    await running;
  });
});
