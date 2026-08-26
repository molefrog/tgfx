export type DraftPriority = "normal" | "high" | "immediate";

export type PeerDraftLimiterOptions = {
  minGapMs?: number;
  shortWindowMs?: number;
  shortLimit?: number;
  longWindowMs?: number;
  longLimit?: number;
  optimisticBurstLimit?: number;
  steadyGapMs?: number;
};

/**
 * Telegram applies live-draft limits per peer, not per generated response.
 * Keep a shared rolling history for the chat and stay below Telegram's public
 * 20/5s and 40/30s ceilings with two calls of headroom in each window.
 */
export class PeerDraftLimiter {
  private readonly minGapMs: number;
  private readonly shortWindowMs: number;
  private readonly shortLimit: number;
  private readonly longWindowMs: number;
  private readonly longLimit: number;
  private readonly optimisticBurstLimit: number;
  private readonly steadyGapMs: number;
  private attempts: number[] = [];
  private blockedUntil = 0;
  private penaltyMs = 0;

  constructor(options: PeerDraftLimiterOptions = {}) {
    this.minGapMs = options.minGapMs ?? 250;
    this.shortWindowMs = options.shortWindowMs ?? 5_000;
    this.shortLimit = options.shortLimit ?? 18;
    this.longWindowMs = options.longWindowMs ?? 30_000;
    this.longLimit = options.longLimit ?? 36;
    this.optimisticBurstLimit = options.optimisticBurstLimit ?? 10;
    this.steadyGapMs = options.steadyGapMs
      ?? Math.ceil(this.longWindowMs / this.longLimit);
  }

  nextAllowedAt(requestedAt: number, bypassSpacing = false): number {
    this.prune(requestedAt);
    let allowedAt = Math.max(requestedAt, this.blockedUntil);
    const lastAttempt = this.attempts.at(-1);
    if (!bypassSpacing && lastAttempt !== undefined) {
      allowedAt = Math.max(allowedAt, lastAttempt + this.minGapMs + this.penaltyMs);
    }

    const shortAttempts = this.attempts.filter(
      (attempt) => attempt > allowedAt - this.shortWindowMs,
    );
    if (shortAttempts.length >= this.shortLimit) {
      allowedAt = Math.max(
        allowedAt,
        shortAttempts[shortAttempts.length - this.shortLimit]! + this.shortWindowMs,
      );
    }
    const longAttempts = this.attempts.filter(
      (attempt) => attempt > allowedAt - this.longWindowMs,
    );
    if (longAttempts.length >= this.longLimit) {
      allowedAt = Math.max(
        allowedAt,
        longAttempts[longAttempts.length - this.longLimit]! + this.longWindowMs,
      );
    }

    // Spend a small opening burst on short answers, then amortize that burst
    // over the rest of the rolling window. This approaches the sustainable
    // cadence smoothly instead of exhausting the budget and hitting a long
    // hard-limit pause.
    const pacedAttempts = this.attempts.filter(
      (attempt) => attempt > allowedAt - this.longWindowMs,
    );
    if (lastAttempt !== undefined && pacedAttempts.length >= this.optimisticBurstLimit) {
      const remainingCalls = Math.max(1, this.longLimit - pacedAttempts.length);
      const remainingWindowMs = Math.max(
        0,
        pacedAttempts[0]! + this.longWindowMs - allowedAt,
      );
      const adaptiveGapMs = Math.max(
        this.steadyGapMs,
        Math.ceil(remainingWindowMs / remainingCalls),
      );
      allowedAt = Math.max(allowedAt, lastAttempt + adaptiveGapMs + this.penaltyMs);
    }
    return allowedAt;
  }

  recordAttempt(now: number): void {
    this.prune(now);
    this.attempts.push(now);
  }

  recordSuccess(): void {
    this.penaltyMs = Math.max(0, this.penaltyMs - 25);
  }

  recordFlood(now: number, retryAfterMs: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, now + Math.max(1_000, retryAfterMs));
    this.penaltyMs = Math.min(1_000, this.penaltyMs ? Math.ceil(this.penaltyMs * 1.5) : 100);
  }

  private prune(now: number): void {
    const cutoff = now - this.longWindowMs;
    this.attempts = this.attempts.filter((attempt) => attempt > cutoff);
  }
}

type DraftFrame<T> = {
  value: T;
  fingerprint: string;
  priority: DraftPriority;
};

type SchedulerOptions<T> = {
  limiter: PeerDraftLimiter;
  send(value: T): Promise<unknown>;
  retryDelay(error: unknown): number | false;
  fingerprint?(value: T): string;
  coalesceMs?: number;
  keepaliveMs?: number;
};

