import type { Update } from "grammy/types";

export type DecimalId = string;
export type ChatKind = "private" | "group" | "supergroup" | "channel";
type RenderMode = "streaming" | "final";

export type RendererConfig = {
  mode: RenderMode;
  collapseTools: boolean;
  expandStreamingTools: boolean;
  updateEveryMs: number;
};

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
  renderer: RendererConfig;
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
};

type TelegramEnvelope = {
  telegram_message: {
    version: 1;
    source: "tgfx:telegram";
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
      state: "remote";
      size?: number;
      mime?: string;
      name?: string;
      width?: number;
      height?: number;
      duration_seconds?: number;
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
