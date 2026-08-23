import { describe, expect, test } from "bun:test";
import { markdownToTelegram } from "../src/formatting";

describe("Markdown to Telegram entities", () => {
  test("converts common inline markup without parse-mode escaping", () => {
    expect(
      markdownToTelegram("A **bold** and *italic* with `code`.\n# Head"),
    ).toEqual({
      text: "A bold and italic with code.\nHead",
      entities: [
        { type: "bold", offset: 2, length: 4 },
        { type: "italic", offset: 11, length: 6 },
        { type: "code", offset: 23, length: 4 },
        { type: "bold", offset: 29, length: 4 },
      ],
    });
  });

  test("uses UTF-16 offsets and only creates links for safe schemes", () => {
    expect(markdownToTelegram("😀 [site](https://example.com)")).toEqual({
      text: "😀 site",
      entities: [{
        type: "text_link",
        offset: 3,
        length: 4,
        url: "https://example.com",
      }],
    });
  });

  test("supports fenced code and tolerates unfinished streamed markup", () => {
    const fenced = markdownToTelegram(
      "```ts\nconst x = 1;\n```\nAfter **done**",
    );
    expect(fenced.text).toBe("const x = 1;\nAfter done");
    expect(fenced.entities).toEqual([
      { type: "pre", offset: 0, length: 12, language: "ts" },
      { type: "bold", offset: 19, length: 4 },
    ]);

    expect(markdownToTelegram("Hello **wor")).toEqual({
      text: "Hello **wor",
      entities: [],
    });
  });

  test("does not treat snake_case identifiers as emphasis", () => {
    expect(markdownToTelegram("grep_files and files_with_matches")).toEqual({
      text: "grep_files and files_with_matches",
      entities: [],
    });
  });
});
