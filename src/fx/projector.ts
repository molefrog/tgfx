import type * as acp from "@agentclientprotocol/sdk";
import type { InputRichMessageWithoutUpload } from "grammy/types";
import {
  TELEGRAM_MCP_TOOL_ROW_TITLES,
  type TelegramMcpToolName,
} from "../mcp/tool-labels";
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

export type ProjectorChange = "none" | "text" | "boundary" | "tool";

const TOOL_ARGUMENT_PREVIEW_MAX_CHARS = 60;
const TOOL_SUMMARY_CATEGORY_LIMIT = 4;
const THINKING_CUSTOM_EMOJI = {
  type: "custom_emoji" as const,
  custom_emoji_id: "5573473356579078196",
  alternative_text: "🙂",
};

type ToolActivity =
  | "commands"
  | "created_files"
  | "created_folders"
  | "wrote_files"
  | "edited_files"
  | "read_files"
  | "searched"
  | "searched_files"
  | "searched_code"
  | "searched_web"
  | "fetched_pages"
  | "inspected_files"
  | "opened_files"
  | "inspected_media"
  | "inspected_tool_results"
  | "deleted_files"
  | "copied_files"
  | "renamed_files"
  | "moved_files"
  | "used_terminal"
  | "used_memory"
  | "used_skills"
  | "used_subagents"
  | "asked_user"
  | "used_telegram"
  | "used_external_tools"
  | "failed";

const TOOL_ACTIVITY_ORDER: ToolActivity[] = [
  "commands",
  "created_files",
  "created_folders",
  "wrote_files",
  "edited_files",
  "read_files",
  "searched",
  "searched_files",
  "searched_code",
  "searched_web",
  "fetched_pages",
  "inspected_files",
  "opened_files",
  "inspected_media",
  "inspected_tool_results",
  "deleted_files",
  "copied_files",
  "renamed_files",
  "moved_files",
  "used_terminal",
  "used_memory",
  "used_skills",
  "used_subagents",
  "asked_user",
  "used_telegram",
  "used_external_tools",
  "failed",
];

const PROVIDER_SEARCH_TOOLS = new Set(["perplexity_search", "parallel_search"]);

type CanonicalToolRule = ToolActivity | "omit" | "terminal" | "write_file";

/**
 * FX owns one built-in tool catalog regardless of the selected model provider.
 * Keep this table keyed by that catalog instead of teaching the UI provider-
 * specific spellings. FX 0.0.6 omits `name` over ACP, so title/kind fallback
 * remains below for the wire format it emits today.
 */
const CANONICAL_FX_TOOL_RULES = {
  list_files: "searched_files",
  glob_files: "searched_files",
  grep_files: "searched_code",
  semantic_search: "searched_code",
  read_file: "read_files",
  write_file: "write_file",
  edit_file: "edited_files",
  delete_file: "deleted_files",
  rename_file: "renamed_files",
  copy_file: "copied_files",
  create_folder: "created_folders",
  file_info: "inspected_files",
  open_file: "opened_files",
  terminal: "terminal",
  // Retained for FX releases that expose the documented legacy command name.
  run_command: "commands",
  web_search: "searched_web",
  web_fetch: "fetched_pages",
  vision: "inspected_media",
  memory: "used_memory",
  skill: "used_skills",
  install_skill: "used_skills",
  subagent: "used_subagents",
  ask_user_question: "asked_user",
  read_tool_result: "inspected_tool_results",
  mcp_search_tools: "omit",
  mcp_select_tool: "omit",
  mcp_features: "used_external_tools",
} as const satisfies Record<string, CanonicalToolRule>;

type CanonicalFxToolName = keyof typeof CANONICAL_FX_TOOL_RULES;

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

