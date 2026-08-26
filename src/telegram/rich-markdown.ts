import { Marked } from "marked";
import type { Token, Tokens } from "marked";
import type { InputRichMessageWithoutUpload } from "grammy/types";

export type RichBlock = NonNullable<InputRichMessageWithoutUpload["blocks"]>[number];
type RichText = Extract<RichBlock, { type: "paragraph" }>["text"];
type TableCell = Extract<RichBlock, { type: "table" }>["cells"][number][number];

type MathToken = Token & { type: "math_block" | "math_inline"; text: string };
type StyledToken = Token & { type: "marked_inline" | "spoiler_inline"; tokens: Token[] };

const markdownParser = new Marked({
  gfm: true,
  extensions: [
    {
      name: "math_block",
      level: "block",
      start(source) {
        return /^ {0,3}\$\$(?!\$)/m.exec(source)?.index;
      },
      tokenizer(source) {
        const match = /^ {0,3}\$\$(?!\$)[ \t]*(?:\n)?([\s\S]*?)(?:\n? {0,3}\$\$[ \t]*(?:\n+|$)|$)/.exec(source);
        if (!match) return;
        return { type: "math_block", raw: match[0], text: match[1] ?? "" };
      },
    },
    {
      name: "math_inline",
      level: "inline",
      start(source) {
        const index = source.indexOf("$");
        return index < 0 ? undefined : index;
      },
      tokenizer(source) {
        const match = /^\$(?!\$)(?![ \t\n])((?:\\.|[^\\$\n])+?)(?<![ \t])\$(?!\$)/.exec(source);
        if (!match) return;
        return { type: "math_inline", raw: match[0], text: match[1] ?? "" };
      },
    },
    {
      name: "marked_inline",
      level: "inline",
      start(source) {
        const index = source.indexOf("==");
        return index < 0 ? undefined : index;
      },
      tokenizer(source) {
        const match = /^==(?=\S)([^\n]*?\S)==/.exec(source);
        if (!match) return;
        return {
          type: "marked_inline",
          raw: match[0],
          tokens: this.lexer.inlineTokens(match[1] ?? ""),
        };
      },
    },
    {
      name: "spoiler_inline",
      level: "inline",
      start(source) {
        const index = source.indexOf("||");
        return index < 0 ? undefined : index;
      },
      tokenizer(source) {
        const match = /^\|\|(?=\S)([^\n]*?\S)\|\|/.exec(source);
        if (!match) return;
        return {
          type: "spoiler_inline",
          raw: match[0],
          tokens: this.lexer.inlineTokens(match[1] ?? ""),
        };
      },
    },
  ],
});

const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: "\u00a0",
  quot: '"',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (entity, body: string) => {
    if (body[0] !== "#") return namedEntities[body.toLowerCase()] ?? entity;
    const hexadecimal = body[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity;
    try { return String.fromCodePoint(codePoint); } catch { return entity; }
  });
}

function safeUrl(value: string): string | undefined {
  const url = decodeEntities(value.trim());
  return /^(?:https?:|tg:|mailto:|tel:)/i.test(url) ? url : undefined;
}

function richParts(tokens: Token[]): RichText[] {
  const parts: RichText[] = [];

  const append = (part: RichText): void => {
    if (Array.isArray(part)) {
      for (const nested of part) append(nested);
      return;
    }
    if (part === "") return;
    const previous = parts.at(-1);
    if (typeof previous === "string" && typeof part === "string") {
      parts[parts.length - 1] = previous + part;
    } else {
      parts.push(part);
    }
  };

  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        append(text.tokens ? richText(text.tokens) : decodeEntities(text.text));
        break;
      }
      case "escape":
        append(decodeEntities((token as Tokens.Escape).text));
        break;
      case "strong": {
        const strong = token as Tokens.Strong;
        append({ type: "bold", text: richText(strong.tokens) });
        break;
      }
      case "em": {
        const emphasis = token as Tokens.Em;
        append({ type: "italic", text: richText(emphasis.tokens) });
        break;
      }
      case "del": {
        const deleted = token as Tokens.Del;
        append({ type: "strikethrough", text: richText(deleted.tokens) });
        break;
      }
      case "codespan":
        append({ type: "code", text: (token as Tokens.Codespan).text });
        break;
      case "link": {
        const link = token as Tokens.Link;
        const text = richText(link.tokens);
        const url = safeUrl(link.href);
        append(text === "" ? url ?? decodeEntities(link.href) : url ? { type: "url", text, url } : text);
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        const text = richText(image.tokens);
        const url = safeUrl(image.href);
        append(text === "" ? url ?? decodeEntities(image.href) : url ? { type: "url", text, url } : text);
        break;
      }
      case "math_inline":
        append({ type: "mathematical_expression", expression: (token as MathToken).text });
        break;
      case "marked_inline":
        append({ type: "marked", text: richText((token as StyledToken).tokens) });
        break;
      case "spoiler_inline":
        append({ type: "spoiler", text: richText((token as StyledToken).tokens) });
        break;
      case "br":
        append("\n");
        break;
      case "html":
      case "checkbox":
        break;
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) append(richText(token.tokens));
        else if ("text" in token && typeof token.text === "string") append(decodeEntities(token.text));
        else if (typeof token.raw === "string") append(token.raw);
    }
  }
  return parts;
}

