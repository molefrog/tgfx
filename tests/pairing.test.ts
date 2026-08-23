import { describe, expect, test } from "bun:test";
import type { Update } from "grammy/types";
import { privatePairingFromUpdate } from "../src/telegram/pairing";

describe("first-run Telegram pairing", () => {
  test("accepts only the exact private deep-link payload", () => {
    const update = {
      update_id: 9,
      message: {
        message_id: 4, date: 1, text: "/start tgfx_ab12",
        chat: { id: 42, type: "private", first_name: "Ada" },
        from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" },
      },
    } as Update;
    expect(privatePairingFromUpdate(update, "tgfx_ab12")).toEqual({
      updateId: 9, userId: "42", chatId: "42", displayName: "Ada", username: "ada",
    });
    expect(privatePairingFromUpdate(update, "tgfx_wrong")).toBeUndefined();
  });

  test("rejects group and bot senders", () => {
    const base = {
      update_id: 9,
      message: {
        message_id: 4, date: 1, text: "/start tgfx_ab12",
        chat: { id: -42, type: "group", title: "Team" },
        from: { id: 42, is_bot: false, first_name: "Ada" },
      },
    } as Update;
    expect(privatePairingFromUpdate(base, "tgfx_ab12")).toBeUndefined();
  });
});
