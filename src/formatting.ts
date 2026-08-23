import type { TelegramMessageEntity } from "./telegram";

export interface FormattedText {
  text: string;
  entities: TelegramMessageEntity[];
}

function appendFormatted(target: FormattedText, source: FormattedText): void {
  const offset = target.text.length;
  target.text += source.text;
  target.entities.push(
    ...source.entities.map((entity) => ({
      ...entity,
      offset: entity.offset + offset,
    })),
  );
}

function findClosing(source: string, marker: string, from: number): number {
  for (let index = from; index < source.length; index++) {
    const found = source.indexOf(marker, index);
    if (found < 0) return -1;
    if (found === 0 || source[found - 1] !== "\\") return found;
    index = found;
  }
  return -1;
}

function parseInline(source: string): FormattedText {
  const result: FormattedText = { text: "", entities: [] };
  let index = 0;

  const formattedPair = (
    marker: string,
    type: TelegramMessageEntity["type"],
    parseInside = true,
  ): boolean => {
    if (!source.startsWith(marker, index)) return false;
    const isWord = (value: string | undefined) =>
      value !== undefined && /[\p{L}\p{N}]/u.test(value);
    if (
      marker.startsWith("_")
      && (isWord(source[index - 1]) || /\s/u.test(source[index + marker.length] ?? ""))
    ) return false;

    let closing = findClosing(source, marker, index + marker.length);
    while (
      closing >= 0
      && marker.startsWith("_")
      && (isWord(source[closing + marker.length]) || /\s/u.test(source[closing - 1] ?? ""))
    ) {
      closing = findClosing(source, marker, closing + marker.length);
    }
    if (closing < 0) return false;

    const innerSource = source.slice(index + marker.length, closing);
    const inner = parseInside
      ? parseInline(innerSource)
      : { text: innerSource, entities: [] };
    const offset = result.text.length;
    appendFormatted(result, inner);
    if (inner.text.length > 0) {
      result.entities.push({ type, offset, length: inner.text.length });
    }
    index = closing + marker.length;
    return true;
  };

  while (index < source.length) {
    if (source[index] === "\\" && index + 1 < source.length) {
      result.text += source[index + 1];
      index += 2;
      continue;
    }

    if (source[index] === "[") {
      const labelEnd = findClosing(source, "]", index + 1);
      const urlStart = labelEnd >= 0 && source[labelEnd + 1] === "("
        ? labelEnd + 2
        : -1;
      const urlEnd = urlStart >= 0 ? findClosing(source, ")", urlStart) : -1;

      if (labelEnd >= 0 && urlStart >= 0 && urlEnd >= 0) {
        const label = parseInline(source.slice(index + 1, labelEnd));
        const offset = result.text.length;
        appendFormatted(result, label);
        const url = source.slice(urlStart, urlEnd);
        if (label.text.length > 0 && /^(?:https?:\/\/|tg:\/\/)/u.test(url)) {
          result.entities.push({
            type: "text_link",
            offset,
            length: label.text.length,
            url,
          });
        }
        index = urlEnd + 1;
        continue;
      }
    }

    if (formattedPair("**", "bold")) continue;
    if (formattedPair("__", "bold")) continue;
    if (formattedPair("~~", "strikethrough")) continue;
    if (formattedPair("`", "code", false)) continue;
    if (!source.startsWith("**", index) && formattedPair("*", "italic")) continue;
    if (!source.startsWith("__", index) && formattedPair("_", "italic")) continue;

    result.text += source[index];
    index++;
  }

  return result;
}

export function markdownToTelegram(source: string): FormattedText {
  const result: FormattedText = { text: "", entities: [] };
  let index = 0;

  while (index < source.length) {
    const atLineStart = index === 0 || source[index - 1] === "\n";

    if (atLineStart && source.startsWith("```", index)) {
      const languageEnd = source.indexOf("\n", index + 3);
      if (languageEnd < 0) {
        result.text += source.slice(index);
        break;
      }

      const language = source.slice(index + 3, languageEnd).trim();
      const closing = source.indexOf("\n```", languageEnd + 1);
      const contentEnd = closing < 0 ? source.length : closing;
      const code = source.slice(languageEnd + 1, contentEnd);
      const offset = result.text.length;
      result.text += code;
      if (code.length > 0) {
        result.entities.push({
          type: "pre",
          offset,
          length: code.length,
          ...(language ? { language } : {}),
        });
      }
      index = closing < 0 ? source.length : closing + 4;
      continue;
    }

    if (atLineStart) {
      const rest = source.slice(index);
      const heading = /^(#{1,6})[ \t]+([^\n]*)(\n|$)/u.exec(rest);
      if (heading) {
        const parsed = parseInline(heading[2]);
        const offset = result.text.length;
        appendFormatted(result, parsed);
        if (parsed.text.length > 0) {
          result.entities.push({
            type: "bold",
            offset,
            length: parsed.text.length,
          });
        }
        result.text += heading[3];
        index += heading[0].length;
        continue;
      }
    }

    const lineEnd = source.indexOf("\n", index);
    const end = lineEnd < 0 ? source.length : lineEnd + 1;
    appendFormatted(result, parseInline(source.slice(index, end)));
    index = end;
  }

  return result;
}

export class FormattedTextBuilder {
  private value: FormattedText = { text: "", entities: [] };

  appendPlain(text: string): this {
    this.value.text += text;
    return this;
  }

  appendMarkdown(markdown: string): this {
    appendFormatted(this.value, markdownToTelegram(markdown));
    return this;
  }

  appendEntityText(
    text: string,
    type: TelegramMessageEntity["type"],
  ): this {
    const offset = this.value.text.length;
    this.value.text += text;
    if (text.length > 0) {
      this.value.entities.push({ type, offset, length: text.length });
    }
    return this;
  }

  build(): FormattedText {
    return {
      text: this.value.text,
      entities: [...this.value.entities],
    };
  }
}
