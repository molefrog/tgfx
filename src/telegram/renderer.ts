import type { InputRichMessageWithoutUpload } from "grammy/types";
import type { RendererConfig, Route } from "../types";
import { AcpProjector } from "../fx/projector";
import { StateStore } from "../state";
import { TelegramApi, TelegramError } from "./api";

const KEEPALIVE_MS = 20_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000];

export function isRetryableTelegramError(error: unknown): boolean {
  if (!(error instanceof TelegramError)) return true;
  if (error.retryAfter !== undefined || error.errorCode === 429) return true;
  return error.errorCode === undefined || error.errorCode >= 500;
}

export function createDraftId(): number {
  return (crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff) || 1;
}

export function streamsRoute(config: RendererConfig, route: Route): boolean {
  return config.mode === "streaming" && route.chatKind === "private";
}

export function splitTelegramText(text: string, limit = 4_000): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let split = rest.lastIndexOf("\n\n", limit);
    if (split < limit / 2) split = rest.lastIndexOf("\n", limit);
    if (split < limit / 2) split = rest.lastIndexOf(" ", limit);
    if (split < limit / 2) split = limit;
    const code = rest.charCodeAt(split - 1);
    if (code >= 0xd800 && code <= 0xdbff) split--;
    parts.push(rest.slice(0, split).trimEnd());
    rest = rest.slice(split).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return Bun.sleep(milliseconds);
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Operation cancelled"));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Operation cancelled"));
    };
    function done() {
      signal!.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function retryTelegram<T>(
  operation: () => Promise<T>,
  markAttempt?: () => void,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      if (signal?.aborted) throw signal.reason ?? new Error("Operation cancelled");
      markAttempt?.();
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableTelegramError(error) || attempt === RETRY_DELAYS_MS.length) break;
      const seconds = error instanceof TelegramError ? error.retryAfter : undefined;
      await abortableSleep(seconds ? seconds * 1_000 : RETRY_DELAYS_MS[attempt]!, signal);
    }
  }
  throw lastError;
}

export class TurnRenderer {
  private revision = 0;
  private sentRevision = -1;
  private stopped = false;
  private lastDraftAt = 0;
  private pump?: Promise<void>;
  private draftFailed = false;
  private nextDraftAttemptAt = 0;
  private readonly draftId = createDraftId();
  private readonly draftAbort = new AbortController();

  constructor(
    private readonly api: TelegramApi,
    private readonly state: StateStore,
    private readonly route: Route,
    private readonly config: RendererConfig,
    private readonly projector: AcpProjector,
    private readonly signal?: AbortSignal,
  ) {}

  start(): void {
    if (!this.streaming || this.pump) return;
    this.pump = this.runPump();
  }

  changed(): void { this.revision++; }

  async abort(): Promise<void> {
    this.stopped = true;
    this.draftAbort.abort(new Error("draft stopped"));
    await this.pump;
  }

  private get streaming(): boolean {
    return streamsRoute(this.config, this.route);
  }

  private async runPump(): Promise<void> {
    while (!this.stopped) {
      const shouldSend = this.revision !== this.sentRevision
        || Date.now() - this.lastDraftAt >= KEEPALIVE_MS;
      if (shouldSend && !this.draftFailed && Date.now() >= this.nextDraftAttemptAt) {
        try {
          await this.api.sendRichDraft(
            this.route.chatId,
            this.draftId,
            this.projector.rich({ final: false, collapseTools: this.config.collapseTools }),
            this.draftAbort.signal,
          );
          this.sentRevision = this.revision;
          this.lastDraftAt = Date.now();
        } catch (error) {
          if (this.stopped) break;
          // Drafts keep only the newest frame. A transient failure schedules a
          // later snapshot instead of blocking ACP behind a retry sleep.
          if (isRetryableTelegramError(error)) {
            const retryAfter = error instanceof TelegramError ? error.retryAfter : undefined;
            this.nextDraftAttemptAt = Date.now() + (retryAfter ? retryAfter * 1_000 : 1_000);
          } else {
            this.draftFailed = true;
          }
        }
      }
      await abortableSleep(this.config.updateEveryMs, this.draftAbort.signal).catch(() => undefined);
    }
  }

