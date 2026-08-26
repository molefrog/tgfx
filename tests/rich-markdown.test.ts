import { describe, expect, test } from "bun:test";
import { markdownToRichBlocks } from "../src/telegram/rich-markdown";

describe("streaming Markdown rich blocks", () => {
  test("renders headings and nested inline formatting", () => {
    expect(markdownToRichBlocks(
      "## Result\n\nPlain **bold with *italic* and `code`**, ~~gone~~, [link](https://example.com), and $x^2$.",
    )).toEqual([
      { type: "heading", size: 2, text: "Result" },
      {
        type: "paragraph",
        text: [
          "Plain ",
          {
            type: "bold",
            text: ["bold with ", { type: "italic", text: "italic" }, " and ", { type: "code", text: "code" }],
          },
          ", ",
          { type: "strikethrough", text: "gone" },
          ", ",
          { type: "url", text: "link", url: "https://example.com" },
          ", and ",
          { type: "mathematical_expression", expression: "x^2" },
          ".",
        ],
      },
    ]);
  });

  test("renders Telegram marked text, spoilers, and phone links inside paragraphs", () => {
    expect(markdownToRichBlocks(
      "Use ==**highlighted** text==, hide ||`spoiler code`||, or [call](tel:+123456789).",
    )).toEqual([{
      type: "paragraph",
      text: [
        "Use ",
        { type: "marked", text: [{ type: "bold", text: "highlighted" }, " text"] },
        ", hide ",
        { type: "spoiler", text: { type: "code", text: "spoiler code" } },
        ", or ",
        { type: "url", text: "call", url: "tel:+123456789" },
        ".",
      ],
    }]);
    expect(markdownToRichBlocks("Partial ==mark and ||spoiler")).toEqual([{
      type: "paragraph",
      text: "Partial ==mark and ||spoiler",
    }]);
    expect(markdownToRichBlocks("==x== ||y||")).toEqual([{
      type: "paragraph",
      text: [{ type: "marked", text: "x" }, " ", { type: "spoiler", text: "y" }],
    }]);
  });

  test("preserves plain, escaped, and soft-line-break text", () => {
    expect(markdownToRichBlocks("One \\*literal\\* line\nand two  \nand three.")).toEqual([{
      type: "paragraph",
      text: "One *literal* line\nand two\nand three.",
    }]);
  });

  test("renders all six heading sizes", () => {
    const markdown = [1, 2, 3, 4, 5, 6].map((size) => `${"#".repeat(size)} H${size}`).join("\n\n");
    expect(markdownToRichBlocks(markdown)).toEqual(
      [1, 2, 3, 4, 5, 6].map((size) => ({
        type: "heading" as const,
        size: size as 1 | 2 | 3 | 4 | 5 | 6,
        text: `H${size}`,
      })),
    );
  });

  test("renders fenced and indented code without interpreting inline Markdown", () => {
    expect(markdownToRichBlocks("```ts\nconst x = '**raw**';\n```\n\n    indented `raw`")).toEqual([
      { type: "pre", language: "ts", text: "const x = '**raw**';" },
      { type: "pre", text: "indented `raw`" },
    ]);
  });

  test("renders math fences and dollar-delimited block math", () => {
    expect(markdownToRichBlocks("```math\na^2 + b^2 = c^2\n```\n\n$$\n\\int_0^1 x\\,dx\n$$")).toEqual([
      { type: "mathematical_expression", expression: "a^2 + b^2 = c^2" },
      { type: "mathematical_expression", expression: "\\int_0^1 x\\,dx" },
    ]);
  });

  test("renders nested ordered and task lists with item metadata", () => {
    expect(markdownToRichBlocks("3. [x] shipped\n   - **nested**\n4. [ ] pending")).toEqual([{
      type: "list",
      items: [
        {
          blocks: [
            { type: "paragraph", text: "shipped" },
            { type: "list", items: [{ blocks: [{ type: "paragraph", text: { type: "bold", text: "nested" } }] }] },
          ],
          has_checkbox: true,
          is_checked: true,
          value: 3,
          type: "1",
        },
        {
          blocks: [{ type: "paragraph", text: "pending" }],
          has_checkbox: true,
          value: 4,
          type: "1",
        },
      ],
    }]);
  });

  test("renders block quotes with rich nested blocks", () => {
    expect(markdownToRichBlocks("> Quoted **text**\n>\n> - one\n> - two")).toEqual([{
      type: "blockquote",
      blocks: [
        { type: "paragraph", text: ["Quoted ", { type: "bold", text: "text" }] },
        {
          type: "list",
          items: [
            { blocks: [{ type: "paragraph", text: "one" }] },
            { blocks: [{ type: "paragraph", text: "two" }] },
          ],
        },
      ],
    }]);
  });

  test("renders GFM tables with rich header and body cells", () => {
    expect(markdownToRichBlocks("| **Name** | Value |\n| --- | --- |\n| `alpha` | *one* |\n| beta | $x$ |")).toEqual([{
      type: "table",
      cells: [
        [
          { text: { type: "bold", text: "Name" }, is_header: true, align: "left", valign: "top" },
          { text: "Value", is_header: true, align: "left", valign: "top" },
        ],
        [
          { text: { type: "code", text: "alpha" }, align: "left", valign: "top" },
          { text: { type: "italic", text: "one" }, align: "left", valign: "top" },
        ],
        [
          { text: "beta", align: "left", valign: "top" },
          { text: { type: "mathematical_expression", expression: "x" }, align: "left", valign: "top" },
        ],
      ],
    }]);
  });

  test("preserves tables wider than Telegram's 20-column limit as preformatted text", () => {
    const header = `| ${Array.from({ length: 21 }, (_, index) => `H${index + 1}`).join(" | ")} |`;
    const separator = `| ${Array.from({ length: 21 }, () => "---").join(" | ")} |`;
    const source = `${header}\n${separator}`;
    expect(markdownToRichBlocks(source)).toEqual([{ type: "pre", text: source }]);
  });

  test("skips separators, footer HTML, and other raw block HTML", () => {
    expect(markdownToRichBlocks("before\n\n---\n\n<footer>diagnostic</footer>\n\n<div>raw block</div>\n\nafter")).toEqual([
      { type: "paragraph", text: "before" },
      { type: "paragraph", text: "after" },
    ]);
  });

  test("reparses partial emphasis without leaking malformed rich nodes", () => {
    expect(markdownToRichBlocks("Answer: **part")).toEqual([
      { type: "paragraph", text: "Answer: **part" },
    ]);
    expect(markdownToRichBlocks("Answer: **part**")).toEqual([
      { type: "paragraph", text: ["Answer: ", { type: "bold", text: "part" }] },
    ]);
  });

  test("keeps an incomplete fence in preformatted mode", () => {
    expect(markdownToRichBlocks("```js\nconst answer = 4")).toEqual([
      { type: "pre", language: "js", text: "const answer = 4" },
    ]);
    expect(markdownToRichBlocks("```js\nconst answer = 42;\n```")).toEqual([
      { type: "pre", language: "js", text: "const answer = 42;" },
    ]);
  });

  test("keeps empty streaming markers as valid non-empty paragraphs", () => {
    expect(["# ", "- ", "> ", "```"].map((source) => markdownToRichBlocks(source))).toEqual([
      [{ type: "paragraph", text: "#" }],
      [{ type: "paragraph", text: "-" }],
      [{ type: "paragraph", text: ">" }],
      [{ type: "paragraph", text: "```" }],
    ]);
  });

  test("transitions a partial table from paragraph to structured cells", () => {
    expect(markdownToRichBlocks("| A | B |\n")).toEqual([
      { type: "paragraph", text: "| A | B |" },
    ]);
    expect(markdownToRichBlocks("| A | B |\n| --- | --- |\n| 1 | 2 |")).toEqual([{
      type: "table",
      cells: [
        [
          { text: "A", is_header: true, align: "left", valign: "top" },
          { text: "B", is_header: true, align: "left", valign: "top" },
        ],
        [
          { text: "1", align: "left", valign: "top" },
          { text: "2", align: "left", valign: "top" },
        ],
      ],
    }]);
  });

  test("streams an opened block math expression before its closing delimiter", () => {
    expect(markdownToRichBlocks("$$\nx + y")).toEqual([
      { type: "mathematical_expression", expression: "x + y" },
    ]);
    expect(markdownToRichBlocks("$$\nx + y\n$$")).toEqual([
      { type: "mathematical_expression", expression: "x + y" },
    ]);
  });

  test("keeps escaped and incomplete inline math literal", () => {
    expect(markdownToRichBlocks("Cost \\$5; partial $x; complete $y$.")).toEqual([{
      type: "paragraph",
      text: ["Cost $5; partial $x; complete ", { type: "mathematical_expression", expression: "y" }, "."],
    }]);
  });

  test("decodes Markdown entities and drops unsafe link destinations", () => {
    expect(markdownToRichBlocks(
      "AT&amp;T [safe](https://example.com/?a=1&amp;b=2), [unsafe](javascript:alert(1)), and &#x1f44b;.",
    )).toEqual([{
      type: "paragraph",
      text: [
        "AT&T ",
        { type: "url", text: "safe", url: "https://example.com/?a=1&b=2" },
        ", unsafe, and 👋.",
      ],
    }]);
  });
});
