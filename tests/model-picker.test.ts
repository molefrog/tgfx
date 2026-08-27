import { describe, expect, test } from "bun:test";
import { modelPicker, providerPicker, selectedModel, type ModelPickerData } from "../src/telegram/model-picker";

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
  test("paginates live providers in a two-column grid", () => {
    const first = providerPicker(data);
    expect(first.text).toContain("Current: gpt-5.6-sol");
    expect(first.replyMarkup.inline_keyboard.flat().map((button) => button.text)).toContain("OpenAI · 7");
    expect(first.replyMarkup.inline_keyboard.flat().map((button) => button.text)).toContain("Next ›");

    const second = providerPicker(data, 1);
    expect(second.replyMarkup.inline_keyboard.flat().map((button) => button.text)).toContain("xAI · 1");
    expect(second.replyMarkup.inline_keyboard.flat().map((button) => button.text)).toContain("‹ Previous");
    expect(second.replyMarkup.inline_keyboard.flat().every((button) => button.callback_data.length <= 64)).toBeTrue();
    expect(second.replyMarkup.inline_keyboard.flat().some((button) => "icon_custom_emoji_id" in button)).toBeFalse();
  });

  test("paginates models, marks the current value, and renders a terminal selection", () => {
    const first = modelPicker(data, 1);
    expect(first?.text).toContain("Choose a model · OpenAI");
    expect(first?.replyMarkup.inline_keyboard[0]?.[0]?.text).toBe("gpt-5.6-luna");
    expect(first?.replyMarkup.inline_keyboard[2]?.[0]?.text).toBe("Current · gpt-5.6-sol");
    expect(first?.replyMarkup.inline_keyboard.flat().map((button) => button.text)).toContain("Next ›");

    const selected = selectedModel(data.options[3]!);
    expect(selected.text).toBe("Model changed to\n\nopenai/gpt-5.6-sol");
    expect(selected.replyMarkup.inline_keyboard).toEqual([]);
  });

  test("rejects an unknown provider index", () => {
    expect(modelPicker(data, 999)).toBeUndefined();
  });
});
