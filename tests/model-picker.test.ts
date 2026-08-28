import { describe, expect, test } from "bun:test";
import {
  modelPicker,
  providerIconsFromStickerSet,
  providerPicker,
  selectedModel,
  type ModelPickerData,
} from "../src/telegram/model-picker";

const values = [
  "anthropic/claude-opus-5",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-luna-fast",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-sol-fast",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-terra-fast",
  "openai/gpt-5.5",
  "google/gemini-3.7-flash",
  "zai/glm-5.3",
  "moonshotai/kimi-k3",
  "deepseek/deepseek-v4-pro",
  "mistral/devstral-2",
  "alibaba/qwen3.8-max",
  "spacexai/grok-4.6",
];

const data: ModelPickerData = {
  interactionId: "12345678901234567890123456789012",
  currentValue: "openai/gpt-5.6-sol",
  options: values.map((value) => ({ value, name: value })),
};

describe("model picker", () => {
  test("paginates live providers with optional custom icons in a two-column grid", () => {
    const icons = providerIconsFromStickerSet(Array.from(
      { length: 18 },
      (_, index) => ({ custom_emoji_id: `emoji-${index + 1}` }),
    ));
    const first = providerPicker(data, 0, icons);
    expect(first.text).toContain("Current: <b>gpt-5.6-sol</b>");
    expect(first.text).not.toContain("choose a provider");
    expect(first.replyMarkup.inline_keyboard.flat().map((button) => button.text)).toContain("OpenAI · 7");
    expect(first.replyMarkup.inline_keyboard.flat().map((button) => button.text)).toContain("Next ›");
    expect(first.replyMarkup.inline_keyboard.flat().find((button) => button.text.startsWith("Anthropic")))
      .toMatchObject({ icon_custom_emoji_id: "emoji-2" });

    const second = providerPicker(data, 1, icons);
    expect(second.replyMarkup.inline_keyboard.flat().map((button) => button.text)).toContain("xAI · 1");
    expect(second.replyMarkup.inline_keyboard.flat().map((button) => button.text)).toContain("‹ Previous");
    expect(second.replyMarkup.inline_keyboard.flat().every((button) => button.callback_data.length <= 64)).toBeTrue();
    expect(second.replyMarkup.inline_keyboard.flat().find((button) => button.text.startsWith("xAI")))
      .toMatchObject({ icon_custom_emoji_id: "emoji-8" });

    const plain = providerPicker(data, 1);
    expect(plain.replyMarkup.inline_keyboard.flat().some((button) => "icon_custom_emoji_id" in button)).toBeFalse();
  });

  test("paginates models, marks the current value, and renders a terminal selection", () => {
    const icons = providerIconsFromStickerSet(Array.from(
      { length: 18 },
      (_, index) => ({ custom_emoji_id: `emoji-${index + 1}` }),
    ));
    const first = modelPicker(data, 1, 0, icons);
    expect(first?.text).toContain("Choose a model · OpenAI");
    expect(first?.replyMarkup.inline_keyboard[0]?.[0]?.text).toBe("gpt-5.6-luna");
    expect(first?.replyMarkup.inline_keyboard[2]?.[0]?.text).toBe("Current · gpt-5.6-sol");
    expect(first?.replyMarkup.inline_keyboard.flat().map((button) => button.text)).toContain("Next ›");
    expect(first?.replyMarkup.inline_keyboard.slice(0, 6).flat().every((button) =>
      button.icon_custom_emoji_id === "emoji-7"
    )).toBeTrue();

    const plain = modelPicker(data, 1);
    expect(plain?.replyMarkup.inline_keyboard.flat().some((button) => "icon_custom_emoji_id" in button)).toBeFalse();

    const selected = selectedModel(data.options[3]!);
    expect(selected.text).toBe("Model changed to\n\n<b>openai/gpt-5.6-sol</b>");
    expect(selected.replyMarkup.inline_keyboard).toEqual([]);
  });

  test("rejects an unknown provider index", () => {
    expect(modelPicker(data, 999)).toBeUndefined();
  });

  test("uses readable names for providers in the current FX catalog", () => {
    const icons = providerIconsFromStickerSet(Array.from(
      { length: 35 },
      (_, index) => ({ custom_emoji_id: `emoji-${index + 1}` }),
    ));
    const currentProviders: ModelPickerData = {
      ...data,
      options: [
        { value: "kwaipilot/kat-coder-pro-v2.5", name: "kwaipilot/kat-coder-pro-v2.5" },
        { value: "thinkingmachines/inkling", name: "thinkingmachines/inkling" },
        { value: "inception/mercury-2", name: "inception/mercury-2" },
        { value: "arcee-ai/trinity-large-thinking", name: "arcee-ai/trinity-large-thinking" },
      ],
    };
    const buttons = providerPicker(currentProviders, 0, icons).replyMarkup.inline_keyboard.flat();
    expect(buttons.map((button) => button.text)).toEqual(expect.arrayContaining([
        "KwaiPilot · 1",
        "Thinking Machines · 1",
        "Inception Labs · 1",
        "Arcee AI · 1",
      ]));
    expect(buttons.find((button) => button.text.startsWith("KwaiPilot")))
      .toMatchObject({ icon_custom_emoji_id: "emoji-19" });
    expect(buttons.find((button) => button.text.startsWith("Inception Labs")))
      .toMatchObject({ icon_custom_emoji_id: "emoji-25" });
    expect(buttons.find((button) => button.text.startsWith("Arcee AI")))
      .toMatchObject({ icon_custom_emoji_id: "emoji-24" });
    expect(buttons.find((button) => button.text.startsWith("Thinking Machines")))
      .toMatchObject({ icon_custom_emoji_id: "emoji-33" });
  });

  test("infers providers when FX returns narrowed unqualified model values", () => {
    const icons = providerIconsFromStickerSet(Array.from(
      { length: 36 },
      (_, index) => ({ custom_emoji_id: `emoji-${index + 1}` }),
    ));
    const narrowed: ModelPickerData = {
      interactionId: "narrowed",
      currentValue: "deepseek/deepseek-v3.2",
      options: [
        { value: "grok-4.6", name: "grok-4.6" },
        { value: "grok-4.5", name: "grok-4.5" },
        { value: "gpt-5.6-sol", name: "gpt-5.6-sol" },
        { value: "deepseek/deepseek-v3.2", name: "deepseek/deepseek-v3.2" },
      ],
    };
    const buttons = providerPicker(narrowed, 0, icons).replyMarkup.inline_keyboard.flat();
    expect(buttons.find((button) => button.text === "xAI · 2"))
      .toMatchObject({ icon_custom_emoji_id: "emoji-8" });
    expect(buttons.find((button) => button.text === "Codex · 1"))
      .toMatchObject({ icon_custom_emoji_id: "emoji-36" });
    expect(buttons.find((button) => button.text === "DeepSeek · 1"))
      .toMatchObject({ icon_custom_emoji_id: "emoji-3" });
  });

  test("uses bundled IDs while Telegram returns a stale shorter pack snapshot", () => {
    const stale = providerIconsFromStickerSet(Array.from(
      { length: 31 },
      (_, index) => ({ custom_emoji_id: `remote-${index + 1}` }),
    ));
    expect(stale.morph).toBe("remote-31");
    expect(stale.sakana).toBe("5226456375772618542");
    expect(stale.thinkingmachines).toBe("5226528183330838677");
    expect(stale.inclusionai).toBe("5229191144658739880");
    expect(stale.interfaze).toBe("5229187485346606266");
    expect(stale.codex).toBe("5229233944007844947");
  });
});
