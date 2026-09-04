import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TgfxApp } from "../src/app";
import { loadConfig, saveConfig, saveGlobalConfig, workspacePaths, type WorkspacePaths } from "../src/config";
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

async function makeWorkspace(
  config: Partial<TgfxConfig> & Pick<TgfxConfig, "access" | "approvals">,
): Promise<{
  paths: WorkspacePaths; fxBinary: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "tgfx-e2e-"));
  temporary.push(workspace);
  process.env.TGFX_HOME = join(workspace, "tgfx-home");
  const paths = workspacePaths(BOT.id, workspace);
  const { output = "live", customIcons = true, ...project } = config;
  await saveGlobalConfig({ version: 1, defaults: { output, customIcons } });
  await saveConfig(paths, { version: 1, activeBotId: BOT.id, output, customIcons, ...project });
  return { paths, fxBinary: await fakeFx(workspace) };
}

async function startApp(paths: WorkspacePaths, fxBinary: string, telegram: FakeTelegram): Promise<{
  app: TgfxApp; running: Promise<void>;
  /** Resolves once the app has finished a turn, so stopping cannot interrupt it. */
  delivered: Promise<void>;
}> {
  const config = await loadConfig(paths);
  if (!config) throw new Error("test workspace config missing");
  const delivered = Promise.withResolvers<void>();
  const app = new TgfxApp({
    config,
    paths,
    token: "100:e2e-token",
    bot: BOT,
    telegram: new TelegramApi("100:e2e-token", telegram.url),
    fxBinary,
    log: (event) => { if (event.event === "turn.delivered") delivered.resolve(); },
  });
  return { app, running: app.run(), delivered: delivered.promise };
}

describe("tgfx over the local Telegram simulator", () => {
  test("delivers a full turn through the real Bot API transport", async () => {
    const telegram = new FakeTelegram();
    const { paths, fxBinary } = await makeWorkspace({
      access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
    });
    const { app, running, delivered } = await startApp(paths, fxBinary, telegram);
    try {
      telegram.sendUserMessage({ userId: 42, text: "hello over http", firstName: "Ada" });
      const finals = await telegram.waitForCalls("sendRichMessage");
      const drafts = await telegram.waitForCalls("sendRichMessageDraft");
      await delivered;
      expect(String(finals[0]!.payload.chat_id)).toBe("42");
      expect(finals[0]!.payload.rich_message).toEqual({
        blocks: [{ type: "paragraph", text: "fake streamed text" }],
      });
      expect(drafts[0]!.payload.can_stop).toBe(true);
      const polls = telegram.calls("getUpdates");
      expect(polls.some((call) => call.payload.allowed_updates?.includes("stopped_message_generation"))).toBe(true);
    } finally {
      await app.stop();
      await running;
      await telegram.stop();
    }
    const state = new StateStore(paths.database);
    try {
      expect(state.db.query("SELECT status FROM telegram_inbox").all()).toEqual([{ status: "done" }]);
      expect(state.db.query("SELECT status FROM telegram_outbox").all()).toEqual([{ status: "sent" }]);
    } finally { state.close(); }
  }, 15_000);

  test("edits the /compact progress message in report mode", async () => {
    const telegram = new FakeTelegram();
    const { paths, fxBinary } = await makeWorkspace({
      access: { userIds: ["42"], chatIds: [] },
      approvals: { chatId: "42", topicId: "0" },
      output: "report",
    });
    const { app, running } = await startApp(paths, fxBinary, telegram);
    try {
      telegram.sendUserMessage({ userId: 42, text: "/compact", firstName: "Ada" });
      const edits = await telegram.waitForCalls("editMessageText");
      const progress = telegram.calls("sendRichMessage");
      expect(progress).toHaveLength(1);
      expect(progress[0]!.payload.rich_message.blocks[0].type).toBe("paragraph");
      expect(edits[0]!.payload.rich_message).toEqual({
        blocks: [{ type: "paragraph", text: "✓ Conversation compacted" }],
      });
      expect(telegram.calls("sendRichMessageDraft")).toHaveLength(0);
      expect(telegram.calls("setMyCommands").at(-1)?.payload.commands.some(
        (command: { command: string }) => command.command === "stop",
      )).toBeTrue();
    } finally {
      await app.stop();
      await running;
      await telegram.stop();
    }
  }, 15_000);
});
