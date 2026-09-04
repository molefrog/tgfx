import type { Message, Update, User } from "grammy/types";
import type {
  AttachmentRef,
  BotIdentity,
  ChatKind,
  InboundMessage,
  SenderIdentity,
  TgfxConfig,
} from "../types";
import { routeKey } from "../types";
import { TELEGRAM_GUIDELINES_URI } from "../mcp/guidelines";

function ref(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function userName(user: User): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Telegram user";
}

function sender(message: Message): SenderIdentity {
  // Telegram may include its synthetic GroupAnonymousBot in `from` while the
  // real identity is the chat in `sender_chat`. Preserve the identity the
  // sender deliberately used.
  if (message.sender_chat) {
    return {
      kind: "chat",
      id: String(message.sender_chat.id),
      ref: ref("chat"),
      displayName: message.sender_chat.title ?? message.sender_chat.first_name ?? "Telegram chat",
      chatKind: message.sender_chat.type as ChatKind,
      ...(message.sender_chat.username ? { username: message.sender_chat.username } : {}),
    };
  }
  if (message.from) {
    return {
      kind: "user",
      id: String(message.from.id),
      ref: ref("usr"),
      displayName: userName(message.from),
      ...(message.from.username ? { username: message.from.username } : {}),
      ...(message.from.language_code ? { languageCode: message.from.language_code } : {}),
      isBot: message.from.is_bot,
    };
  }
  return { kind: "unknown", ref: ref("unknown") };
}

function attachmentRefs(message: Message): AttachmentRef[] {
  const result: AttachmentRef[] = [];
  const add = (value: Omit<AttachmentRef, "ref">) => result.push({ ref: ref("att"), ...value });
  const photo = message.photo?.at(-1);
  if (photo) add({
    kind: "photo", fileId: photo.file_id, fileUniqueId: photo.file_unique_id,
    ...(photo.file_size === undefined ? {} : { size: photo.file_size }),
    width: photo.width, height: photo.height,
  });
  if (message.voice) add({
    kind: "voice", fileId: message.voice.file_id, fileUniqueId: message.voice.file_unique_id,
    ...(message.voice.file_size === undefined ? {} : { size: message.voice.file_size }),
    ...(message.voice.mime_type ? { mimeType: message.voice.mime_type } : {}),
    duration: message.voice.duration,
  });
  if (message.audio) add({
    kind: "audio", fileId: message.audio.file_id, fileUniqueId: message.audio.file_unique_id,
    ...(message.audio.file_size === undefined ? {} : { size: message.audio.file_size }),
    ...(message.audio.mime_type ? { mimeType: message.audio.mime_type } : {}),
    ...(message.audio.file_name ? { name: message.audio.file_name } : {}),
    duration: message.audio.duration,
  });
  if (message.video) add({
    kind: "video", fileId: message.video.file_id, fileUniqueId: message.video.file_unique_id,
    ...(message.video.file_size === undefined ? {} : { size: message.video.file_size }),
    ...(message.video.mime_type ? { mimeType: message.video.mime_type } : {}),
    ...(message.video.file_name ? { name: message.video.file_name } : {}),
    width: message.video.width, height: message.video.height, duration: message.video.duration,
  });
  if (message.animation) add({
    kind: "animation", fileId: message.animation.file_id, fileUniqueId: message.animation.file_unique_id,
    ...(message.animation.file_size === undefined ? {} : { size: message.animation.file_size }),
    ...(message.animation.mime_type ? { mimeType: message.animation.mime_type } : {}),
    ...(message.animation.file_name ? { name: message.animation.file_name } : {}),
    width: message.animation.width, height: message.animation.height, duration: message.animation.duration,
  });
  if (message.document) add({
    kind: "document", fileId: message.document.file_id, fileUniqueId: message.document.file_unique_id,
    ...(message.document.file_size === undefined ? {} : { size: message.document.file_size }),
    ...(message.document.mime_type ? { mimeType: message.document.mime_type } : {}),
    ...(message.document.file_name ? { name: message.document.file_name } : {}),
  });
  if (message.sticker) add({
    kind: "sticker", fileId: message.sticker.file_id, fileUniqueId: message.sticker.file_unique_id,
    ...(message.sticker.file_size === undefined ? {} : { size: message.sticker.file_size }),
    mimeType: message.sticker.is_animated
      ? "application/x-tgsticker"
      : message.sticker.is_video ? "video/webm" : "image/webp",
    ...(message.sticker.set_name ? { stickerName: message.sticker.set_name } : {}),
    ...(message.sticker.emoji ? { emoji: message.sticker.emoji } : {}),
    ...(message.sticker.custom_emoji_id ? { customEmojiId: message.sticker.custom_emoji_id } : {}),
    width: message.sticker.width, height: message.sticker.height,
  });
  if (message.video_note) add({
    kind: "video_note", fileId: message.video_note.file_id,
    fileUniqueId: message.video_note.file_unique_id,
    ...(message.video_note.file_size === undefined ? {} : { size: message.video_note.file_size }),
    width: message.video_note.length, height: message.video_note.length,
    duration: message.video_note.duration,
  });
  return result;
}

