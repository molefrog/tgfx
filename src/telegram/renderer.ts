import type { InputRichMessageWithoutUpload } from "grammy/types";
import { setTimeout as delay } from "node:timers/promises";
import type { RendererConfig, Route } from "../types";
import { AcpProjector, type ProjectorChange } from "../fx/projector";
import { StateStore } from "../state";
import { TelegramApi, TelegramError } from "./api";
import { AdaptiveDraftScheduler, PeerDraftLimiter, type DraftPriority } from "./draft-scheduler";

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
      await delay(seconds ? seconds * 1_000 : RETRY_DELAYS_MS[attempt]!, undefined, { signal });
    }
  }
  throw lastError;
}

export class TurnRenderer {
  private stopped = false;
  private visibleOutput = false;
  readonly draftId = createDraftId();
  private readonly draftAbort = new AbortController();
  private readonly drafts: AdaptiveDraftScheduler<InputRichMessageWithoutUpload>;

  constructor(
    private readonly api: TelegramApi,
    private readonly state: StateStore,
    private readonly route: Route,
    private readonly config: RendererConfig,
    private readonly projector: AcpProjector,
    private readonly signal?: AbortSignal,
    limiter = new PeerDraftLimiter({ minGapMs: config.updateEveryMs }),
  ) {
    this.drafts = new AdaptiveDraftScheduler({
      limiter,
      send: (rich) => this.api.sendRichDraft(
        this.route.chatId,
        this.draftId,
        rich,
        this.draftAbort.signal,
      ),
      retryDelay: (error) => {
        if (!isRetryableTelegramError(error)) return false;
        return error instanceof TelegramError && error.retryAfter !== undefined
          ? error.retryAfter * 1_000
          : 1_000;
      },
    });
  }

  start(): void {
    if (!this.streaming || this.stopped) return;
    this.drafts.start(this.projector.rich({
      final: false,
      collapseTools: this.config.collapseTools,
      expandStreamingTools: this.config.expandStreamingTools,
    }));
  }

  changed(change: ProjectorChange): void {
    if (!this.streaming || change === "none" || this.stopped) return;
    const priority: DraftPriority = !this.visibleOutput
      ? "immediate"
      : change === "boundary" || change === "tool" ? "high" : "normal";
    this.visibleOutput = true;
    this.drafts.offer(this.projector.rich({
      final: false,
      collapseTools: this.config.collapseTools,
      expandStreamingTools: this.config.expandStreamingTools,
    }), priority);
  }

  async abort(): Promise<void> {
    this.stopped = true;
    this.draftAbort.abort(new Error("draft stopped"));
    await this.drafts.stop();
  }

  private get streaming(): boolean {
    return streamsRoute(this.config, this.route);
  }

  async finish(input: { botId: string; inboxId: number; effectKey: string }): Promise<string[]> {
    this.stopped = true;
    this.draftAbort.abort(new Error("draft finalized"));
    await this.drafts.stop();
    // Groups are final-only in v0.1, even when the workspace default streams
    // private chats. Tool timelines belong only to an actually streamed turn.
    const includeTools = this.streaming;
    const rich = this.projector.rich({
      final: true,
      collapseTools: this.config.collapseTools,
      expandStreamingTools: this.config.expandStreamingTools,
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