function richText(tokens: Token[]): RichText {
  const parts = richParts(tokens);
  if (parts.length === 0) return "";
  return parts.length === 1 ? parts[0]! : parts;
}

function paragraph(tokens: Token[], fallback: string): RichBlock {
  return { type: "paragraph", text: tokens.length ? richText(tokens) : fallback };
}

function listBlock(token: Tokens.List): RichBlock {
  const start = typeof token.start === "number" ? token.start : 1;
  const itemBlocks = token.items.map((item) => blocksFromTokens(item.tokens));
  if (itemBlocks.some((blocks) => blocks.length === 0)) {
    return { type: "paragraph", text: token.raw.trimEnd() };
  }
  return {
    type: "list",
    items: token.items.map((item, index) => {
      const marker = /^\s*(\d+)[.)][ \t]+/.exec(item.raw);
      return {
        blocks: itemBlocks[index]!,
        ...(item.task ? { has_checkbox: true as const } : {}),
        ...(item.checked ? { is_checked: true as const } : {}),
        ...(token.ordered ? {
          value: marker ? Number(marker[1]) : start + index,
          type: "1" as const,
        } : {}),
      };
    }),
  };
}

function tableBlock(token: Tokens.Table): RichBlock {
  // Telegram rejects rich tables wider than 20 columns. Preserve an oversized
  // table verbatim instead of losing cells or making the whole message fail.
  if (token.header.length > 20) return { type: "pre", text: token.raw.trimEnd() };
  const header: TableCell[] = token.header.map((cell) => ({
    text: richText(cell.tokens),
    is_header: true,
    align: cell.align ?? "left",
    valign: "top",
  }));
  const rows: TableCell[][] = token.rows.map((row) => row.map((cell) => ({
    text: richText(cell.tokens),
    align: cell.align ?? "left",
    valign: "top",
  })));
  return { type: "table", cells: [header, ...rows] };
}

function blocksFromTokens(tokens: Token[]): RichBlock[] {
  const blocks: RichBlock[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "paragraph": {
        const value = token as Tokens.Paragraph;
        blocks.push(paragraph(value.tokens, value.text));
        break;
      }
      case "text": {
        const value = token as Tokens.Text;
        blocks.push(paragraph(value.tokens ?? [], value.text));
        break;
      }
      case "heading": {
        const heading = token as Tokens.Heading;
        const size = Math.max(1, Math.min(6, heading.depth)) as 1 | 2 | 3 | 4 | 5 | 6;
        const text = richText(heading.tokens);
        blocks.push(text === ""
          ? { type: "paragraph", text: heading.raw.trimEnd() }
          : { type: "heading", size, text });
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        const language = code.lang?.trim().split(/\s+/, 1)[0];
        if (language?.toLowerCase() === "math") {
          blocks.push(code.text
            ? { type: "mathematical_expression", expression: code.text }
            : { type: "paragraph", text: code.raw.trimEnd() });
        } else {
          blocks.push(code.text
            ? { type: "pre", text: code.text, ...(language ? { language } : {}) }
            : { type: "paragraph", text: code.raw.trimEnd() });
        }
        break;
      }
      case "math_block": {
        const math = token as MathToken;
        if (math.text) blocks.push({ type: "mathematical_expression", expression: math.text });
        else blocks.push({ type: "paragraph", text: math.raw });
        break;
      }
      case "list":
        blocks.push(listBlock(token as Tokens.List));
        break;
      case "blockquote": {
        const quote = token as Tokens.Blockquote;
        const nested = blocksFromTokens(quote.tokens);
        blocks.push(nested.length
          ? { type: "blockquote", blocks: nested }
          : { type: "paragraph", text: quote.raw.trimEnd() });
        break;
      }
      case "table":
        blocks.push(tableBlock(token as Tokens.Table));
        break;
      case "hr":
      case "html":
      case "space":
      case "def":
      case "footer":
      case "separator":
      case "divider":
      case "checkbox":
        break;
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) {
          blocks.push(...blocksFromTokens(token.tokens));
        } else if ("text" in token && typeof token.text === "string") {
          blocks.push({ type: "paragraph", text: token.text });
        } else if (typeof token.raw === "string" && token.raw) {
          blocks.push({ type: "paragraph", text: token.raw });
        }
    }
  }
  return blocks;
}

/**
 * Converts the complete Markdown accumulated so far into Telegram rich blocks.
 * Calling this again with the next snapshot is intentional: incomplete Markdown
 * remains readable and gains structure as soon as its closing syntax arrives.
 */
export function markdownToRichBlocks(markdown: string): RichBlock[] {
  if (!markdown) return [];
  try {
    return blocksFromTokens(markdownParser.lexer(markdown));
  } catch {
    return [{ type: "paragraph", text: markdown }];
  }
}
