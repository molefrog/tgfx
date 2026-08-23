import { Api, GrammyError, HttpError, InputFile } from "grammy";
import type { BotCommand, Message, Update } from "grammy/types";
import type { InputRichMessageWithoutUpload } from "grammy/types";
import { redactSecrets } from "../secrets";

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

export class TelegramApi {
  readonly api: Api;
  constructor(readonly token: string, apiRoot?: string) {
    this.api = new Api(token, apiRoot ? { apiRoot } : undefined);
  }

  async getMe() {
    try { return await this.api.getMe(); } catch (error) { translate(error); }
  }

  async getWebhookInfo() {
    try { return await this.api.getWebhookInfo(); } catch (error) { translate(error); }
  }

  async getUpdates(offset: number, timeout = 25, signal?: AbortSignal): Promise<Update[]> {
    try {
      return await this.api.getUpdates({
        offset,
        timeout,
        allowed_updates: ["message", "edited_message", "callback_query", "poll_answer", "chat_join_request"],
      }, signal);
    } catch (error) { translate(error); }
  }

  async sendText(
    chatId: string,
    text: string,
    topicId = "0",
    options: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<Message.TextMessage> {
    try {
      return await this.api.sendMessage(chatId, text, {
        ...(topicId === "0" ? {} : { message_thread_id: Number(topicId) }),
        ...options,
      } as never, signal);
    } catch (error) { translate(error); }
  }

  async sendRich(
    chatId: string,
    richMessage: InputRichMessageWithoutUpload,
    topicId = "0",
    options: Record<string, unknown> = {},
    signal?: AbortSignal,
  ) {
    try {
      return await this.api.sendRichMessage(chatId, richMessage, {
        ...(topicId === "0" ? {} : { message_thread_id: Number(topicId) }),
        ...options,
      }, signal);
    } catch (error) { translate(error); }
  }

  async sendRichDraft(
    chatId: string,
    draftId: number,
    richMessage: InputRichMessageWithoutUpload,
    signal?: AbortSignal,
  ): Promise<true> {
    try { return await this.api.sendRichMessageDraft(Number(chatId), draftId, richMessage, {}, signal); }
    catch (error) { translate(error); }
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<true> {
    try { return await this.api.answerCallbackQuery(callbackQueryId, text ? { text } : {}); }
    catch (error) { translate(error); }
  }

  async editReplyMarkup(chatId: string, messageId: number, replyMarkup: unknown): Promise<unknown> {
    try {
      return await this.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: replyMarkup as never });
    } catch (error) { translate(error); }
  }

  async setCommands(chatId: string, commands: BotCommand[]): Promise<true> {
    try {
      return await this.api.setMyCommands(commands, { scope: { type: "chat", chat_id: chatId } });
    } catch (error) { translate(error); }
  }

  async deleteCommands(chatId: string): Promise<true> {
    try { return await this.api.deleteMyCommands({ scope: { type: "chat", chat_id: chatId } }); }
    catch (error) { translate(error); }
  }

  async sendFile(chatId: string, path: string, filename: string, caption?: string, topicId = "0") {
    try {
      return await this.api.sendDocument(chatId, new InputFile(path, filename), {
        ...(caption ? { caption } : {}),
        ...(topicId === "0" ? {} : { message_thread_id: Number(topicId) }),
      });
    } catch (error) { translate(error); }
  }
}
