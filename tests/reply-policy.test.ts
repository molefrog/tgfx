import { expect, test } from "bun:test";
import type { Update } from "grammy/types";
import { normalizeMessageUpdate, shouldInvokeAgent } from "../src/telegram/normalize";
import { replyPolicy } from "../src/telegram/reply-policy";
import { configSchema } from "../src/config";

const bot = { id: "100", username: "fake_bot", displayName: "Bot" };
function message(extra: Record<string, unknown> = {}) {
  return normalizeMessageUpdate(bot, { update_id: 1, message: {
    message_id: 1, date: 1, chat: { id: -9, type: "supergroup", title: "Team" },
    from: { id: 42, is_bot: false, first_name: "Ada" }, text: "hello", ...extra,
  } } as Update)!;
}

test("reply defaults are all in DMs and mention in groups", () => {
  const config = configSchema.parse({ version: 1, activeBotId: "100",
    access: { userIds: ["42"] }, approvals: { chatId: "42" } });
  expect(replyPolicy(config, { chatId: "42", chatKind: "private" })).toBe("all");
  expect(replyPolicy(config, { chatId: "-9", chatKind: "group" })).toBe("mention");
});

test("a DM override does not change that person's group policy", () => {
  const config = configSchema.parse({ version: 1, activeBotId: "100",
    access: { userIds: ["42"] }, approvals: { chatId: "42" },
    dmReply: "mention", chatReplies: { "42": "all" } });
  expect(replyPolicy(config, message().route)).toBe("mention");
});

test.each([
  ["ordinary message", {}, false],
  ["mention", { text: "🪴 @FAKE_bot", entities: [{ type: "mention", offset: 3, length: 9 }] }, true],
  ["mention by identity", { text: "Bot", entities: [{ type: "text_mention", offset: 0, length: 3, user: { id: 100 } }] }, true],
  ["similar username", { text: "@fake_bot_other", entities: [{ type: "mention", offset: 0, length: 15 }] }, false],
  ["addressed command", { text: "/stop@fake_bot" }, true],
  ["bare command", { text: "/stop" }, false],
  ["other bot's command", { text: "/stop@other_bot" }, false],
  ["reply to this bot", { reply_to_message: { from: { id: 100, is_bot: true } } }, true],
  ["reply to another bot", { reply_to_message: { from: { id: 200, is_bot: true } } }, false],
  ["quoted mention", { reply_to_message: { text: "@fake_bot", from: { id: 42, is_bot: false } } }, false],
] as const)("mention policy handles %s", (_label, extra, expected) => {
  expect(shouldInvokeAgent(message(extra), bot.username, bot.id, "mention")).toBe(expected);
});

test("all policy invokes a group message without a mention", () => {
  expect(shouldInvokeAgent(message(), bot.username, bot.id, "all")).toBeTrue();
});

test("all policy ignores another bot's command", () => {
  expect(shouldInvokeAgent(message({ text: "/status@other_bot" }), bot.username, bot.id, "all")).toBeFalse();
});

test("mention policy can keep ordinary DMs quiet while preserving controls", () => {
  const dm = message({ chat: { id: 42, type: "private", first_name: "Ada" } });
  expect(shouldInvokeAgent(dm, bot.username, bot.id, "mention")).toBeFalse();
  expect(shouldInvokeAgent({ ...dm, text: "/stop" }, bot.username, bot.id, "mention")).toBeTrue();
});
