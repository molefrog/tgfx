import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TgfxApp } from "../src/app";
import { loadConfig, saveConfig, workspacePaths, type WorkspacePaths } from "../src/config";
import { StateStore } from "../src/state";
import { TelegramApi } from "../src/telegram/api";
import type { BotIdentity, TgfxConfig } from "../src/types";
import { FakeTelegram } from "./fixtures/fake-telegram";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeFx(directory: string): Promise<string> {
  const binary = join(directory, "fx");
  const fixture = resolve("tests/fixtures/fake-fx.ts");
  await writeFile(binary, [
    "#!/bin/sh",
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"`,
    "",
  ].join("\n"));
  await chmod(binary, 0o700);
  return binary;
}

const BOT: BotIdentity = { id: "100", username: "fake_bot", displayName: "Fake Bot" };

async function makeWorkspace(config: Omit<TgfxConfig, "version" | "activeBotId" | "renderer">): Promise<{
  paths: WorkspacePaths; fxBinary: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "tgfx-e2e-"));
  temporary.push(workspace);
  const paths = workspacePaths(workspace);
  await saveConfig(paths, {
    version: 1,
    activeBotId: BOT.id,
    renderer: { mode: "streaming", collapseTools: true, updateEveryMs: 500 },
    ...config,
  });
  return { paths, fxBinary: await fakeFx(workspace) };
}

async function startApp(paths: WorkspacePaths, fxBinary: string, telegram: FakeTelegram): Promise<{
  app: TgfxApp; running: Promise<void>;
}> {
  const config = await loadConfig(paths);
  if (!config) throw new Error("test workspace config missing");
  const app = new TgfxApp({
    config,
    paths,
    token: "100:e2e-token",
    bot: BOT,
    telegram: new TelegramApi("100:e2e-token", telegram.url),
    fxBinary,
    log: () => undefined,
  });
  return { app, running: app.run() };
}

describe("tgfx over the local Telegram simulator", () => {
  test("delivers a full turn through the real Bot API transport", async () => {
    const telegram = new FakeTelegram();
    const { paths, fxBinary } = await makeWorkspace({
      access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
    });
    const { app, running } = await startApp(paths, fxBinary, telegram);
    try {
      telegram.sendUserMessage({ userId: 42, text: "hello over http", firstName: "Ada" });
      const finals = await telegram.waitForCalls("sendRichMessage");
      expect(String(finals[0]!.payload.chat_id)).toBe("42");
      expect(finals[0]!.payload.rich_message).toEqual({ markdown: "fake streamed text" });
    } finally {
      await app.stop();
      await running;
      await telegram.stop();
    }
    const state = new StateStore(paths.database);
    try {
      expect(state.db.query("SELECT status FROM telegram_inbox").all()).toEqual([{ status: "done" }]);
      expect(state.db.query("SELECT status FROM telegram_outbox").all()).toEqual([{ status: "sent" }]);
      // The directory cache learned the sender's private chat for the access map.
      expect(state.chatInfo("100", "42")?.title).toBe("Ada");
    } finally { state.close(); }
  }, 15_000);

  test("applies an allowlist edit to the running process without a restart", async () => {
    const telegram = new FakeTelegram();
    const { paths, fxBinary } = await makeWorkspace({
      access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
    });
    const { app, running } = await startApp(paths, fxBinary, telegram);
    try {
      const rejectedUpdate = telegram.sendUserMessage({ userId: 99, text: "not allowed yet" });
      await telegram.waitForCalls("getUpdates", 2);
      // tgfx allow 99, from another process: an atomic config.json rewrite.
      const config = await loadConfig(paths);
      config!.access.userIds.push("99");
      await saveConfig(paths, config!);
      await Bun.sleep(1_500);
      telegram.sendUserMessage({ userId: 99, text: "hello after allow" });
      const finals = await telegram.waitForCalls("sendRichMessage");
      expect(String(finals[0]!.payload.chat_id)).toBe("99");
      const state = new StateStore(paths.database);
      try {
        // The pre-reload message was discarded without retaining content.
        const updates = state.db.query<{ update_id: number }, []>(
          "SELECT update_id FROM telegram_inbox",
        ).all().map((row) => row.update_id);
        expect(updates).not.toContain(rejectedUpdate);
        expect(state.nextOffset("100")).toBeGreaterThan(rejectedUpdate);
        // The reload republished the live access snapshot MCP sessions consult.
        expect(state.liveAccess()?.protectedUsers).toEqual(["100", "42", "99"]);
      } finally { state.close(); }
    } finally {
      await app.stop();
      await running;
      await telegram.stop();
    }
  }, 15_000);

  test("tracks admin standing live from my_chat_member updates", async () => {
    const telegram = new FakeTelegram();
    const { paths, fxBinary } = await makeWorkspace({
      access: { userIds: ["42"], chatIds: ["-9"] },
      approvals: { chatId: "42", topicId: "0" },
    });
    const { app, running } = await startApp(paths, fxBinary, telegram);
    try {
      telegram.push({
        my_chat_member: {
          chat: { id: -9, type: "supergroup", title: "Team" },
          from: { id: 42, is_bot: false, first_name: "Ada" },
          date: Math.floor(Date.now() / 1_000),
          old_chat_member: {
            status: "member",
            user: { id: 100, is_bot: true, first_name: "Fake Bot" },
          },
          new_chat_member: {
            status: "administrator",
            user: { id: 100, is_bot: true, first_name: "Fake Bot" },
            can_be_edited: false,
            is_anonymous: false,
            can_manage_chat: true,
            can_change_info: false,
            can_promote_members: false,
            can_manage_video_chats: false,
            can_post_stories: false,
            can_edit_stories: false,
            can_delete_stories: false,
            can_pin_messages: true,
            can_manage_topics: false,
            can_delete_messages: true,
            can_restrict_members: false,
            can_invite_users: false,
          },
        },
      } as never);
      const deadline = Date.now() + 5_000;
      let rights: string[] = [];
      while (Date.now() < deadline) {
        const state = new StateStore(paths.database);
        try { rights = state.chatAdminRights("100", "-9"); } finally { state.close(); }
        if (rights.length) break;
        await Bun.sleep(50);
      }
      expect(rights.sort()).toEqual(["delete_messages", "pins"]);
      const state = new StateStore(paths.database);
      try {
        expect(state.chatInfo("100", "-9")?.title).toBe("Team");
        expect(state.chatInfo("100", "-9")?.admin_status).toBe("administrator");
      } finally { state.close(); }
    } finally {
      await app.stop();
      await running;
      await telegram.stop();
    }
  }, 15_000);
});
