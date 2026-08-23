export interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

export interface TelegramMessageEntity {
  type:
    | "bold"
    | "italic"
    | "underline"
    | "strikethrough"
    | "spoiler"
    | "code"
    | "pre"
    | "text_link";
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

export interface TelegramBotCommand {
  command: string;
  description: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(token: string, apiRoot = "https://api.telegram.org") {
    this.baseUrl = `${apiRoot}/bot${token}`;
  }

  async call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    let payload: TelegramResponse<T>;
    try {
      payload = (await response.json()) as TelegramResponse<T>;
    } catch {
      throw new TelegramApiError(
        `Telegram returned a non-JSON response (${response.status})`,
        response.status,
      );
    }

    if (!response.ok || !payload.ok || payload.result === undefined) {
      throw new TelegramApiError(
        payload.description ?? `Telegram request failed (${response.status})`,
        payload.error_code ?? response.status,
        payload.parameters?.retry_after,
      );
    }

    return payload.result;
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe");
  }

  setMyCommands(commands: TelegramBotCommand[]): Promise<true> {
    return this.call<true>("setMyCommands", {
      commands,
      scope: { type: "all_private_chats" },
    });
  }

  getUpdates(offset: number, timeout = 25): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message"],
    });
  }

  sendMessage(
    chatId: number,
    text: string,
    messageThreadId?: number,
    entities?: TelegramMessageEntity[],
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      ...(entities === undefined ? {} : { entities }),
      ...(messageThreadId === undefined
        ? {}
        : { message_thread_id: messageThreadId }),
    });
  }

  sendMessageDraft(
    chatId: number,
    draftId: number,
    text: string,
    messageThreadId?: number,
    entities?: TelegramMessageEntity[],
  ): Promise<true> {
    return this.call<true>("sendMessageDraft", {
      chat_id: chatId,
      draft_id: draftId,
      text,
      ...(entities === undefined ? {} : { entities }),
      ...(messageThreadId === undefined
        ? {}
        : { message_thread_id: messageThreadId }),
    });
  }
}
