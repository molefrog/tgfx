import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state";
import { createDraftId, isRetryableTelegramError, recoverOutbox, splitTelegramText, streamsRoute } from "../src/telegram/renderer";
import { TelegramApi, TelegramError } from "../src/telegram/api";

describe("Telegram renderer boundaries", () => {
  test("uses non-zero signed draft IDs", () => {
    for (let index = 0; index < 100; index++) {
      const id = createDraftId();
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThanOrEqual(0x7fffffff);
    }
  });

  test("streams only private routes", () => {
    const config = { mode: "streaming" as const, collapseTools: true, updateEveryMs: 800 };
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

  test("recovers a permanent rich-message rejection through the persisted plain fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tgfx-renderer-"));
    const state = new StateStore(join(directory, "state.sqlite"));
    try {
      state.registerBot({ id: "1", displayName: "Bot" });
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
      expect(state.pendingOutbox()).toHaveLength(0);
      expect(state.messageReferenceByTelegramId("1", "2", "91")?.owned_by_bot).toBe(1);
    } finally {
      state.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
