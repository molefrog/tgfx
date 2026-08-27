import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InputRichMessageWithoutUpload, Message, Update } from "grammy/types";
import { TgfxApp } from "../src/app";
import { workspacePaths } from "../src/config";
import { StateStore } from "../src/state";
import type { TelegramApi } from "../src/telegram/api";
import type { TgfxConfig } from "../src/types";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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
    const paths = workspacePaths(workspace);
    const fxBinary = await fakeFx(workspace);
    const config: TgfxConfig = {
      version: 1,
      activeBotId: "100",
      access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      renderer: { mode: "streaming", collapseTools: true, expandStreamingTools: true, updateEveryMs: 10 },
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

  test("cancels the matching turn when Telegram reports draft generation stopped", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-cancel-"));
    temporary.push(workspace);
    const paths = workspacePaths(workspace);
    const fxBinary = await fakeFx(workspace);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      renderer: { mode: "streaming", collapseTools: true, expandStreamingTools: true, updateEveryMs: 10 },
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
              draft_id: activeDraftId,
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

  test("exposes /compact and /model and uses a Thinking draft while streaming", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-commands-"));
    temporary.push(workspace);
    const paths = workspacePaths(workspace);
    const logPath = join(workspace, "fx-events.jsonl");
    const fxBinary = await fakeFx(workspace, logPath);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      renderer: { mode: "streaming", collapseTools: true, expandStreamingTools: true, updateEveryMs: 10 },
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
          ];
        }
        return new Promise<Update[]>((resolve) => signal?.addEventListener("abort", () => resolve([]), { once: true }));
      },
      setCommands: async (_chat: string, menu: Array<{ command: string }>) => { menus.push(menu); return true as const; },
      deleteCommands: async () => true as const,
      sendText: async (_chat: string, text: string) => { texts.push(text); return { message_id: 700 } as Message.TextMessage; },
      sendRichDraft: async (_chat: string, _draftId: number, rich: InputRichMessageWithoutUpload) => {
        drafts.push(rich);
        return true as const;
      },
      sendRich: async (_chat: string, rich: InputRichMessageWithoutUpload) => {
        finals.push(rich);
        delivered();
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
    const commands = menus.at(-1)?.map((entry) => entry.command) ?? [];
    expect(commands).toEqual(["compact", "model"]);
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
  });

  test("switches the route model through the live /model button flow", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-model-picker-"));
    temporary.push(workspace);
    const paths = workspacePaths(workspace);
    const logPath = join(workspace, "fx-events.jsonl");
    const fxBinary = await fakeFx(workspace, logPath);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      renderer: { mode: "streaming", collapseTools: true, expandStreamingTools: true, updateEveryMs: 10 },
    };
    let phase = 0;
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
      sendText: async (_chat: string, text: string, _topic: string, options?: any) => {
        if (text.startsWith("Choose a model")) {
          providerData = options.reply_markup.inline_keyboard.flat()
            .find((button: { text: string }) => button.text.startsWith("OpenAI ·"))
            .callback_data;
          pickerReady();
        }
        return { message_id: 720 } as Message.TextMessage;
      },
      answerCallback: async (id: string) => { callbackAnswers.push(id); return true as const; },
      editText: async (_chat: string, _message: number, text: string, options?: any) => {
        edits.push(text);
        if (text.startsWith("Choose a model · OpenAI")) {
          selectionData = options.reply_markup.inline_keyboard.flat()
            .find((button: { text: string }) => button.text === "gpt-5.6-luna")
            .callback_data;
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

    expect(edits[0]).toContain("Choose a model · OpenAI");
    expect(edits[1]).toBe("Model changed to\n\nopenai/gpt-5.6-luna");
    expect(callbackAnswers).toEqual(["callback-2", "callback-3"]);
    const events = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.find((entry) => entry.event === "set_config_option")?.value).toEqual({
      sessionId: "fake-new-session",
      configId: "model",
      value: "openai/gpt-5.6-luna",
    });
  });

  test("edits one regular progress message for /compact when streaming is disabled", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-app-compact-final-"));
    temporary.push(workspace);
    const paths = workspacePaths(workspace);
    const fxBinary = await fakeFx(workspace);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      renderer: { mode: "final", collapseTools: true, expandStreamingTools: true, updateEveryMs: 10 },
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
    const paths = workspacePaths(workspace);
    const logPath = join(workspace, "fx-events.jsonl");
    const fxBinary = await fakeFx(workspace, logPath);
    const config: TgfxConfig = {
      version: 1, activeBotId: "100", access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      renderer: { mode: "streaming", collapseTools: true, expandStreamingTools: true, updateEveryMs: 10 },
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
