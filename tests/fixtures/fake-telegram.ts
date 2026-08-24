import type { Update } from "grammy/types";

/**
 * A local Telegram Bot API simulator.
 *
 * Serves the JSON POST protocol grammY speaks, so pointing any tgfx process at
 * it via TGFX_INTERNAL_TELEGRAM_API_ROOT (or `new TelegramApi(token, url)`)
 * exercises the real HTTP transport with no network. Tests inject updates with
 * `sendUserMessage`/`push` and observe outgoing Bot API calls in `requests`.
 */

type RecordedRequest = { method: string; payload: Record<string, any> };

type ChatShape = Record<string, unknown> & { id: number; type: string };

export class FakeTelegram {
  readonly requests: RecordedRequest[] = [];
  readonly botId: number;
  readonly botUsername: string;
  /** getChat responses by chat id; unlisted chats fall back to a private chat. */
  readonly chats = new Map<string, ChatShape>();
  /** getChatMember responses by chat id; unlisted chats report plain membership. */
  readonly chatMembers = new Map<string, Record<string, unknown>>();

  private readonly queue: Update[] = [];
  private waiters: Array<() => void> = [];
  private nextUpdateId = 1;
  private nextMessageId = 1000;
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(options: { botId?: number; botUsername?: string } = {}) {
    this.botId = options.botId ?? 100;
    this.botUsername = options.botUsername ?? "fake_bot";
    this.server = Bun.serve({
      port: 0,
      fetch: (request) => this.handle(request),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  fileUrl(token: string): string {
    return `${this.url}/file/bot${token}`;
  }

  async stop(): Promise<void> {
    for (const wake of this.waiters.splice(0)) wake();
    await this.server.stop(true);
  }

  /** Queues an update for the next getUpdates long poll. Returns its update_id. */
  push(update: Omit<Update, "update_id"> & { update_id?: number }): number {
    const id = update.update_id ?? this.nextUpdateId++;
    this.nextUpdateId = Math.max(this.nextUpdateId, id + 1);
    this.queue.push({ ...update, update_id: id } as Update);
    for (const wake of this.waiters.splice(0)) wake();
    return id;
  }

  sendUserMessage(input: {
    userId: number;
    text: string;
    chatId?: number;
    chatType?: "private" | "group" | "supergroup";
    firstName?: string;
  }): number {
    const chatId = input.chatId ?? input.userId;
    const chatType = input.chatType ?? "private";
    return this.push({
      message: {
        message_id: this.nextMessageId++,
        date: Math.floor(Date.now() / 1_000),
        chat: chatType === "private"
          ? { id: chatId, type: "private", first_name: input.firstName ?? `User ${input.userId}` }
          : { id: chatId, type: chatType, title: `Chat ${chatId}` },
        from: { id: input.userId, is_bot: false, first_name: input.firstName ?? `User ${input.userId}` },
        text: input.text,
      },
    } as never);
  }

  calls(method: string): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method);
  }

  /** Waits until the bot has made `count` calls of `method`. */
  async waitForCalls(method: string, count = 1, timeoutMs = 5_000): Promise<RecordedRequest[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const seen = this.calls(method);
      if (seen.length >= count) return seen;
      await Bun.sleep(20);
    }
    throw new Error(`timed out waiting for ${count} ${method} call(s); saw ${this.calls(method).length}`);
  }

  private message(chatId: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const id = Number(chatId ?? 0);
    return {
      message_id: this.nextMessageId++,
      date: Math.floor(Date.now() / 1_000),
      chat: this.chats.get(String(id)) ?? { id, type: id < 0 ? "supergroup" : "private", first_name: "Chat" },
      ...extra,
    };
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.includes("/file/bot")) return new Response("filedata");
    const method = url.pathname.split("/").at(-1)!;
    let payload: Record<string, any> = {};
    try { payload = await request.json() as Record<string, any>; } catch { /* empty body */ }
    this.requests.push({ method, payload });
    const ok = (result: unknown) => Response.json({ ok: true, result });
    switch (method) {
      case "getMe":
        return ok({
          id: this.botId, is_bot: true, first_name: "Fake Bot", username: this.botUsername,
          can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
        });
      case "getWebhookInfo":
        return ok({ url: "", has_custom_certificate: false, pending_update_count: 0 });
      case "getUpdates":
        return this.getUpdates(payload).then(ok);
      case "getChat": {
        const id = String(payload.chat_id);
        return ok(this.chats.get(id) ?? {
          id: Number(id), type: Number(id) < 0 ? "supergroup" : "private", first_name: `Chat ${id}`,
        });
      }
      case "getChatMember":
        return ok(this.chatMembers.get(String(payload.chat_id)) ?? {
          status: "member", user: { id: this.botId, is_bot: true, first_name: "Fake Bot" },
        });
      case "sendMessage":
        return ok(this.message(payload.chat_id, { text: payload.text }));
      case "sendRichMessage":
      case "editMessageText":
      case "editMessageReplyMarkup":
      case "sendDocument":
        return ok(this.message(payload.chat_id));
      case "sendPoll":
        return ok(this.message(payload.chat_id, {
          poll: {
            id: `poll-${this.nextMessageId}`, question: payload.question, options: [],
            total_voter_count: 0, is_closed: false, is_anonymous: Boolean(payload.is_anonymous),
            type: "regular", allows_multiple_answers: Boolean(payload.allows_multiple_answers),
          },
        }));
      case "getFile":
        return ok({ file_id: payload.file_id, file_unique_id: "unique", file_path: "attachments/file.bin" });
      case "createForumTopic":
        return ok({ message_thread_id: 77, name: payload.name, icon_color: 0x6FB9F0 });
      default:
        // Menus, reactions, pins, moderation, drafts: acknowledged and recorded.
        return ok(true);
    }
  }

  private async getUpdates(payload: Record<string, any>): Promise<Update[]> {
    const offset = Number(payload.offset ?? 0);
    while (this.queue.length && this.queue[0]!.update_id < offset) this.queue.shift();
    const pending = () => this.queue.filter((update) => update.update_id >= offset);
    // Telegram long polls up to `timeout` seconds; the simulator caps the wait
    // so aborted test runs never hang a poller.
    const timeoutMs = Math.min(Number(payload.timeout ?? 0), 2) * 1_000;
    if (pending().length || timeoutMs <= 0) return pending();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => { clearTimeout(timer); resolve(); });
    });
    return pending();
  }
}