function messageFromUpdate(update: Update): { message: Message; edited: boolean } | undefined {
  if (update.message) return { message: update.message, edited: false };
  if (update.edited_message) return { message: update.edited_message, edited: true };
  if (update.channel_post) return { message: update.channel_post, edited: false };
  if (update.edited_channel_post) return { message: update.edited_channel_post, edited: true };
  return undefined;
}

export function groupMigrationFromUpdate(update: Update): {
  oldChatId: string; newChatId: string; senderId?: string;
} | undefined {
  const message = update.message;
  if (!message) return undefined;
  if ("migrate_to_chat_id" in message && typeof message.migrate_to_chat_id === "number") {
    return {
      oldChatId: String(message.chat.id), newChatId: String(message.migrate_to_chat_id),
      ...(message.from ? { senderId: String(message.from.id) } : {}),
    };
  }
  if ("migrate_from_chat_id" in message && typeof message.migrate_from_chat_id === "number") {
    return {
      oldChatId: String(message.migrate_from_chat_id), newChatId: String(message.chat.id),
      ...(message.from ? { senderId: String(message.from.id) } : {}),
    };
  }
  return undefined;
}

export function normalizeMessageUpdate(
  bot: BotIdentity,
  update: Update,
  lookupReplyRef?: (chatId: string, messageId: string) => string | undefined,
): InboundMessage | undefined {
  const selected = messageFromUpdate(update);
  if (!selected) return undefined;
  const { message, edited } = selected;
  const chatId = String(message.chat.id);
  const topicId = String(message.message_thread_id ?? 0);
  const chatKind = message.chat.type as ChatKind;
  const senderIdentity = sender(message);
  const replyMessage = message.reply_to_message;
  const replyRef = replyMessage
    ? lookupReplyRef?.(chatId, String(replyMessage.message_id)) ?? ref("msg")
    : undefined;
  const text = message.text ?? message.caption;
  const attachments = attachmentRefs(message);
  const replyAttachments = replyMessage ? attachmentRefs(replyMessage).map((attachment) => attachment.kind) : [];
  const replyText = replyMessage?.text ?? replyMessage?.caption;
  const replyLocation = replyMessage?.location ?? replyMessage?.venue?.location;
  const location = message.location ?? message.venue?.location;
  // Service messages, contacts, and arbitrary polls are acknowledged by the
  // poll cursor but are not disguised as user prompts.
  if (text === undefined && attachments.length === 0 && !location) return undefined;
  const provenance: Record<string, unknown> = {};
  if (message.forward_origin) provenance.forward_origin = message.forward_origin;
  if (message.media_group_id) provenance.media_group_id = message.media_group_id;
  if (message.via_bot) provenance.via_bot = {
    id: String(message.via_bot.id), username: message.via_bot.username,
  };
  if (message.author_signature) provenance.author_signature = message.author_signature;

  return {
    updateId: update.update_id,
    event: edited ? "message.edited" : "message.created",
    route: {
      key: routeKey(bot.id, chatId, topicId),
      botId: bot.id,
      chatId,
      topicId,
      chatKind,
    },
    sender: senderIdentity,
    messageId: String(message.message_id),
    messageRef: lookupReplyRef?.(chatId, String(message.message_id)) ?? ref("msg"),
    contextRef: ref("ctx"),
    timestamp: new Date(message.date * 1000),
    ...(text === undefined ? {} : { text, textKind: message.text === undefined ? "caption" as const : "text" as const }),
    attachments,
    ...(location ? { location } : {}),
    ...(message.venue ? { venue: message.venue } : {}),
    ...(replyMessage ? {
      reply: {
        message_ref: replyRef!,
        ...(message.quote?.text ? { quote: message.quote.text } : {}),
        ...(replyMessage.from ? { sender_name: userName(replyMessage.from) }
          : replyMessage.sender_chat
            ? { sender_name: replyMessage.sender_chat.title ?? replyMessage.sender_chat.first_name ?? "Telegram chat" }
            : {}),
        ...(replyText ? { text_excerpt: replyText.slice(0, 1_000) } : {}),
        ...(replyAttachments.length ? { attachment_kinds: [...new Set(replyAttachments)] } : {}),
        ...(replyLocation ? { location: replyLocation } : {}),
        ...(replyMessage.venue ? { venue: replyMessage.venue } : {}),
      },
    } : {}),
    ...(Object.keys(provenance).length ? { provenance } : {}),
    raw: update,
  };
}

