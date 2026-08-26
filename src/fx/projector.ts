import type * as acp from "@agentclientprotocol/sdk";
import type { InputRichMessageWithoutUpload } from "grammy/types";
import { redactSecrets } from "../secrets";
import { markdownToRichBlocks, type RichBlock } from "../telegram/rich-markdown";

type AssistantEntry = { type: "assistant"; messageId?: string; markdown: string };
type ToolEntry = { type: "tool"; toolCallId: string };
type TimelineEntry = AssistantEntry | ToolEntry;

export type ToolState = {
  id: string;
  title: string;
  name?: string;
  kind?: string;
  status: string;
  input?: unknown;
  output?: unknown;
  content: unknown[];
  locations: unknown[];
  startedAt: number;
  finishedAt?: number;
};

export type TimelineSnapshot = {
  prose: string;
  thought: string;
  tools: ToolState[];
  commands: Array<{ name: string; description: string; input?: { hint: string } }>;
  changedAt: number;
};

type ProjectedItem =
  | { type: "assistant"; markdown: string; blocks: RichBlock[] }
  | { type: "tools"; tools: ToolState[] };

const TOOL_ARGUMENT_PREVIEW_MAX_CHARS = 120;
const TOOL_SUMMARY_CATEGORY_LIMIT = 4;

type ToolActivity =
  | "commands"
  | "created_files"
  | "edited_files"
  | "read_files"
  | "searched_code"
  | "searched_web"
  | "fetched_pages"
  | "deleted_files"
  | "copied_files"
  | "renamed_files"
  | "moved_files"
  | "failed";

const TOOL_ACTIVITY_ORDER: ToolActivity[] = [
  "commands",
  "created_files",
  "edited_files",
  "read_files",
  "searched_code",
  "searched_web",
  "fetched_pages",
  "deleted_files",
  "copied_files",
  "renamed_files",
  "moved_files",
  "failed",
];

function stringify(value: unknown, limit = 4_000, pretty = true): string {
  if (value === undefined) return "";
  let result: string;
  try {
    result = typeof value === "string"
      ? value
      : JSON.stringify(value, null, pretty ? 2 : undefined);
  } catch {
    result = String(value);
  }
  result = redactSecrets(result);
  return result.length > limit ? `${result.slice(0, limit)}\n…` : result;
}

function terminal(status: string): boolean {
  return status === "completed" || status === "done" || status === "failed" || status === "error";
}

function failed(status: string): boolean {
  return status === "failed" || status === "error";
}

function diagnosticOffset(text: string): number {
  const match = /(?:^|\n)[\t ]*(?:\[context\][\t ]|skill discovery warning:)/.exec(text);
  return match?.index ?? -1;
}

function contentText(content: unknown[]): string[] {
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const wrapper = item as { type?: unknown; content?: unknown };
    if (wrapper.type !== "content" || !wrapper.content || typeof wrapper.content !== "object") return [];
    const block = wrapper.content as { type?: unknown; text?: unknown };
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  });
}

function exactArgumentFromContent(content: unknown[]): string {
  for (const text of contentText(content)) {
    const tagged = text.match(/<(path|url)>([^<]+)<\/\1>/i)?.[2]?.trim();
    if (tagged) return stringify(tagged, 800, false);

    const path = text.match(/^path:\s*(.+)$/im)?.[1]?.trim();
    if (path) return stringify(path, 800, false);

    const search = text.match(/^\[(?:search|grep)\][^\n]*?\bfor:\s*(.+)$/im)?.[1]?.trim()
      ?? text.match(/^\[grep\][^\n]*?\bfor\s+(.+)$/im)?.[1]?.trim();
    if (search) return stringify(search, 800, false);

    const glob = text.match(/^\[glob\][^\n]*?\bfor\s+(.+)$/im)?.[1]?.trim();
    if (glob) return stringify(glob, 800, false);

    const fetch = text.match(/^Fetching\s+(?:URL\s+)?(https?:\/\/\S+)/im)?.[1]?.trim();
    if (fetch) return stringify(fetch, 800, false);

    const skill = text.match(/<skill_content\s+[^>]*name=["']([^"']+)["']/i)?.[1]?.trim();
    if (skill) return stringify(skill, 800, false);

    const directory = text.match(/^((?:\.{0,2}\/)?[\w./~-]+):\n-\s/m)?.[1]?.trim();
    if (directory) return stringify(directory, 800, false);

    const handle = text.match(/\bfailed for handle\s+([^:\s]+):/i)?.[1]?.trim();
    if (handle) return stringify(handle, 800, false);
  }
  return "";
}