  async finish(input: { botId: string; inboxId: number; effectKey: string }): Promise<string[]> {
    this.stopped = true;
    this.draftAbort.abort(new Error("draft finalized"));
    await this.pump;
    // Groups are final-only in v0.1, even when the workspace default streams
    // private chats. Tool timelines belong only to an actually streamed turn.
    const includeTools = this.streaming;
    const rich = this.projector.rich({
      final: true,
      collapseTools: this.config.collapseTools,
      includeTools,
    });
    const plain = this.projector.plainFinal(includeTools);
    const outboxId = this.state.createOutbox({
      effectKey: input.effectKey,
      botId: input.botId,
      routeKey: this.route.key,
      inboxId: input.inboxId,
      kind: "rich_final",
      payload: { chatId: this.route.chatId, topicId: this.route.topicId, rich, plain },
    });
    return this.deliver(outboxId, rich, plain);
  }

  private register(messageId: string): void {
    this.state.registerBotMessage({
      ref: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      botId: this.route.botId,
      routeKey: this.route.key,
      chatId: this.route.chatId,
      topicId: this.route.topicId,
      messageId,
    });
  }

  private async deliver(outboxId: number, rich: InputRichMessageWithoutUpload, plain: string): Promise<string[]> {
    this.state.markOutbox(outboxId, "sending");
    try {
      const message = await retryTelegram(
        () => this.api.sendRich(this.route.chatId, rich, this.route.topicId, {}, this.signal),
        () => this.state.markOutbox(outboxId, "sending"),
        this.signal,
      );
      const id = String(message.message_id);
      this.register(id);
      this.state.markOutbox(outboxId, "sent", id);
      return [id];
    } catch (richError) {
      // Older clients or chats may reject rich blocks. The compatibility path
      // is deliberately plain and semantically split; no response is truncated.
      const ids: string[] = [];
      try {
        for (const part of splitTelegramText(plain)) {
          const message = await retryTelegram(() => this.api.sendText(
            this.route.chatId, part, this.route.topicId, {}, this.signal,
          ), undefined, this.signal);
          const id = String(message.message_id);
          this.register(id);
          ids.push(id);
        }
        this.state.markOutbox(outboxId, "sent", ids.at(-1));
        return ids;
      } catch (fallbackError) {
        const reason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        this.state.markOutbox(outboxId, "failed", undefined, reason);
        throw new Error(`Unable to deliver Telegram response: ${reason}`, { cause: richError });
      }
    }
  }
}

export async function recoverOutbox(
  api: TelegramApi,
  state: StateStore,
  options: { routeKey?: string; includeFailed?: boolean } = {},
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const row of state.recoverableOutbox(options)) {
    const payload = JSON.parse(row.payload_json) as {
      chatId: string; topicId: string; rich?: InputRichMessageWithoutUpload; plain?: string; text?: string;
    };
    const route = state.route(row.route_key);
    const register = (messageId: string) => {
      if (!route) return;
      state.registerBotMessage({
        ref: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
        botId: row.bot_id,
        routeKey: row.route_key,
        chatId: payload.chatId,
        topicId: payload.topicId,
        messageId,
      });
    };
    try {
      state.markOutbox(row.id, "sending");
      if (payload.rich) {
        try {
          const message = await retryTelegram(() => api.sendRich(payload.chatId, payload.rich!, payload.topicId));
          const id = String(message.message_id);
          register(id);
          state.markOutbox(row.id, "sent", id);
          sent++;
          continue;
        } catch (richError) {
          if (payload.plain === undefined) throw richError;
        }
      }
      const ids: string[] = [];
      for (const part of splitTelegramText(payload.plain ?? payload.text ?? "Done.")) {
        const message = await retryTelegram(() => api.sendText(payload.chatId, part, payload.topicId));
        const id = String(message.message_id);
        register(id);
        ids.push(id);
      }
      state.markOutbox(row.id, "sent", ids.at(-1));
      sent++;
    } catch (error) {
      state.markOutbox(row.id, "failed", undefined, error instanceof Error ? error.message : String(error));
      failed++;
    }
  }
  return { sent, failed };
}
