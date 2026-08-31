import { describe, expect, test } from "bun:test";
import type { Update } from "grammy/types";
import { commandFromText, groupMigrationFromUpdate, isAuthorized, normalizeMessageUpdate, SESSION_BOOTSTRAP_INSTRUCTIONS, shouldInvokeAgent, toEnvelope } from "../src/telegram/normalize";
import type { BotIdentity, TgfxConfig } from "../src/types";

const bot: BotIdentity = { id: "100", username: "tgfx_test_bot", displayName: "tgfx" };
const config: TgfxConfig = {
  version: 1, activeBotId: "100",
  access: { userIds: ["42"], chatIds: [] },
  approvals: { chatId: "42", topicId: "0" },
  streaming: true, expandStreamingTools: true, updateEveryMs: 800, customIcons: true,
};

function update(overrides: Record<string, unknown> = {}): Update {
  return {
    update_id: 11,
    message: {
      message_id: 20,
      date: 1_787_478_400,
      chat: { id: 42, type: "private", first_name: "Ada" },
      from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
      text: "hello",
      ...overrides,
    },
  } as Update;
}

describe("Telegram input normalization", () => {
  test("separates the JSON envelope from unchanged user text", () => {
    const message = normalizeMessageUpdate(bot, update())!;
    const envelope = toEnvelope(message);
    expect(message.text).toBe("hello");
    expect(envelope.telegram_message.source).toBe("tgfx:telegram");
    expect(envelope.telegram_message.instructions).toContain("`telegram` MCP");
    expect(envelope.telegram_message.instructions).toContain("`set_reaction`");
    expect(envelope.telegram_message.event).toBe("message.created");
    expect(envelope.telegram_message.event_id).toBe("tg:11");
    expect(envelope.telegram_message.sender).toMatchObject({ user_id: "42", display_name: "Ada" });
    expect(envelope.telegram_message.message).toMatchObject({ message_id: "20" });
    expect(envelope.telegram_message.response_target).toEqual({ kind: "automatic_reply" });
    expect(envelope.telegram_message.scope).toEqual({ chat_id: "42", kind: "private", topic_id: "0" });
    expect(isAuthorized(config, message)).toBeTrue();
    expect(envelope.telegram_message).not.toContainKey("session_bootstrap");
  });

  test("injects the session bootstrap directive only when requested", () => {
    const message = normalizeMessageUpdate(bot, update())!;
    const envelope = toEnvelope(message, { sessionBootstrap: true });
    expect(envelope.telegram_message.session_bootstrap).toBe(SESSION_BOOTSTRAP_INSTRUCTIONS);
    expect(SESSION_BOOTSTRAP_INSTRUCTIONS).toContain("mcp_features");
    expect(SESSION_BOOTSTRAP_INSTRUCTIONS).toContain("resource_read");
    expect(SESSION_BOOTSTRAP_INSTRUCTIONS).toContain("telegram://guidelines");
    expect(SESSION_BOOTSTRAP_INSTRUCTIONS).toContain("capability_search");
    expect(SESSION_BOOTSTRAP_INSTRUCTIONS).toContain("no text before this call");
  });

  test("exposes opaque attachment metadata but never the Bot API file_id", () => {
    const message = normalizeMessageUpdate(bot, update({
      text: undefined,
      caption: "voice caption",
      voice: {
        file_id: "download-secret", file_unique_id: "stable", duration: 3,
        mime_type: "audio/ogg", file_size: 120,
      },
    }))!;
    const encoded = JSON.stringify(toEnvelope(message));
    expect(message.textKind).toBe("caption");
    expect(encoded).toContain(message.attachments[0]!.ref);
    expect(encoded).not.toContain("download-secret");
    expect(encoded).toContain("audio/ogg");
  });

  test("bounds useful reply context without exposing a raw target ID", () => {
    const message = normalizeMessageUpdate(bot, update({
      text: "What about this?",
      reply_to_message: {
        message_id: 19,
        date: 1_787_478_300,
        chat: { id: 42, type: "private", first_name: "Ada" },
        from: { id: 43, is_bot: false, first_name: "Grace" },
        text: "x".repeat(1_200),
        document: { file_id: "reply-file", file_unique_id: "unique", file_name: "old.txt" },
      },
    }))!;
    expect(message.reply).toMatchObject({
      sender_name: "Grace", text_excerpt: "x".repeat(1_000), attachment_kinds: ["document"],
    });
    const encoded = JSON.stringify(toEnvelope(message));
    expect(encoded).not.toContain("reply-file");
    expect(encoded).not.toContain('"message_id":"19"');
  });

  test("requires an explicit trigger in groups", () => {
    const ordinary = normalizeMessageUpdate(bot, update({
      chat: { id: -9, type: "supergroup", title: "Team" }, text: "hello",
    }))!;
    const command = normalizeMessageUpdate(bot, update({
      chat: { id: -9, type: "supergroup", title: "Team" }, text: "/status",
    }))!;
    expect(shouldInvokeAgent(ordinary, bot.username)).toBeFalse();
    expect(shouldInvokeAgent(command, bot.username)).toBeTrue();
    const mention = normalizeMessageUpdate(bot, update({
      chat: { id: -9, type: "supergroup", title: "Team" },
      text: "hello @tgfx_test_bot",
      entities: [{ type: "mention", offset: 6, length: 14 }],
    }))!;
    expect(shouldInvokeAgent(mention, bot.username, bot.id)).toBeTrue();
    const lookalike = normalizeMessageUpdate(bot, update({
      chat: { id: -9, type: "supergroup", title: "Team" }, text: "hello @tgfx_test_bot_evil",
    }))!;
    expect(shouldInvokeAgent(lookalike, bot.username, bot.id)).toBeFalse();
  });

  test("does not let another bot spend an allowlisted chat's model budget", () => {
    const message = normalizeMessageUpdate(bot, update({
      chat: { id: -9, type: "supergroup", title: "Team" },
      from: { id: 77, is_bot: true, first_name: "Other bot", username: "other_bot" },
      text: "/status",
    }))!;
    expect(isAuthorized({ ...config, access: { userIds: [], chatIds: ["-9"] } }, message)).toBeFalse();
  });

  test("normalizes commands addressed to this bot without changing arguments", () => {
    expect(commandFromText("/status@tgfx_test_bot now please", bot.username)).toEqual({
      name: "status", args: "now please", addressed: true,
    });
    expect(commandFromText("/status@someone_else", bot.username)?.addressed).toBeFalse();
  });

  test("prefers sender_chat for anonymous administrators", () => {
    const anonymousUpdate = update({
      chat: { id: -10055, type: "supergroup", title: "Team" },
      from: { id: 1087968824, is_bot: true, first_name: "GroupAnonymousBot" },
      sender_chat: { id: -10055, type: "supergroup", title: "Team" },
    });
    const message = normalizeMessageUpdate(bot, anonymousUpdate)!;
    expect(message.sender.kind).toBe("chat");
    expect("id" in message.sender && message.sender.id).toBe("-10055");
  });

  test("never authorizes broadcast channel posts in v1", () => {
    const channelUpdate = update({
      chat: { id: -10077, type: "channel", title: "Broadcast" },
      sender_chat: { id: -10077, type: "channel", title: "Broadcast" },
    });
    const message = normalizeMessageUpdate(bot, channelUpdate)!;
    expect(isAuthorized({
      ...config,
      access: { ...config.access, chatIds: ["-10077"] },
    }, message)).toBeFalse();
  });

  test("ignores unsupported service messages instead of inventing an agent prompt", () => {
    expect(normalizeMessageUpdate(bot, update({
      text: undefined,
      new_chat_title: "Renamed group",
    }))).toBeUndefined();
    expect(normalizeMessageUpdate(bot, update({
      text: undefined,
      location: { latitude: 55.6761, longitude: 12.5683 },
    }))).toBeUndefined();
  });

  test("keeps supported media-only messages", () => {
    const message = normalizeMessageUpdate(bot, update({
      text: undefined,
      document: {
        file_id: "opaque-download-id", file_unique_id: "stable-id",
        file_name: "notes.txt", mime_type: "text/plain", file_size: 12,
      },
    }));
    expect(message?.attachments).toHaveLength(1);
    expect(message?.text).toBeUndefined();
  });

  test("exposes a sendable sticker file ID, name, and its automatically downloaded image", () => {
    const message = normalizeMessageUpdate(bot, update({
      text: undefined,
      sticker: {
        file_id: "reusable-secret-id", file_unique_id: "stable-sticker-id",
        width: 512, height: 512, is_animated: false, is_video: false,
        set_name: "FriendlyFrogs", emoji: "🐸", file_size: 321,
      },
    }))!;
    message.attachments[0]!.localPath = "/tmp/tgfx/sticker.webp";
    const attachment = toEnvelope(message).telegram_message.attachments[0]!;
    expect(attachment).toMatchObject({
      kind: "sticker",
      state: "local",
      mime: "image/webp",
      sticker: {
        file_id: "reusable-secret-id",
        name: "FriendlyFrogs",
        emoji: "🐸",
        image: { state: "local", path: "/tmp/tgfx/sticker.webp", mime: "image/webp" },
      },
    });
    expect(JSON.stringify(attachment)).toContain("reusable-secret-id");
  });

  test("recognizes both halves of a group-to-supergroup migration", () => {
    expect(groupMigrationFromUpdate(update({
      text: undefined,
      chat: { id: -9, type: "group", title: "Old" },
      migrate_to_chat_id: -1009,
    }))).toEqual({ oldChatId: "-9", newChatId: "-1009", senderId: "42" });
    expect(groupMigrationFromUpdate(update({
      text: undefined,
      chat: { id: -1009, type: "supergroup", title: "New" },
      migrate_from_chat_id: -9,
    }))).toEqual({ oldChatId: "-9", newChatId: "-1009", senderId: "42" });
  });
});