function toolArgument(tool: ToolState): string {
  if (tool.input !== undefined) return stringify(tool.input, 800, false);

  if (tool.output && typeof tool.output === "object") {
    const command = (tool.output as { command?: unknown }).command;
    if (typeof command === "string" && command.trim()) return stringify(command.trim(), 800, false);
  }

  const locations = tool.locations.flatMap((location) => {
    if (!location || typeof location !== "object") return [];
    const value = location as { path?: unknown; line?: unknown };
    if (typeof value.path !== "string") return [];
    return [`${value.path}${typeof value.line === "number" ? `:${value.line}` : ""}`];
  });
  if (locations.length) return stringify(locations.length === 1 ? locations[0] : locations, 800, false);

  return exactArgumentFromContent(tool.content);
}

function toolArgumentPreview(tool: ToolState): string {
  const oneLine = toolArgument(tool).replace(/\s+/gu, " ").trim();
  const characters = [...oneLine];
  if (characters.length <= TOOL_ARGUMENT_PREVIEW_MAX_CHARS) return oneLine;
  return `${characters.slice(0, TOOL_ARGUMENT_PREVIEW_MAX_CHARS - 1).join("")}…`;
}

function extensionOutput(update: unknown): unknown {
  if (!update || typeof update !== "object") return undefined;
  const value = update as { command_result?: unknown };
  return value.command_result;
}

function toolName(tool: ToolState): string {
  return tool.name?.trim().toLowerCase() ?? "";
}

function titleStartsWith(tool: ToolState, pattern: RegExp): boolean {
  return pattern.test(tool.title.trim());
}

function hasNewFileDiff(tool: ToolState): boolean {
  return tool.content.some((item) => {
    if (!item || typeof item !== "object") return false;
    const value = item as { type?: unknown; oldText?: unknown; newText?: unknown };
    return value.type === "diff" && typeof value.newText === "string"
      && (value.oldText === undefined || value.oldText === null);
  });
}

function toolActivity(tool: ToolState): ToolActivity | undefined {
  if (failed(tool.status)) return "failed";
  const name = toolName(tool);
  switch (tool.kind) {
    case "execute":
      return ["run_command", "exec_command"].includes(name)
        || titleStartsWith(tool, /^(?:running|starting)\b/iu)
        ? "commands"
        : undefined;
    case "read":
      if (name === "web_fetch" || titleStartsWith(tool, /^fetching\b/iu)) return "fetched_pages";
      if (["grep_files", "glob_files", "semantic_search"].includes(name)
        || titleStartsWith(tool, /^matching\b/iu)) return "searched_code";
      if (["read_file"].includes(name) || titleStartsWith(tool, /^reading\b/iu)) return "read_files";
      return tool.title.trim() ? undefined : "read_files";
    case "edit":
      if (hasNewFileDiff(tool)
        || ["write_file", "create_file", "create_folder"].includes(name)
        || titleStartsWith(tool, /^(?:creating|writing)\b/iu)) return "created_files";
      return "edited_files";
    case "search":
      return name === "web_search" || titleStartsWith(tool, /\bweb\b/iu)
        ? "searched_web"
        : "searched_code";
    case "fetch":
      return "fetched_pages";
    case "delete":
      return "deleted_files";
    case "move":
      if (name === "copy_file" || titleStartsWith(tool, /^copying\b/iu)) return "copied_files";
      if (name === "rename_file" || titleStartsWith(tool, /^renaming\b/iu)) return "renamed_files";
      return "moved_files";
    default:
      return undefined;
  }
}

function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function activitySummary(activity: ToolActivity, count: number): string {
  switch (activity) {
    case "commands": return `ran ${counted(count, "command")}`;
    case "created_files": return `created ${counted(count, "file")}`;
    case "edited_files": return `edited ${counted(count, "file")}`;
    case "read_files": return `read ${counted(count, "file")}`;
    case "searched_code": return "searched code";
    case "searched_web": return "searched web";
    case "fetched_pages": return `fetched ${counted(count, "page")}`;
    case "deleted_files": return `deleted ${counted(count, "file")}`;
    case "copied_files": return `copied ${counted(count, "file")}`;
    case "renamed_files": return `renamed ${counted(count, "file")}`;
    case "moved_files": return `moved ${counted(count, "file")}`;
    case "failed": return `${counted(count, "tool")} failed`;
  }
}

