import { Api, GrammyError, HttpError, InputFile } from "grammy";
import type { BotCommand, ChatMember, Message, Update } from "grammy/types";
import type { InputRichMessageWithoutUpload } from "grammy/types";
import { redactSecrets } from "../secrets";
import type { AdminCapability } from "../types";

export class TelegramError extends Error {
  readonly retryAfter?: number;
  readonly errorCode?: number;
  constructor(message: string, retryAfter?: number, errorCode?: number, options?: ErrorOptions) {
    super(redactSecrets(message), options);
    this.name = "TelegramError";
    this.retryAfter = retryAfter;
    this.errorCode = errorCode;
  }
}

function translate(error: unknown): never {
  if (error instanceof GrammyError) {
    throw new TelegramError(
      `Telegram ${error.method}: ${error.description}`,
      error.parameters.retry_after,
      error.error_code,
      { cause: error },
    );
  }
  if (error instanceof HttpError) {
    throw new TelegramError(`Telegram network error: ${error.message}`, undefined, undefined, { cause: error });
  }
  throw error;
}

export function adminCapabilitiesForMember(member: ChatMember): Set<AdminCapability> {
  const creator = member.status === "creator";
  const administrator = member.status === "administrator" ? member : undefined;
  const capabilities = new Set<AdminCapability>();
  if (creator || administrator?.can_pin_messages) capabilities.add("pins");
  if (creator || administrator?.can_manage_topics) capabilities.add("topics");
  if (creator || administrator?.can_delete_messages) capabilities.add("delete_messages");
  if (creator || administrator?.can_restrict_members) capabilities.add("moderation");
  if (creator || administrator?.can_invite_users) capabilities.add("join_requests");
  return capabilities;
}

/**
 * Builds a Bot API client honoring TGFX_INTERNAL_TELEGRAM_API_ROOT, which
 * points tgfx at a local Bot API simulator in tests and development.
 */
export function createTelegramApi(token: string): TelegramApi {
  return new TelegramApi(token, process.env.TGFX_INTERNAL_TELEGRAM_API_ROOT);
}

export class TelegramApi {
  readonly api: Api;
  constructor(token: string, apiRoot?: string) {
    this.api = new Api(token, apiRoot ? { apiRoot } : undefined);
  }

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) { translate(error); }
  }

  getMe() { return this.call(() => this.api.getMe()); }

  getWebhookInfo() { return this.call(() => this.api.getWebhookInfo()); }

  getStickerSet(name: string) { return this.call(() => this.api.getStickerSet(name)); }

  async getUpdates(offset: number, timeout = 25, signal?: AbortSignal): Promise<Update[]> {
    return this.call(() => this.api.getUpdates({
        offset,
        timeout,
        allowed_updates: [
          "message", "edited_message", "callback_query", "poll_answer",
          "chat_join_request", "my_chat_member", "stopped_message_generation",
        ] as never,
      }, signal));
  }

  async sendText(
    chatId: string,
    text: string,
    topicId = "0",
    options: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<Message.TextMessage> {
    return this.call(() => this.api.sendMessage(chatId, text, {
        ...(topicId === "0" ? {} : { message_thread_id: Number(topicId) }),
        ...options,
      } as never, signal));
  }

  async sendRich(
    chatId: string,
    richMessage: InputRichMessageWithoutUpload,
    topicId = "0",
    options: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
    return this.call(() => this.api.sendRichMessage(chatId, richMessage, {
        ...(topicId === "0" ? {} : { message_thread_id: Number(topicId) }),
        ...options,
      }, signal));
  }

  async sendRichDraft(
    chatId: string,
    draftId: number,
    richMessage: InputRichMessageWithoutUpload,
    signal?: AbortSignal,
  ): Promise<true> {
    return this.call(() => this.api.sendRichMessageDraft(
      Number(chatId),
      draftId,
      richMessage,
      { can_stop: true } as never,
      signal,
    ));
  }

  async editRich(
    chatId: string,
    messageId: number,
    richMessage: InputRichMessageWithoutUpload,
    options: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
    return this.call(() => this.api.editMessageText(
      chatId,
      messageId,
      richMessage,
      options,
      signal,
    ));
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<true> {
    return this.call(() => this.api.answerCallbackQuery(callbackQueryId, text ? { text } : {}));
  }

  async editReplyMarkup(chatId: string, messageId: number, replyMarkup: unknown): Promise<unknown> {
    return this.call(() => this.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: replyMarkup as never }));
  }

  async editText(
    chatId: string,
    messageId: number,
    text: string,
    options: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.call(() => this.api.editMessageText(chatId, messageId, text, options as never));
  }

  async setCommands(chatId: string, commands: BotCommand[]): Promise<true> {
    return this.call(() => this.api.setMyCommands(commands, { scope: { type: "chat", chat_id: chatId } }));
  }

  async deleteCommands(chatId: string): Promise<true> {
    return this.call(() => this.api.deleteMyCommands({ scope: { type: "chat", chat_id: chatId } }));
  }

  async sendFile(chatId: string, path: string, filename: string, caption?: string, topicId = "0") {
    return this.call(() => this.api.sendDocument(chatId, new InputFile(path, filename), {
        ...(caption ? { caption } : {}),
        ...(topicId === "0" ? {} : { message_thread_id: Number(topicId) }),
      }));
  }
}