const PRIORITY: Record<DraftPriority, number> = {
  normal: 0,
  high: 1,
  immediate: 2,
};

/**
 * React-style draft commit loop: callers offer complete rendered trees, equal
 * trees bail out, and only the latest pending tree is committed. A frame that
 * arrives during an in-flight request remains pending until it is actually sent.
 */
export class AdaptiveDraftScheduler<T> {
  private readonly fingerprint: (value: T) => string;
  private readonly coalesceMs: number;
  private readonly keepaliveMs: number;
  private pending?: DraftFrame<T>;
  private sending?: DraftFrame<T>;
  private committed?: DraftFrame<T>;
  private committedAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt = Number.POSITIVE_INFINITY;
  private inFlight?: Promise<void>;
  private closed = false;
  private failed = false;

  constructor(private readonly options: SchedulerOptions<T>) {
    this.fingerprint = options.fingerprint ?? ((value) => JSON.stringify(value));
    this.coalesceMs = options.coalesceMs ?? 40;
    this.keepaliveMs = options.keepaliveMs ?? 20_000;
  }

  start(value: T): void {
    this.offer(value, "immediate");
  }

  offer(value: T, priority: DraftPriority = "normal"): boolean {
    if (this.closed || this.failed) return false;
    const fingerprint = this.fingerprint(value);

    if (this.sending?.fingerprint === fingerprint) {
      this.pending = undefined;
      return false;
    }
    if (this.committed?.fingerprint === fingerprint) {
      if (this.sending) {
        this.pending = { value, fingerprint, priority };
        return true;
      }
      this.pending = undefined;
      this.clearTimer();
      this.armKeepalive();
      return false;
    }
    if (this.pending?.fingerprint === fingerprint) {
      if (PRIORITY[priority] > PRIORITY[this.pending.priority]) this.pending.priority = priority;
    } else {
      this.pending = { value, fingerprint, priority };
    }
    this.schedule(this.pending.priority);
    return true;
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.clearTimer();
    await this.inFlight;
  }

  private schedule(priority: DraftPriority): void {
    if (this.closed || this.failed || this.inFlight || !this.pending) return;
    const now = Date.now();
    const desiredAt = now + (priority === "normal" ? this.coalesceMs : 0);
    const allowedAt = this.options.limiter.nextAllowedAt(
      desiredAt,
      priority === "immediate",
    );
    if (allowedAt <= now) {
      this.clearTimer();
      this.onTimer();
      return;
    }
    this.arm(allowedAt);
  }

  private arm(when: number): void {
    if (this.timer && this.timerAt <= when) return;
    this.clearTimer();
    this.timerAt = when;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerAt = Number.POSITIVE_INFINITY;
      this.onTimer();
    }, Math.max(0, when - Date.now()));
  }

  private onTimer(): void {
    if (this.closed || this.failed || this.inFlight) return;
    if (!this.pending && this.committed) {
      this.pending = { ...this.committed, priority: "high" };
    }
    if (!this.pending) return;

    // Another turn can share this peer limiter, so re-check at commit time even
    // when this timer was legal when it was first armed.
    const now = Date.now();
    const allowedAt = this.options.limiter.nextAllowedAt(
      now,
      this.pending.priority === "immediate",
    );
    if (allowedAt > now) {
      this.arm(allowedAt);
      return;
    }

    this.inFlight = this.flush().finally(() => {
      this.inFlight = undefined;
      if (this.closed || this.failed) return;
      if (this.pending) this.schedule(this.pending.priority);
      else this.armKeepalive();
    });
  }

  private armKeepalive(): void {
    if (this.closed || this.failed || this.inFlight || this.pending || !this.committed) return;
    this.arm(this.committedAt + this.keepaliveMs);
  }

  private async flush(): Promise<void> {
    const frame = this.pending;
    if (!frame || this.closed || this.failed) return;
    this.pending = undefined;
    this.sending = frame;
    this.options.limiter.recordAttempt(Date.now());
    try {
      await this.options.send(frame.value);
      this.options.limiter.recordSuccess();
      this.committed = frame;
      this.committedAt = Date.now();
    } catch (error) {
      if (this.closed) return;
      const retryAfterMs = this.options.retryDelay(error);
      if (retryAfterMs === false) {
        this.failed = true;
        this.pending = undefined;
      } else {
        this.options.limiter.recordFlood(Date.now(), retryAfterMs);
        if (!this.pending) this.pending = frame;
      }
    } finally {
      this.sending = undefined;
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerAt = Number.POSITIVE_INFINITY;
  }
}
