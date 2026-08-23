import { describe, expect, test } from "bun:test";
import {
  createDraftId,
  splitIntoChunks,
  streamTelegramMessage,
  visibleEntities,
} from "../src/stream";

describe("stream helpers", () => {
  test("draft ids are always positive and non-zero", () => {
    for (let index = 0; index < 100; index++) {
      expect(createDraftId()).toBeGreaterThan(0);
    }
  });

  test("word chunks reconstruct the original text", () => {
    const text = "hello   streaming\nworld";
    expect(splitIntoChunks(text).join("")).toBe(text);
  });

  test("clips formatting entities to the visible draft", () => {
    const entities = [{ type: "bold" as const, offset: 6, length: 5 }];

    expect(visibleEntities(entities, 5)).toEqual([]);
    expect(visibleEntities(entities, 8)).toEqual([
      { type: "bold", offset: 6, length: 2 },
    ]);
    expect(visibleEntities(entities, 11)).toEqual(entities);
  });

  test("commits the complete streamed text", async () => {
    const calls: Array<{ method: string; text: string }> = [];
    const telegram = {
      async sendMessageDraft(_chatId: number, _draftId: number, text: string) {
        calls.push({ method: "draft", text });
        return true as const;
      },
      async sendMessage(_chatId: number, text: string) {
        calls.push({ method: "message", text });
        return {};
      },
    };

    async function* chunks() {
      yield "hello ";
      yield "world";
    }

    const result = await streamTelegramMessage({
      telegram: telegram as never,
      chatId: 123,
      chunks: chunks(),
      updateEveryMs: 800,
    });

    expect(result).toBe("hello world");
    expect(calls[0]).toEqual({ method: "draft", text: "" });
    expect(calls.at(-2)).toEqual({ method: "draft", text: "hello world" });
    expect(calls.at(-1)).toEqual({ method: "message", text: "hello world" });
  });
});
