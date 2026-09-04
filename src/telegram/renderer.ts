import type { InputRichMessageWithoutUpload } from "grammy/types";
import { setTimeout as delay } from "node:timers/promises";
import type { OutputMode, Route } from "../types";
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

/** Whether a mode drafts at all; groups never see drafts, whatever the mode. */
export function streams(output: OutputMode): boolean {
  return output === "live" || output === "progress";
}

export function streamsRoute(output: OutputMode, route: Route): boolean {
  return streams(output) && route.chatKind === "private";
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

export type TurnRendererOptions = {
  /** Receives one line per failed draft frame. */
  log?: (detail: string) => void;
  /**
   * Telegram clients type draft changes in with a speed learned from how often
   * frames arrive, and a frame that repeats after a long silence resets the
   * whole block. While a tool group is the newest thing on screen, re-render
   * this often so its elapsed counter grows at the tail and nothing before it
   * is redrawn. Progress mode ticks faster: its frames are one short line.
   */
  heartbeatMs?: number;
  keepaliveMs?: number;
  /** How often a turn without a draft renews Telegram's "typing…" status. */
  typingMs?: number;
};

const HEARTBEAT_MS = 3_000;
const PROGRESS_HEARTBEAT_MS = 1_000;
/** Telegram clears the status after about five seconds, so renew it before then. */
const TYPING_MS = 4_000;

export class TurnRenderer {
  private stopped = false;
  private visibleOutput = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private typing?: ReturnType<typeof setInterval>;
  readonly draftId = createDraftId();
  private readonly draftAbort = new AbortController();
  private readonly drafts: AdaptiveDraftScheduler<InputRichMessageWithoutUpload>;
  private readonly stopOnTurnAbort = () => { void this.abort(); };

  constructor(
    private readonly api: TelegramApi,
    private readonly state: StateStore,
    private readonly route: Route,
    private readonly output: OutputMode,
    private readonly projector: AcpProjector,
    private readonly signal?: AbortSignal,
    limiter = new PeerDraftLimiter(),
    private readonly options: TurnRendererOptions = {},
  ) {
    this.drafts = new AdaptiveDraftScheduler({
      limiter,
      ...(options.keepaliveMs === undefined ? {} : { keepaliveMs: options.keepaliveMs }),
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
      onError: (error, gaveUp) => {
        if (this.stopped) return;
        const reason = error instanceof Error ? error.message : String(error);
        this.options.log?.(`draft frame failed${gaveUp ? "; draft streaming stopped for this turn" : ""} · ${reason}`);
      },
    });
    if (this.signal?.aborted) this.stopOnTurnAbort();
    else this.signal?.addEventListener("abort", this.stopOnTurnAbort, { once: true });
  }

  private frame(): InputRichMessageWithoutUpload {
    return this.projector.rich({ final: false, output: this.output });
  }

  start(): void {
    if (this.stopped) return;
    if (!this.streaming) {
      // Nothing shows until the final message, so say that someone is working on it.
      const type = () => {
        if (this.stopped) return;
        Promise.resolve()
          .then(() => this.api.sendTyping(this.route.chatId, this.route.topicId, this.draftAbort.signal))
          .catch(() => undefined);
      };
      type();
      this.typing = setInterval(type, this.options.typingMs ?? TYPING_MS);
      return;
    }
    this.drafts.start(this.frame());
    this.heartbeat = setInterval(() => {
      if (!this.stopped) this.drafts.offer(this.frame(), "normal");
    }, this.options.heartbeatMs ?? (this.output === "progress" ? PROGRESS_HEARTBEAT_MS : HEARTBEAT_MS));
  }

  changed(change: ProjectorChange): void {
    if (!this.streaming || change === "none" || this.stopped) return;
    const priority: DraftPriority = !this.visibleOutput
      ? "immediate"
      : change === "boundary" || change === "tool" ? "high" : "normal";
    this.visibleOutput = true;
    this.drafts.offer(this.frame(), priority);
  }

  private stopDrafts(reason: string): Promise<void> {
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearInterval(this.typing);
    this.heartbeat = undefined;
    this.typing = undefined;
    this.draftAbort.abort(new Error(reason));
    return this.drafts.stop();
  }

  async abort(): Promise<void> {
    this.signal?.removeEventListener("abort", this.stopOnTurnAbort);
    await this.stopDrafts("draft stopped");
  }

  private get streaming(): boolean {
    return streamsRoute(this.output, this.route);
  }

  async finish(input: { botId: string; inboxId: number; effectKey: string }): Promise<string[]> {
    await this.stopDrafts("draft finalized");
    const rich = this.projector.rich({ final: true, output: this.output });
    const plain = this.projector.plainFinal(this.output);
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

  private register(messageId: string, excerpt?: string): void {
    this.state.registerBotMessage({
      ref: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      botId: this.route.botId,
      routeKey: this.route.key,
      chatId: this.route.chatId,
      topicId: this.route.topicId,
      messageId,
      ...(excerpt ? { excerpt } : {}),
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
      this.register(id, plain);
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
          this.register(id, part);
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
    const register = (messageId: string, excerpt?: string) => {
      if (!route) return;
      state.registerBotMessage({
        ref: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
        botId: row.bot_id,
        routeKey: row.route_key,
        chatId: payload.chatId,
        topicId: payload.topicId,
        messageId,
        ...(excerpt ? { excerpt } : {}),
      });
    };
    try {
      state.markOutbox(row.id, "sending");
      if (payload.rich) {
        try {
          const message = await retryTelegram(() => api.sendRich(payload.chatId, payload.rich!, payload.topicId));
          const id = String(message.message_id);
          register(id, payload.plain ?? payload.text);
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
        register(id, part);
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
