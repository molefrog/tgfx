import { describe, expect, test } from "bun:test";
import { customIcons, TGFX_CUSTOM_ICONS, TGFX_CUSTOM_ICON_SET } from "../src/telegram/custom-icon-set";

describe("tgfx custom icon catalog", () => {
  test("declares the complete public pack in exact Telegram order", () => {
    expect(TGFX_CUSTOM_ICON_SET).toEqual({
      name: "ai_provider_labs_by_fxharness_bot",
      title: "tgfx icons",
      url: "https://t.me/addemoji/ai_provider_labs_by_fxharness_bot",
      ownerBot: "fxharness_bot",
    });
    expect(TGFX_CUSTOM_ICONS).toHaveLength(159);
    expect(customIcons("provider")).toHaveLength(36);
    expect(customIcons("mcp")).toHaveLength(103);
    expect(customIcons("tool")).toHaveLength(20);
    expect(TGFX_CUSTOM_ICONS.map((icon) => icon.position)).toEqual(
      Array.from({ length: 159 }, (_, position) => position),
    );
  });

  test("keeps every image, identity, and stable custom emoji ID unique", () => {
    for (const field of ["id", "image", "customEmojiId"] as const) {
      const values = TGFX_CUSTOM_ICONS.map((icon) => icon[field]);
      expect(new Set(values).size).toBe(values.length);
    }
  });
});
