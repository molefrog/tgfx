import { describe, expect, test } from "bun:test";
import { replyStylePicker } from "../src/telegram/reply-style";
import { OUTPUT_MODES, REPLY_STYLES } from "../src/types";

describe("reply style picker", () => {
  test("lays the four styles out as a 2×2 grid of fmt buttons", () => {
    const rows = replyStylePicker("live").replyMarkup.inline_keyboard;
    expect(rows.map((row) => row.length)).toEqual([2, 2]);
    expect(rows.flat().map((button) => button.callback_data)).toEqual(OUTPUT_MODES.map((mode) => `fmt:${mode}`));
  });

  test("ticks the current style in the text and on its button", () => {
    for (const mode of OUTPUT_MODES) {
      const view = replyStylePicker(mode);
      const ticked = view.replyMarkup.inline_keyboard.flat().filter((button) => button.text.startsWith("✓"));
      expect(ticked.map((button) => button.text)).toEqual([`✓ ${REPLY_STYLES[mode].name}`]);
      expect(view.text).toContain(`✓ <b>${REPLY_STYLES[mode].name}</b>`);
    }
  });

  test("names every style with its hint", () => {
    const { text } = replyStylePicker("answer");
    expect(text.split("\n")[0]).toContain("Reply style");
    for (const style of Object.values(REPLY_STYLES)) expect(text).toContain(style.hint);
  });
});
