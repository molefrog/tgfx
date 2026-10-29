import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { marked } from "marked";
import type { ContentBlock } from "@agentclientprotocol/sdk";

export type MemoryOptions = { enabled?: boolean; file?: string };
type Section = { heading: string | null; text: string; hash: string };
type Snapshot = { text: string; hash: string; sections: Section[] };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Marked recognizes real H1s, including Setext headings, but not headings inside code or quotes. */
export function memorySections(text: string): Section[] {
  const sections: Section[] = [];
  let heading: string | null = null, start = 0, cursor = 0;
  const flush = (end: number) => {
    const value = text.slice(start, end).trimEnd();
    if (value) sections.push({ heading, text: value, hash: hash(value) });
  };
  for (const token of marked.lexer(text)) {
    // Link definitions are stored in lexer metadata rather than tokens. Slice the
    // original source so those definitions still participate in section hashes.
    const offset = text.indexOf(token.raw, cursor);
    cursor = offset + token.raw.length;
    if (token.type === "heading" && token.depth === 1) {
      flush(offset);
      heading = token.text;
      start = offset;
    }
  }
  flush(text.length);
  return sections;
}

/** One cursor per FX session. Preparing a prompt never advances the cursor until delivery succeeds. */
export class SessionMemory {
  private previous?: Snapshot | null;
  private readonly file: string;

  constructor(private readonly directory: string, private readonly options: MemoryOptions = {}) {
    this.file = options.file ?? "MEMORY.md";
    if (isAbsolute(this.file) || relative(directory, resolve(directory, this.file)).split(sep)[0] === "..") {
      throw new Error("Memory file must be inside the working directory");
    }
  }

  reset(): void { this.previous = undefined; }

  private async read(): Promise<Snapshot | null> {
    let path: string;
    try { path = await realpath(resolve(this.directory, this.file)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const root = await realpath(this.directory);
    const inside = (value: string) => {
      const path = relative(root, value);
      return path !== "" && path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
    };
    if (!inside(path)) throw new Error("Memory file must be inside the working directory");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error("Memory must be a regular file");
      if (process.platform === "linux" && !inside(await realpath(`/proc/self/fd/${file.fd}`))) {
        throw new Error("Memory file moved outside the working directory");
      }
      const text = (await file.readFile("utf8")).replaceAll("\r\n", "\n");
      return text.trim() ? { text, hash: hash(text), sections: memorySections(text) } : null;
    } finally { await file.close(); }
  }

  async prepare(): Promise<{ block?: ContentBlock; commit(): void }> {
    if (this.options.enabled === false) return { commit() {} };
    const current = await this.read();
    const previous = this.previous;
    let action: "initial" | "append" | "reread" | "clear" | undefined;
    let content = "";
    if (!previous && current) {
      action = "initial";
      content = "Your persistent memory, shared across conversations.\n\n" + current.text;
    } else if (previous && !current) {
      action = "clear";
      content = `Your memory has been cleared. Disregard the contents previously provided from ${this.file}.`;
    } else if (previous && current && previous.hash !== current.hash) {
      const old = new Map(previous.sections.map(section => [section.heading, section.hash]));
      const now = new Map(current.sections.map(section => [section.heading, section.hash]));
      const retained = current.sections.filter(section => old.has(section.heading));
      const onlyAdditions = old.size === previous.sections.length && now.size === current.sections.length
        && retained.length === previous.sections.length
        && retained.every((section, i) => section.heading === previous.sections[i]!.heading && section.hash === previous.sections[i]!.hash);
      if (onlyAdditions) {
        const added = current.sections.filter(section => !old.has(section.heading));
        if (added.length) {
          action = "append";
          content = "These sections were added to your memory:\n\n" + added.map(section => section.text).join("\n\n");
        }
      } else {
        action = "reread";
        content = `Your memory has changed. Read ${this.file} before continuing and use its current contents instead of the earlier version.`;
      }
    }
    const tag = action === "initial" ? "memory" : "memory-update";
    const block: ContentBlock | undefined = action ? { type: "text", text:
      `<${tag}${action === "initial" ? "" : ` action="${action}"`} source="${xml(this.file)}">\n${xml(content)}\n</${tag}>` } : undefined;
    return { ...(block ? { block } : {}), commit: () => { this.previous = current; } };
  }
}