function capitalize(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function toolGroupSeconds(tools: ToolState[], changedAt: number): number {
  const startedAt = Math.min(...tools.map((tool) => tool.startedAt));
  const finishedAt = Math.max(...tools.map((tool) => tool.finishedAt ?? changedAt));
  return Math.max(1, Math.round((finishedAt - startedAt) / 1_000));
}

function completedToolSummary(tools: ToolState[], changedAt: number): string {
  const counts = new Map<ToolActivity, number>();
  let unformattedCount = 0;
  for (const tool of tools) {
    const activity = toolActivity(tool);
    if (!activity) {
      unformattedCount += 1;
      continue;
    }
    counts.set(activity, (counts.get(activity) ?? 0) + 1);
  }

  const activities = TOOL_ACTIVITY_ORDER.filter((activity) => counts.has(activity));
  if (!activities.length) return `Worked for ${toolGroupSeconds(tools, changedAt)}s`;

  const visible = activities.slice(0, TOOL_SUMMARY_CATEGORY_LIMIT);
  const hiddenCategories = activities.length - visible.length + unformattedCount;
  const formatted = capitalize(visible.map((activity) =>
    activitySummary(activity, counts.get(activity) ?? 0)
  ).join(", "));
  return hiddenCategories ? `${formatted} + ${hiddenCategories} more` : formatted;
}

export class AcpProjector {
  private thought = "";
  private firstThoughtMessageId?: string;
  private hasThought = false;
  private timeline: TimelineEntry[] = [];
  private tools = new Map<string, ToolState>();
  private commands: TimelineSnapshot["commands"] = [];
  private changedAt = Date.now();

  apply(update: acp.SessionUpdate): void {
    this.changedAt = Date.now();
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type !== "text") return;
        const text = update.content.text;
        const ownDiagnostic = diagnosticOffset(text);
        if (ownDiagnostic === 0) return;
        const visible = ownDiagnostic > 0 ? text.slice(0, ownDiagnostic) : text;

        const messageId = update.messageId ?? undefined;
        const tail = this.timeline.at(-1);
        if (tail?.type === "assistant" && tail.messageId === messageId) {
          const combined = tail.markdown + visible;
          const combinedDiagnostic = diagnosticOffset(combined);
          tail.markdown = combinedDiagnostic >= 0 ? combined.slice(0, combinedDiagnostic) : combined;
        } else {
          this.timeline.push({ type: "assistant", ...(messageId ? { messageId } : {}), markdown: visible });
        }
        return;
      }
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return;
        const messageId = update.messageId ?? undefined;
        if (!this.hasThought) {
          this.hasThought = true;
          this.firstThoughtMessageId = messageId;
          this.thought = update.content.text;
        } else if (messageId === this.firstThoughtMessageId) {
          this.thought += update.content.text;
        }
        return;
      }
      case "tool_call":
        this.patchTool(update.toolCallId, update);
        return;
      case "tool_call_update":
        this.patchTool(update.toolCallId, update);
        return;
      case "available_commands_update":
        this.commands = update.availableCommands.map((command) => ({
          name: command.name,
          description: command.description,
          ...(command.input ? { input: command.input } : {}),
        }));
        return;
      default:
        return;
    }
  }

  private patchTool(
    id: string,
    update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  ): void {
    const now = Date.now();
    const previous = this.tools.get(id);
    if (!previous) this.timeline.push({ type: "tool", toolCallId: id });

    const status = update.status ?? previous?.status ?? "pending";
    const output = update.rawOutput !== undefined
      ? update.rawOutput
      : extensionOutput(update) ?? previous?.output;
    const next: ToolState = {
      id,
      title: update.title ?? previous?.title ?? "Tool",
      ...(update.name ?? previous?.name ? { name: update.name ?? previous?.name ?? undefined } : {}),
      ...(update.kind ?? previous?.kind ? { kind: update.kind ?? previous?.kind ?? undefined } : {}),
      status,
      ...(update.rawInput !== undefined ? { input: update.rawInput } : previous?.input !== undefined ? { input: previous.input } : {}),
      ...(output !== undefined ? { output } : {}),
      content: update.content !== undefined
        ? update.content === null ? [] : [...update.content]
        : previous?.content ?? [],
      locations: update.locations !== undefined
        ? update.locations === null ? [] : [...update.locations]
        : previous?.locations ?? [],
      startedAt: previous?.startedAt ?? now,
      ...(terminal(status) ? { finishedAt: previous?.finishedAt ?? now } : {}),
    };
    this.tools.set(id, next);
  }

  snapshot(): TimelineSnapshot {
    return {
      prose: redactSecrets(this.timeline.flatMap((entry) => entry.type === "assistant" ? [entry.markdown] : []).join("")),
      thought: redactSecrets(this.thought),
      tools: [...this.tools.values()],
      commands: [...this.commands],
      changedAt: this.changedAt,
    };
  }

  private projected(includeTools: boolean): ProjectedItem[] {
    const items: ProjectedItem[] = [];
    let group: ToolState[] = [];

    const flushTools = () => {
      if (includeTools) {
        const visible = group.filter((tool) => terminal(tool.status));
        if (visible.length) items.push({ type: "tools", tools: visible });
      }
      group = [];
    };

    for (const entry of this.timeline) {
      if (entry.type === "tool") {
        const tool = this.tools.get(entry.toolCallId);
        if (tool) group.push(tool);
        continue;
      }

      const markdown = redactSecrets(entry.markdown);
      const blocks = markdownToRichBlocks(markdown);
      if (!blocks.length) continue;
      flushTools();
      items.push({ type: "assistant", markdown, blocks });
    }
    flushTools();
    return items;
  }

  rich(options: {
    final: boolean;
    collapseTools: boolean;
    includeTools?: boolean;
  }): InputRichMessageWithoutUpload {
    const items = this.projected(options.includeTools ?? true);
    if (!items.length) {
      if (options.final) return { blocks: [{ type: "paragraph", text: "Done." }] };
      const text = this.thought.trim()
        ? `λ ${redactSecrets(this.thought.trim()).slice(0, 600)}`
        : "λ Thinking…";
      return { blocks: [{ type: "thinking", text }] };
    }

    const blocks = items.flatMap((item) => {
      if (item.type === "assistant") return item.blocks;
      return [this.toolGroupBlock(
        item.tools,
        options.collapseTools,
        !options.final,
      )];
    });
    return { blocks };
  }

  private toolGroupBlock(tools: ToolState[], collapseTools: boolean, streaming: boolean): RichBlock {
    const blocks = collapseTools
      ? tools.map((tool) => this.toolRow(tool))
      : tools.flatMap((tool) => this.expandedToolBlocks(tool));
    return {
      type: "details",
      summary: streaming ? "Working..." : completedToolSummary(tools, this.changedAt),
      blocks,
      ...(streaming ? { is_open: true as const } : {}),
    };
  }

  private toolRow(tool: ToolState): RichBlock {
    const argument = toolArgumentPreview(tool);
    const title = `${failed(tool.status) ? "✗" : "✓"} ${redactSecrets(tool.title)}`;
    return {
      type: "paragraph",
      text: argument
        ? [{ type: "bold", text: title }, " ", { type: "code", text: argument }]
        : { type: "bold", text: title },
    };
  }

  private expandedToolBlocks(tool: ToolState): RichBlock[] {
    const blocks: RichBlock[] = [this.toolRow(tool)];
    const input = stringify(tool.input);
    const output = stringify(tool.output);
    const content = contentText(tool.content).map((value) => stringify(value)).filter(Boolean).join("\n\n");
    if (input) blocks.push({ type: "pre", text: input, language: "json" });
    if (output) blocks.push({ type: "pre", text: output, language: "json" });
    if (!output && content) blocks.push({ type: "pre", text: content });
    return blocks;
  }

  plainFinal(includeTools: boolean): string {
    const parts = this.projected(includeTools).map((item) => {
      if (item.type === "assistant") return item.markdown.trim();
      const rows = item.tools.map((tool) => {
        const argument = toolArgumentPreview(tool);
        return `${failed(tool.status) ? "✗" : "✓"} ${redactSecrets(tool.title)}${argument ? ` ${argument}` : ""}`;
      });
      return [completedToolSummary(item.tools, this.changedAt), ...rows].join("\n");
    });
    return parts.filter(Boolean).join("\n\n") || "Done.";
  }
}
