import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state";
import { AcpProjector } from "../src/fx/projector";
import { AdaptiveDraftScheduler, PeerDraftLimiter } from "../src/telegram/draft-scheduler";
import { createDraftId, isRetryableTelegramError, recoverOutbox, splitTelegramText, streamsRoute, TurnRenderer } from "../src/telegram/renderer";
import { TelegramApi, TelegramError } from "../src/telegram/api";

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(1);
  }
}

describe("Telegram renderer boundaries", () => {
  test("uses non-zero signed draft IDs", () => {
    for (let index = 0; index < 100; index++) {
      const id = createDraftId();
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(0x7fffffff);
    }
  });

  test("streams only private routes", () => {
    const config = { mode: "streaming" as const, expandStreamingTools: true, updateEveryMs: 800 };
    expect(streamsRoute(config, {
      key: "1:2:0", botId: "1", chatId: "2", topicId: "0", chatKind: "private",
    })).toBeTrue();
    expect(streamsRoute(config, {
      key: "1:-2:0", botId: "1", chatId: "-2", topicId: "0", chatKind: "supergroup",
    })).toBeFalse();
    expect(streamsRoute({ ...config, mode: "final" }, {
      key: "1:2:0", botId: "1", chatId: "2", topicId: "0", chatKind: "private",
    })).toBeFalse();
  });

  test("includes labeled, collapsed tool groups in a non-streaming final message", async () => {
    const sent: Array<{ blocks?: unknown[] }> = [];
    const api = {
      sendRich: async (_chatId: string, rich: { blocks?: unknown[] }) => {
        sent.push(rich);
        return { message_id: 42 };
      },
    } as unknown as TelegramApi;
    const state = {
      createOutbox: () => 1,
      markOutbox: () => undefined,
      registerBotMessage: () => undefined,
    } as unknown as StateStore;
    const projector = new AcpProjector();
    projector.apply({
      sessionUpdate: "tool_call",
      toolCallId: "tests",
      name: "shell",
      title: "Running",
      kind: "execute",
      status: "completed",
      rawInput: { action: "run", command: "bun test" },
    } as never);
    const renderer = new TurnRenderer(
      api,
      state,
      { key: "1:2:0", botId: "1", chatId: "2", topicId: "0", chatKind: "private" },
      { mode: "final", expandStreamingTools: true, updateEveryMs: 800 },
      projector,
    );

    await renderer.finish({ botId: "1", inboxId: 1, effectKey: "final:1:1" });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.blocks).toEqual([{
      type: "details",
      summary: "Ran 1 command",
      blocks: [{ type: "paragraph", text: ["Running command", " ", { type: "code", text: "bun test" }] }],
    }]);
  });

  test("splits final messages without truncation or broken surrogate pairs", () => {
    const text = `${"word ".repeat(900)}😀${" tail".repeat(500)}`;
    const parts = splitTelegramText(text, 500);
    expect(parts.every((part) => part.length <= 500)).toBeTrue();
    expect(parts.join(" ").replaceAll(/\s+/g, " ").trim()).toBe(text.replaceAll(/\s+/g, " ").trim());
    expect(parts.some((part) => part.includes("😀"))).toBeTrue();
  });

  test("retries network, rate-limit, and server failures but not permanent Bot API errors", () => {
    expect(isRetryableTelegramError(new Error("network"))).toBeTrue();
    expect(isRetryableTelegramError(new TelegramError("network"))).toBeTrue();
    expect(isRetryableTelegramError(new TelegramError("rate", 2, 429))).toBeTrue();
    expect(isRetryableTelegramError(new TelegramError("server", undefined, 500))).toBeTrue();
    expect(isRetryableTelegramError(new TelegramError("bad request", undefined, 400))).toBeFalse();
    expect(isRetryableTelegramError(new TelegramError("unauthorized", undefined, 401))).toBeFalse();
  });

  test("keeps hard Telegram draft windows as safety rails", () => {
    const short = new PeerDraftLimiter({ optimisticBurstLimit: 100 });
    for (let index = 0; index < 18; index++) short.recordAttempt(index * 250);
    expect(short.nextAllowedAt(4_250)).toBe(5_000);

    const long = new PeerDraftLimiter({
      minGapMs: 0,
      shortLimit: 100,
      optimisticBurstLimit: 100,
    });
    for (let index = 0; index < 36; index++) long.recordAttempt(index * 800);
    expect(long.nextAllowedAt(28_000)).toBe(30_000);
  });

  test("smoothly amortizes an optimistic burst instead of hitting a limit cliff", () => {
    const limiter = new PeerDraftLimiter();
    const attempts: number[] = [];
    let now = 0;
    for (let index = 0; index < 50; index++) {
      now = limiter.nextAllowedAt(now);
      limiter.recordAttempt(now);
      attempts.push(now);
    }

    expect(attempts.slice(0, 10)).toEqual([
      0, 250, 500, 750, 1_000, 1_250, 1_500, 1_750, 2_000, 2_250,
    ]);
    const gaps = attempts.slice(1).map((attempt, index) => attempt - attempts[index]!);
    expect(Math.max(...gaps)).toBeLessThan(1_500);
    expect(attempts.filter((attempt) => attempt < 30_000)).toHaveLength(36);
    expect(attempts[36]! - attempts[35]!).toBe(834);
  });

  test("adapts after a flood response", () => {
    const flooded = new PeerDraftLimiter();
    flooded.recordAttempt(0);
    flooded.recordFlood(100, 1_500);
    expect(flooded.nextAllowedAt(100)).toBe(1_600);
  });

  test("commits only the newest snapshot without losing in-flight changes", async () => {
    const sends: string[] = [];
    let releaseSecond!: () => void;
    const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const scheduler = new AdaptiveDraftScheduler<string>({
      limiter: new PeerDraftLimiter({ minGapMs: 0, shortLimit: 100, longLimit: 100 }),
      keepaliveMs: 60_000,
      coalesceMs: 0,
      retryDelay: () => false,
      send: async (value) => {
        sends.push(value);
        if (value === "second") await second;
      },
    });

    scheduler.start("first");
    await waitFor(() => sends.length === 1);
    scheduler.offer("second", "immediate");
    await waitFor(() => sends.length === 2);
    scheduler.offer("stale", "immediate");
    scheduler.offer("first", "immediate");
    releaseSecond();
    await waitFor(() => sends.length === 3);
    expect(sends).toEqual(["first", "second", "first"]);

    scheduler.offer("first", "immediate");
    await Bun.sleep(10);
    expect(sends).toHaveLength(3);
    await scheduler.stop();
  });

  test("does not render hidden thought or pending-tool updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tgfx-hidden-drafts-"));
    const state = new StateStore(join(directory, "state.sqlite"));
    const drafts: unknown[] = [];
    const api = {
      sendRichDraft: async (_chatId: string, _draftId: number, rich: unknown) => {
        drafts.push(rich);
      },
    } as unknown as TelegramApi;
    const projector = new AcpProjector();
    const renderer = new TurnRenderer(
      api,
      state,
      { key: "1:2:0", botId: "1", chatId: "2", topicId: "0", chatKind: "private" },
      { mode: "streaming", expandStreamingTools: true, updateEveryMs: 0 },
      projector,
      undefined,
      new PeerDraftLimiter({ minGapMs: 0, shortLimit: 100, longLimit: 100 }),
    );
    try {
      renderer.start();
      await waitFor(() => drafts.length === 1);
      renderer.changed(projector.apply({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "private reasoning" },
      }));
      renderer.changed(projector.apply({
        sessionUpdate: "tool_call",
        toolCallId: "pending",
        title: "Pending tool",
        status: "in_progress",
        content: [],
      }));
      await Bun.sleep(10);
      expect(drafts).toHaveLength(1);

      renderer.changed(projector.apply({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Visible answer." },
      }));
      await waitFor(() => drafts.length === 2);
    } finally {
      await renderer.abort();
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("stops the draft stream immediately when the turn is aborted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tgfx-stopped-drafts-"));
    const state = new StateStore(join(directory, "state.sqlite"));
    const drafts: unknown[] = [];
    let draftSignal: AbortSignal | undefined;
    const api = {
      sendRichDraft: async (
        _chatId: string,
        _draftId: number,
        rich: unknown,
        signal?: AbortSignal,
      ) => {
        drafts.push(rich);
        draftSignal = signal;
      },
    } as unknown as TelegramApi;
    const projector = new AcpProjector();
    const turn = new AbortController();
    const renderer = new TurnRenderer(
      api,
      state,
      { key: "1:2:0", botId: "1", chatId: "2", topicId: "0", chatKind: "private" },
      { mode: "streaming", expandStreamingTools: true, updateEveryMs: 0 },
      projector,
      turn.signal,
      new PeerDraftLimiter({ minGapMs: 0, shortLimit: 100, longLimit: 100 }),
    );
    try {
      renderer.start();
      await waitFor(() => drafts.length === 1);

      turn.abort(new Error("stopped by user"));
      expect(draftSignal?.aborted).toBeTrue();

      renderer.changed(projector.apply({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Late output after Stop." },
      }));
      await Bun.sleep(10);
      expect(drafts).toHaveLength(1);
    } finally {
      await renderer.abort();
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("recovers a permanent rich-message rejection through the persisted plain fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tgfx-renderer-"));
    const state = new StateStore(join(directory, "state.sqlite"));
    try {
      state.ensurePollState("1");
      state.ensureRoute({ key: "1:2:0", botId: "1", chatId: "2", topicId: "0", chatKind: "private" });
      state.createOutbox({
        effectKey: "final:1:1", botId: "1", routeKey: "1:2:0", kind: "rich_final",
        payload: { chatId: "2", topicId: "0", rich: { blocks: [] }, plain: "Recovered answer" },
      });
      const sent: string[] = [];
      const api = {
        sendRich: async () => { throw new TelegramError("unsupported", undefined, 400); },
        sendText: async (_chat: string, text: string) => {
          sent.push(text);
          return { message_id: 91 };
        },
      } as unknown as TelegramApi;

      await recoverOutbox(api, state);

      expect(sent).toEqual(["Recovered answer"]);
      expect(state.recoverableOutbox()).toHaveLength(0);
      expect(state.messageReferenceByTelegramId("1", "2", "91")?.owned_by_bot).toBe(1);
    } finally {
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
