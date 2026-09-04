import type { Update } from "grammy/types";
import { withTimeout } from "../../src/timeout";

type RecordedRequest = { method: string; payload: Record<string, any> };

export class FakeTelegram {
  readonly requests: RecordedRequest[] = [];
  readonly botId: number;
  readonly botUsername: string;
  readonly chatMembers = new Map<string, Record<string, unknown>>();

  private readonly queue: Update[] = [];
  private waiters: Array<() => void> = [];
  private readonly requestWaiters = new Set<(request: RecordedRequest) => void>();
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

  async stop(): Promise<void> {
    for (const wake of this.waiters.splice(0)) wake();
    await this.server.stop(true);
  }

  push(update: Omit<Update, "update_id">): number {
    const id = this.nextUpdateId++;
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

  async waitForCalls(method: string, count = 1, timeoutMs = 5_000): Promise<RecordedRequest[]> {
    await this.waitForRequest((request) => request.method === method && this.calls(method).length >= count, timeoutMs);
    return this.calls(method);
  }

  async waitForRequest(matches: (request: RecordedRequest) => boolean, timeoutMs = 5_000): Promise<RecordedRequest> {
    const existing = this.requests.find(matches);
    if (existing) return existing;
    const next = Promise.withResolvers<RecordedRequest>();
    const receive = (request: RecordedRequest) => { if (matches(request)) next.resolve(request); };
    this.requestWaiters.add(receive);
    try {
      return await withTimeout(next.promise, timeoutMs, () => { throw new Error("Telegram request timed out"); });
    } finally {
      this.requestWaiters.delete(receive);
    }
  }

  private message(chatId: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const id = Number(chatId ?? 0);
    return {
      message_id: this.nextMessageId++,
      date: Math.floor(Date.now() / 1_000),
      chat: { id, type: id < 0 ? "supergroup" : "private", first_name: "Chat" },
      ...extra,
    };
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = url.pathname.split("/").at(-1)!;
    let payload: Record<string, any> = {};
    try { payload = await request.json() as Record<string, any>; } catch { /* empty body */ }
    this.requests.push({ method, payload });
    for (const receive of this.requestWaiters) receive({ method, payload });
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
        return ok({
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
      default:
        return ok(true);
    }
  }

  private async getUpdates(payload: Record<string, any>): Promise<Update[]> {
    const offset = Number(payload.offset ?? 0);
    while (this.queue.length && this.queue[0]!.update_id < offset) this.queue.shift();
    const pending = () => this.queue.filter((update) => update.update_id >= offset);
    const timeoutMs = Math.min(Number(payload.timeout ?? 0), 2) * 1_000;
    if (pending().length || timeoutMs <= 0) return pending();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => { clearTimeout(timer); resolve(); });
    });
    return pending();
  }
}