export function isAuthorized(config: TgfxConfig, message: InboundMessage): boolean {
  // V1 is an interactive chat bridge. Broadcast channel posts do not have the
  // request/reply ownership semantics required by the scoped action plane.
  if (message.route.chatKind === "channel") return false;
  if (message.sender.kind === "user" && message.sender.isBot) return false;
  const senderId = "id" in message.sender ? message.sender.id : undefined;
  return config.access.chatIds.includes(message.route.chatId)
    || (senderId !== undefined && config.access.userIds.includes(senderId));
}

export const SESSION_BOOTSTRAP_INSTRUCTIONS =
  `New session: first call the built-in mcp_features tool with ` +
  `{"action": "resource_read", "server": "telegram", "uri": "${TELEGRAM_GUIDELINES_URI}"} ` +
  `(no capability_search or mcp_search_tools needed). Output no text before this call ` +
  `and never mention the guidelines - silently apply them from now on.`;

export function toEnvelope(message: InboundMessage, options: { sessionBootstrap?: boolean } = {}) {
  const editedMessage = message.raw.edited_message ?? message.raw.edited_channel_post;
  const envelopeSender = message.sender.kind === "user"
    ? {
        kind: "user" as const,
        ref: message.sender.ref,
        user_id: message.sender.id,
        display_name: message.sender.displayName,
        ...(message.sender.username ? { username: message.sender.username } : {}),
        ...(message.sender.languageCode ? { language_code: message.sender.languageCode } : {}),
        is_bot: message.sender.isBot,
      }
    : message.sender.kind === "chat"
      ? {
          kind: "chat" as const,
          ref: message.sender.ref,
          chat_id: message.sender.id,
          title: message.sender.displayName,
          ...(message.sender.chatKind ? { chat_kind: message.sender.chatKind } : {}),
          ...(message.sender.username ? { username: message.sender.username } : {}),
        }
      : { kind: "unknown" as const, ref: message.sender.ref };
  return {
    telegram_message: {
      version: 1 as const,
      source: "tgfx:telegram" as const,
      instructions: "Messages come from Telegram, your replies are sent back. Use `telegram` MCP for: reactions (`set_reaction`), stickers (`send_sticker_by_id`, `send_sticker_file` and more), files (`send_file`), photos (`send_photo`), voice messages (`send_voice`), circular videos (`send_video_note`), polls, group admin actions and more. Use search.",
      ...(options.sessionBootstrap ? { session_bootstrap: SESSION_BOOTSTRAP_INSTRUCTIONS } : {}),
      event: message.event,
      event_id: `tg:${message.updateId}`,
      context_ref: message.contextRef,
      scope: {
        chat_id: message.route.chatId,
        kind: message.route.chatKind,
        topic_id: message.route.topicId,
      },
      sender: envelopeSender,
      message: {
        ref: message.messageRef,
        message_id: message.messageId,
        ts: message.timestamp.toISOString(),
        ...(message.event === "message.edited"
          ? { edited_at: new Date((editedMessage?.edit_date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString() }
          : {}),
        ...(message.provenance?.media_group_id
          ? { media_group_id: String(message.provenance.media_group_id) }
          : {}),
      },
      ...(message.textKind ? { text_kind: message.textKind } : {}),
      ...(message.location ? { location: message.location } : {}),
      ...(message.venue ? { venue: message.venue } : {}),
      ...(message.provenance?.forward_origin ? { forwarded: true } : {}),
      attachments: message.attachments.map((attachment) => ({
        ref: attachment.ref,
        kind: attachment.kind,
        state: attachment.localPath ? "local" as const : "remote" as const,
        ...(attachment.size === undefined ? {} : { size: attachment.size }),
        ...(attachment.mimeType ? { mime: attachment.mimeType } : {}),
        ...(attachment.name ? { name: attachment.name } : {}),
        ...(attachment.width === undefined ? {} : { width: attachment.width }),
        ...(attachment.height === undefined ? {} : { height: attachment.height }),
        ...(attachment.duration === undefined ? {} : { duration_seconds: attachment.duration }),
        ...(attachment.kind === "sticker" ? {
          sticker: {
            file_id: attachment.fileId,
            ...(attachment.stickerName ? { name: attachment.stickerName } : {}),
            ...(attachment.emoji ? { emoji: attachment.emoji } : {}),
            ...(attachment.customEmojiId ? { custom_emoji_id: attachment.customEmojiId } : {}),
            image: attachment.localPath
              ? {
                  state: "local" as const,
                  path: attachment.localPath,
                  ...(attachment.mimeType ? { mime: attachment.mimeType } : {}),
                }
              : {
                  state: "remote" as const,
                  attachment_ref: attachment.ref,
                  ...(attachment.mimeType ? { mime: attachment.mimeType } : {}),
                },
          },
        } : {}),
      })),
      ...(message.reply ? { reply: message.reply } : {}),
      ...(message.provenance ? { provenance: message.provenance } : {}),
      response_target: { kind: "automatic_reply" as const },
    },
  };
}

export function commandFromText(text: string | undefined, botUsername?: string): {
  name: string; args: string; addressed: boolean;
} | undefined {
  if (!text?.startsWith("/")) return undefined;
  const firstSpace = text.search(/\s/);
  const head = text.slice(1, firstSpace === -1 ? undefined : firstSpace);
  const [rawName, addressedTo] = head.split("@", 2);
  if (!rawName) return undefined;
  const addressed = addressedTo === undefined
    || botUsername === undefined
    || addressedTo.toLowerCase() === botUsername.toLowerCase();
  return {
    name: rawName.toLowerCase(),
    args: firstSpace === -1 ? "" : text.slice(firstSpace).trimStart(),
    addressed,
  };
}

export function shouldInvokeAgent(message: InboundMessage, botUsername?: string, botId?: string): boolean {
  if (message.route.chatKind === "private") return true;
  const command = message.provenance?.forward_origin ? undefined : commandFromText(message.text, botUsername);
  if (command?.addressed) return true;
  const rawMessage = message.raw.message ?? message.raw.edited_message;
  const entities = rawMessage?.entities ?? rawMessage?.caption_entities ?? [];
  const mentioned = botUsername ? entities.some((entity) =>
    entity.type === "mention"
    && message.text?.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${botUsername.toLowerCase()}`
  ) : false;
  const replyToBot = rawMessage?.reply_to_message?.from?.is_bot
    && ((botId !== undefined && String(rawMessage.reply_to_message.from.id) === botId)
      || rawMessage.reply_to_message.from.username?.toLowerCase() === botUsername?.toLowerCase());
  return Boolean(mentioned || replyToBot);
}
