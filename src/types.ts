import type { Update } from "grammy/types";

export type DecimalId = string;
export type ChatKind = "private" | "group" | "supergroup" | "channel";
/**
 * How a turn reaches Telegram, least to most talkative:
 *
 * - `answer`: one message with just the answer, once fx is done;
 * - `report`: one message with the answer and collapsed tool groups;
 * - `progress`: a live status line ("Reading files…") while fx works, then
 *   the answer streams in; the final message is the answer alone;
 * - `live`: a live draft with prose and every tool call as it happens.
 *
 * Groups never see drafts: `progress` and `live` fall back to one message.
 */
export const OUTPUT_MODES = ["answer", "report", "progress", "live"] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

/** How each mode reads in menus: the terminal format menu and Telegram's /format. */
export const REPLY_STYLES: Record<OutputMode, { name: string; hint: string }> = {
  answer: { name: "Final answer", hint: "Send the answer when the turn finishes" },
  report: { name: "Final with activity", hint: "Send the answer with collapsed tool activity" },
  progress: { name: "Live answer", hint: "Show live status, then stream the final answer" },
  live: { name: "Live with activity", hint: "Stream the answer and tool activity as they happen" },
};

export function isOutputMode(value: unknown): value is OutputMode {
  return OUTPUT_MODES.includes(value as OutputMode);
}

export type AdminCapability =
  | "pins"
  | "topics"
  | "delete_messages"
  | "moderation"
  | "join_requests";

export type TgfxConfig = {
  version: 1;
  activeBotId: DecimalId;
  access: {
    userIds: DecimalId[];
    chatIds: DecimalId[];
  };
  /** Where approval cards and delivery-failure notices go. */
  approvals: {
    chatId: DecimalId;
    topicId: DecimalId;
  };
  output: OutputMode;
  customIcons: boolean;
};

export type Route = {
  key: string;
  botId: DecimalId;
  chatId: DecimalId;
  topicId: DecimalId;
  chatKind: ChatKind;
};

export type SenderIdentity =
  | {
      kind: "user";
      id: DecimalId;
      ref: string;
      displayName: string;
      username?: string;
      languageCode?: string;
      isBot: boolean;
    }
  | {
      kind: "chat";
      id: DecimalId;
      ref: string;
      displayName: string;
      username?: string;
      chatKind?: ChatKind;
    }
  | { kind: "unknown"; ref: string };

type AttachmentKind =
  | "photo"
  | "voice"
  | "audio"
  | "video"
  | "animation"
  | "document"
  | "sticker"
  | "video_note";

export type AttachmentRef = {
  ref: string;
  kind: AttachmentKind;
  fileId: string;
  fileUniqueId: string;
  size?: number;
  mimeType?: string;
  name?: string;
  width?: number;
  height?: number;
  duration?: number;
  stickerName?: string;
  emoji?: string;
  customEmojiId?: string;
  localPath?: string;
};

type TelegramEnvelope = {
  telegram_message: {
    version: 1;
    source: "tgfx:telegram";
    instructions: string;
    event: "message.created" | "message.edited" | "interaction.choice" | "poll.answer";
    event_id: string;
    context_ref: string;
    scope: {
      chat_id: DecimalId;
      kind: ChatKind;
      topic_id: DecimalId;
    };
    sender:
      | {
          kind: "user";
          ref: string;
          user_id: DecimalId;
          display_name: string;
          username?: string;
          language_code?: string;
          is_bot: boolean;
        }
      | {
          kind: "chat";
          ref: string;
          chat_id: DecimalId;
          title: string;
          username?: string;
          chat_kind?: ChatKind;
        }
      | { kind: "unknown"; ref: string };
    message: {
      ref: string;
      message_id: DecimalId;
      ts: string;
      edited_at?: string;
      media_group_id?: string;
    };
    text_kind?: "text" | "caption";
    attachments: Array<{
      ref: string;
      kind: AttachmentKind;
      state: "remote" | "local";
      size?: number;
      mime?: string;
      name?: string;
      width?: number;
      height?: number;
      duration_seconds?: number;
      sticker?: {
        file_id: string;
        name?: string;
        emoji?: string;
        custom_emoji_id?: string;
        image: {
          state: "local" | "remote";
          path?: string;
          attachment_ref?: string;
          mime?: string;
        };
      };
    }>;
    reply?: {
      message_ref: string;
      quote?: string;
      sender_name?: string;
      text_excerpt?: string;
      attachment_kinds?: AttachmentKind[];
    };
    provenance?: Record<string, unknown>;
    response_target: { kind: "automatic_reply" };
  };
};

export type InboundMessage = {
  updateId: number;
  event: TelegramEnvelope["telegram_message"]["event"];
  route: Route;
  sender: SenderIdentity;
  messageId: DecimalId;
  messageRef: string;
  contextRef: string;
  timestamp: Date;
  text?: string;
  textKind?: "text" | "caption";
  attachments: AttachmentRef[];
  reply?: TelegramEnvelope["telegram_message"]["reply"];
  provenance?: Record<string, unknown>;
  raw: Update;
};

export type BotIdentity = {
  id: DecimalId;
  username?: string;
  displayName: string;
};

export function routeKey(botId: DecimalId, chatId: DecimalId, topicId = "0"): string {
  return `${botId}:${chatId}:${topicId}`;
}