function assistantChange(text: string): ProjectorChange {
  return /(?:\n\s*\n|[.!?](?:["')\]]*)\s*|```\s*|\$\$\s*)$/u.test(text)
    ? "boundary"
    : "text";
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

function toolTitle(tool: ToolState): string {
  return tool.title.trim().toLowerCase();
}

function canonicalFxToolName(identity: string): CanonicalFxToolName | undefined {
  return Object.hasOwn(CANONICAL_FX_TOOL_RULES, identity)
    ? identity as CanonicalFxToolName
    : undefined;
}

function telegramToolName(identity: string): TelegramMcpToolName | undefined {
  const unqualified = identity.replace(/^mcp_telegram_/, "");
  return Object.hasOwn(TELEGRAM_MCP_TOOL_ROW_TITLES, unqualified)
    ? unqualified as TelegramMcpToolName
    : undefined;
}

function dynamicMcpTool(identity: string): boolean {
  return /^mcp_[a-z0-9_-]+_/u.test(identity);
}

function displayToolTitle(tool: ToolState): string {
  const name = toolName(tool);
  if (canonicalFxToolName(name)) return tool.title;
  const namedTelegram = telegramToolName(name);
  if (namedTelegram) return TELEGRAM_MCP_TOOL_ROW_TITLES[namedTelegram];
  if (PROVIDER_SEARCH_TOOLS.has(name)) return "Searching web";
  if (dynamicMcpTool(name)) return tool.title;

  const titledTelegram = telegramToolName(toolTitle(tool));
  if (titledTelegram) return TELEGRAM_MCP_TOOL_ROW_TITLES[titledTelegram];
  if (PROVIDER_SEARCH_TOOLS.has(toolTitle(tool))) return "Searching web";
  return tool.title;
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

function terminalActivity(tool: ToolState): ToolActivity {
  const input = tool.input && typeof tool.input === "object"
    ? tool.input as { action?: unknown; kind?: unknown }
    : undefined;
  const action = typeof input?.action === "string"
    ? input.action
    : typeof input?.kind === "string" ? input.kind : undefined;
  return action === "exec" || action === "start"
    || titleStartsWith(tool, /^(?:running|starting)\b/iu)
    ? "commands"
    : "used_terminal";
}

function searchActivity(tool: ToolState): ToolActivity {
  const evidenceParts = [
    ...contentText(tool.content),
    stringify(tool.output, 4_000, false),
  ].filter(Boolean);
  const evidence = evidenceParts.join("\n");
  if (/^\[glob\]\s/imu.test(evidence)) return "searched_files";
  if (/^\[(?:grep|search)\]\s/imu.test(evidence)) return "searched_code";
  if (/^(?:Web search results for query: |Search results from |Search error: |Incomplete search result \()/imu.test(evidence)) {
    return "searched_web";
  }
  for (const part of evidenceParts) {
    try {
      const value: unknown = JSON.parse(part);
      if (value && typeof value === "object"
        && typeof (value as { id?: unknown }).id === "string"
        && Array.isArray((value as { results?: unknown }).results)
      ) return "searched_web";
    } catch { /* Non-JSON search previews are handled by their stable text markers. */ }
  }
  if (titleStartsWith(tool, /\bweb\b/iu)) return "searched_web";
  if (titleStartsWith(tool, /\bcode\b/iu)) return "searched_code";
  return "searched";
}

function canonicalActivity(tool: ToolState, name: CanonicalFxToolName): ToolActivity | undefined {
  const rule = CANONICAL_FX_TOOL_RULES[name];
  if (rule === "omit") return undefined;
  if (rule === "terminal") return terminalActivity(tool);
  if (rule === "write_file") return hasNewFileDiff(tool) ? "created_files" : "wrote_files";
  return rule;
}

function toolActivity(tool: ToolState): ToolActivity | undefined {
  if (failed(tool.status)) return "failed";
  const name = toolName(tool);
  const namedCanonical = canonicalFxToolName(name);
  if (namedCanonical) return canonicalActivity(tool, namedCanonical);
  if (telegramToolName(name)) return "used_telegram";
  if (PROVIDER_SEARCH_TOOLS.has(name)) return "searched_web";
  if (dynamicMcpTool(name)) return "used_external_tools";

  const title = toolTitle(tool);
  if (telegramToolName(title)) return "used_telegram";
  if (PROVIDER_SEARCH_TOOLS.has(title)) return "searched_web";
  const titledCanonical = canonicalFxToolName(title);
  if (titledCanonical) return canonicalActivity(tool, titledCanonical);

  switch (tool.kind) {
    case "execute":
      return terminalActivity(tool);
    case "read":
      if (titleStartsWith(tool, /^fetching\b/iu)) return "fetched_pages";
      if (titleStartsWith(tool, /^(?:listing|matching)\b/iu)) return "searched_files";
      if (titleStartsWith(tool, /^searching\b/iu)) return searchActivity(tool);
      if (titleStartsWith(tool, /^reading\b/iu)) return "read_files";
      if (titleStartsWith(tool, /^inspecting\b/iu)) return "inspected_files";
      return tool.title.trim() ? undefined : "read_files";
    case "edit":
      if (hasNewFileDiff(tool)) return "created_files";
      if (titleStartsWith(tool, /^creating\b/iu)) return "created_folders";
      if (titleStartsWith(tool, /^writing\b/iu)) return "wrote_files";
      return "edited_files";
    case "search":
      return searchActivity(tool);
    case "fetch":
      return "fetched_pages";
    case "delete":
      return "deleted_files";
    case "move":
      if (titleStartsWith(tool, /^copying\b/iu)) return "copied_files";
      if (titleStartsWith(tool, /^renaming\b/iu)) return "renamed_files";
      return "moved_files";
    default:
      if (titleStartsWith(tool, /^opening\b/iu)) return "opened_files";
      if (titleStartsWith(tool, /^inspecting\b/iu)) return "inspected_media";
      if (titleStartsWith(tool, /^(?:remembering|listing)\b/iu)) return "used_memory";
      if (titleStartsWith(tool, /^(?:loading|installing) skill\b/iu)) return "used_skills";
      if (titleStartsWith(tool, /^managing\b/iu)) return "used_subagents";
      if (titleStartsWith(tool, /^asking\b/iu)) return "asked_user";
      if (titleStartsWith(tool, /^reading\b/iu)) return "inspected_tool_results";
      if (titleStartsWith(tool, /^(?:searching|selecting) MCP tool/iu)) return undefined;
      if (titleStartsWith(tool, /^using MCP feature/iu)) return "used_external_tools";
      if (dynamicMcpTool(title)) return "used_external_tools";
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
    case "created_folders": return `created ${counted(count, "folder")}`;
    case "wrote_files": return `wrote ${counted(count, "file")}`;
    case "edited_files": return `edited ${counted(count, "file")}`;
    case "read_files": return `read ${counted(count, "file")}`;
    case "searched": return "searched";
    case "searched_files": return "searched files";
    case "searched_code": return "searched code";
    case "searched_web": return "searched web";
    case "fetched_pages": return `fetched ${counted(count, "page")}`;
    case "inspected_files": return `inspected ${counted(count, "file")}`;
    case "opened_files": return `opened ${counted(count, "file")}`;
    case "inspected_media": return "inspected media";
    case "inspected_tool_results": return "inspected tool results";
    case "deleted_files": return `deleted ${counted(count, "file")}`;
    case "copied_files": return `copied ${counted(count, "file")}`;
    case "renamed_files": return `renamed ${counted(count, "file")}`;
    case "moved_files": return `moved ${counted(count, "file")}`;
    case "used_terminal": return "used terminal";
    case "used_memory": return "used memory";
    case "used_skills": return "used skills";
    case "used_subagents": return "used subagents";
    case "asked_user": return "asked user";
    case "used_telegram": return "used Telegram";
    case "used_external_tools": return "used external tools";
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
  for (const tool of tools) {
    const activity = toolActivity(tool);
    if (!activity) continue;
    counts.set(activity, (counts.get(activity) ?? 0) + 1);
  }

  const activities = TOOL_ACTIVITY_ORDER.filter((activity) => counts.has(activity));
  if (!activities.length) return `Worked for ${toolGroupSeconds(tools, changedAt)}s`;

  const visible = activities.slice(0, TOOL_SUMMARY_CATEGORY_LIMIT);
  const hiddenCategories = activities.length - visible.length;
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

  apply(update: acp.SessionUpdate): ProjectorChange {
    this.changedAt = Date.now();
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type !== "text") return "none";
        const text = update.content.text;
        const ownDiagnostic = diagnosticOffset(text);
        if (ownDiagnostic === 0) return "none";
        const visible = ownDiagnostic > 0 ? text.slice(0, ownDiagnostic) : text;
        if (!visible) return "none";

        const messageId = update.messageId ?? undefined;
        const tail = this.timeline.at(-1);
        if (tail?.type === "assistant" && tail.messageId === messageId) {
          const combined = tail.markdown + visible;
          const combinedDiagnostic = diagnosticOffset(combined);
          tail.markdown = combinedDiagnostic >= 0 ? combined.slice(0, combinedDiagnostic) : combined;
        } else {
          this.timeline.push({ type: "assistant", ...(messageId ? { messageId } : {}), markdown: visible });
        }
        return assistantChange(visible);
      }
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return "none";
        const messageId = update.messageId ?? undefined;
        if (!this.hasThought) {
          this.hasThought = true;
          this.firstThoughtMessageId = messageId;
          this.thought = update.content.text;
        } else if (messageId === this.firstThoughtMessageId) {
          this.thought += update.content.text;
        }
        return "none";
      }
      case "tool_call":
        return this.patchTool(update.toolCallId, update) ? "tool" : "none";
      case "tool_call_update":
        return this.patchTool(update.toolCallId, update) ? "tool" : "none";
      case "available_commands_update":
        this.commands = update.availableCommands.map((command) => ({
          name: command.name,
          description: command.description,
          ...(command.input ? { input: command.input } : {}),
        }));
        return "none";
      default:
        return "none";
    }
  }

  private patchTool(
    id: string,
    update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
  ): boolean {
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
    const previousVisible = previous ? terminal(previous.status) : false;
    const nextVisible = terminal(next.status);
    if (previousVisible !== nextVisible) return true;
    return nextVisible && JSON.stringify(previous) !== JSON.stringify(next);
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

    const flushTools = (): boolean => {
      let rendered = false;
      if (includeTools) {
        const visible = group.filter((tool) => terminal(tool.status));
        if (visible.length) {
          items.push({ type: "tools", tools: visible });
          rendered = true;
        }
      }
      const hidden = group.length > 0 && !rendered;
      group = [];
      return hidden;
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
      const hiddenToolBoundary = flushTools();
      const previous = items.at(-1);
      const previousBlock = previous?.type === "assistant" ? previous.blocks.at(-1) : undefined;
      if (hiddenToolBoundary && previousBlock?.type === "paragraph" && blocks[0]?.type === "paragraph") {
        previousBlock.text = Array.isArray(previousBlock.text)
          ? [...previousBlock.text, "\n\n"]
          : [previousBlock.text, "\n\n"];
      }
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
      return { blocks: [{ type: "thinking", text: [THINKING_CUSTOM_EMOJI, " Thinking…"] }] };
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
    const title = `${failed(tool.status) ? "✗" : "✓"} ${redactSecrets(displayToolTitle(tool))}`;
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
        return `${failed(tool.status) ? "✗" : "✓"} ${redactSecrets(displayToolTitle(tool))}${argument ? ` ${argument}` : ""}`;
      });
      return [completedToolSummary(item.tools, this.changedAt), ...rows].join("\n");
    });
    return parts.filter(Boolean).join("\n\n") || "Done.";
  }
}
