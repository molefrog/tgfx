import type * as acp from "@agentclientprotocol/sdk";
import type { InputRichMessageWithoutUpload } from "grammy/types";
import {
  TELEGRAM_MCP_TOOL_ROW_TITLES,
  type TelegramMcpToolName,
} from "../mcp/tool-labels";
import { redactSecrets } from "../secrets";
import { fxToolIconForTool, mcpIconForTool, type McpIconMap } from "../telegram/mcp-icons";
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
  | "wrote_files"
  | "edited_files"
  | "read_files"
  | "searched"
  | "searched_files"
  | "searched_code"
  | "searched_web"
  | "searched_capabilities"
  | "searched_skills"
  | "searched_mcp_tools"
  | "fetched_pages"
  | "used_terminal"
  | "used_memory"
  | "used_skills"
  | "installed_skills"
  | "used_subagents"
  | "inspected_images"
  | "read_tool_results"
  | "asked_user"
  | "used_chat_tools"
  | "used_external_tools";

const TOOL_ACTIVITY_ORDER: ToolActivity[] = [
  "commands",
  "created_files",
  "wrote_files",
  "edited_files",
  "read_files",
  "searched",
  "searched_files",
  "searched_code",
  "searched_web",
  "searched_capabilities",
  "searched_skills",
  "searched_mcp_tools",
  "fetched_pages",
  "used_terminal",
  "used_memory",
  "used_skills",
  "installed_skills",
  "used_subagents",
  "inspected_images",
  "read_tool_results",
  "asked_user",
  "used_chat_tools",
  "used_external_tools",
];

const PROVIDER_SEARCH_TOOLS = new Set(["perplexity_search", "parallel_search"]);

type CanonicalToolRule = ToolActivity | "omit" | "terminal" | "write_file";

/**
 * FX owns one built-in tool catalog regardless of the selected model provider.
 * This is the complete registered FX tool catalog. FX omits `name` over ACP, so
 * the title/kind/content fallback below mirrors its stable wire labels.
 */
const CANONICAL_FX_TOOL_RULES = {
  glob_files: "searched_files",
  grep_files: "searched_code",
  read_file: "read_files",
  write_file: "write_file",
  edit_file: "edited_files",
  terminal: "terminal",
  subagent: "used_subagents",
  capability_search: "searched_capabilities",
  skill_search: "searched_skills",
  skill: "used_skills",
  install_skill: "installed_skills",
  mcp_search_tools: "searched_mcp_tools",
  mcp_select_tool: "omit",
  mcp_features: "used_external_tools",
  memory: "used_memory",
  ask_user_question: "asked_user",
  vision: "inspected_images",
  read_tool_result: "read_tool_results",
  web_search: "searched_web",
  web_fetch: "fetched_pages",
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

function inferredCanonicalFxToolName(tool: ToolState): CanonicalFxToolName | undefined {
  const named = canonicalFxToolName(toolName(tool));
  if (named) return named;
  const titled = canonicalFxToolName(toolTitle(tool));
  if (titled) return titled;

  if (tool.kind === "execute") return "terminal";
  if (titleStartsWith(tool, /^search(?:ing|ed) MCP tools\b/iu)) return "mcp_search_tools";
  if (titleStartsWith(tool, /^select(?:ing|ed) MCP tool\b/iu)) return "mcp_select_tool";
  if (titleStartsWith(tool, /^using MCP feature\b/iu)) return "mcp_features";
  if (titleStartsWith(tool, /^search(?:ing|ed) capabilities\b/iu)) return "capability_search";
  if (titleStartsWith(tool, /^search(?:ing|ed) skills\b/iu)) return "skill_search";
  if (titleStartsWith(tool, /^load(?:ing|ed) skill\b/iu)) return "skill";
  if (titleStartsWith(tool, /^install(?:ing|ed) skill\b/iu)) return "install_skill";
  if (titleStartsWith(tool, /^(?:remembering|remembered|listing|listed)\b/iu)) return "memory";
  if (titleStartsWith(tool, /^ask(?:ing|ed)\b/iu)) return "ask_user_question";
  if (titleStartsWith(tool, /^inspect(?:ing|ed)\b/iu)) return "vision";
  if (titleStartsWith(tool, /^read(?:ing)?\s+tool result\b/iu)) return "read_tool_result";
  if (titleStartsWith(tool, /^manag(?:ing|ed)\b/iu)) return "subagent";
  if (tool.kind === "read" && titleStartsWith(tool, /^match(?:ing|ed)\b/iu)) return "glob_files";
  if (tool.kind === "read" && titleStartsWith(tool, /^read(?:ing)?\b/iu)) return "read_file";
  if (tool.kind === "read" && titleStartsWith(tool, /^fetch(?:ing|ed)\b/iu)) return "web_fetch";
  if (tool.kind === "edit" && titleStartsWith(tool, /^writ(?:ing|ten)\b/iu)) return "write_file";
  if (tool.kind === "edit") return "edit_file";
  if (tool.kind === "search") {
    const activity = searchActivity(tool);
    if (activity === "searched_code") return "grep_files";
    if (activity === "searched_web") return "web_search";
  }
  return undefined;
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

function terminalAction(tool: ToolState): string | undefined {
  if (!tool.input || typeof tool.input !== "object") return undefined;
  const input = tool.input as { action?: unknown; kind?: unknown; request?: unknown };
  const request = input.request && typeof input.request === "object"
    ? input.request as { action?: unknown; kind?: unknown }
    : undefined;
  const action = input.action ?? input.kind ?? request?.action ?? request?.kind;
  return typeof action === "string" ? action : undefined;
}

function terminalRowTitle(tool: ToolState): string {
  const action = terminalAction(tool);
  return action === "exec" || action === "start"
    || titleStartsWith(tool, /^(?:running|starting)\b/iu)
    ? "Running command"
    : "Managing terminal";
}

function canonicalToolRowTitle(tool: ToolState, name: CanonicalFxToolName): string {
  switch (name) {
    case "glob_files": return "Finding files";
    case "grep_files": return "Searching code";
    case "read_file": return "Reading file";
    case "write_file": return hasNewFileDiff(tool) ? "Creating file" : "Writing file";
    case "edit_file": return "Editing file";
    case "terminal": return terminalRowTitle(tool);
    case "subagent": return "Running subagent";
    case "capability_search": return "Finding tools and skills";
    case "skill_search": return "Searching skills";
    case "skill": return "Loading skill";
    case "install_skill": return "Installing skill";
    case "mcp_search_tools": return "Searching MCP tools";
    case "mcp_select_tool": return "Selecting MCP tool";
    case "mcp_features": return "Using MCP resource or prompt";
    case "memory": return titleStartsWith(tool, /^listing\b/iu) ? "Listing memories" : "Saving memory";
    case "ask_user_question": return "Asking a question";
    case "vision": return "Inspecting images";
    case "read_tool_result": return "Reading tool result";
    case "web_fetch": return "Fetching web page";
    case "web_search": return "Searching web";
  }
}

function fxWireToolRowTitle(tool: ToolState): string | undefined {
  if (tool.kind === "execute") return terminalRowTitle(tool);
  if (tool.kind === "read" && titleStartsWith(tool, /^matching\b/iu)) return "Finding files";
  if (tool.kind === "read" && titleStartsWith(tool, /^reading\b/iu)) return "Reading file";
  if (tool.kind === "read" && titleStartsWith(tool, /^fetching\b/iu)) return "Fetching web page";
  if (tool.kind === "edit" && titleStartsWith(tool, /^writing\b/iu)) {
    return hasNewFileDiff(tool) ? "Creating file" : "Writing file";
  }
  if (tool.kind === "edit" && titleStartsWith(tool, /^editing\b/iu)) return "Editing file";
  if (tool.kind === "search" && titleStartsWith(tool, /^searching\b/iu)) {
    const activity = searchActivity(tool);
    if (activity === "searched_code") return "Searching code";
    if (activity === "searched_web") return "Searching web";
    return "Searching";
  }
  if (titleStartsWith(tool, /^searching capabilities\b/iu)) return "Finding tools and skills";
  if (titleStartsWith(tool, /^search(?:ing|ed) skills\b/iu)) return "Searching skills";
  if (titleStartsWith(tool, /^search(?:ing|ed) MCP tools\b/iu)) return "Searching MCP tools";
  if (titleStartsWith(tool, /^loading skill\b/iu)) return "Loading skill";
  if (titleStartsWith(tool, /^installing skill\b/iu)) return "Installing skill";
  if (titleStartsWith(tool, /^managing\b/iu)) return "Running subagent";
  if (titleStartsWith(tool, /^selecting MCP tool\b/iu)) return "Selecting MCP tool";
  if (titleStartsWith(tool, /^using MCP feature\b/iu)) return "Using MCP resource or prompt";
  if (titleStartsWith(tool, /^listing\b/iu)) return "Listing memories";
  if (titleStartsWith(tool, /^remembering\b/iu)) return "Saving memory";
  if (titleStartsWith(tool, /^asking\b/iu)) return "Asking a question";
  if (titleStartsWith(tool, /^inspect(?:ing|ed)\b/iu)) return "Inspecting images";
  if (titleStartsWith(tool, /^read(?:ing)?\s+tool result\b/iu)) return "Reading tool result";
  return undefined;
}

function displayToolTitle(tool: ToolState): string {
  const name = toolName(tool);
  const namedCanonical = canonicalFxToolName(name);
  if (namedCanonical) return canonicalToolRowTitle(tool, namedCanonical);
  const namedTelegram = telegramToolName(name);
  if (namedTelegram) return TELEGRAM_MCP_TOOL_ROW_TITLES[namedTelegram];
  if (PROVIDER_SEARCH_TOOLS.has(name)) return "Searching web";
  if (dynamicMcpTool(name)) return tool.title;

  const titledTelegram = telegramToolName(toolTitle(tool));
  if (titledTelegram) return TELEGRAM_MCP_TOOL_ROW_TITLES[titledTelegram];
  if (PROVIDER_SEARCH_TOOLS.has(toolTitle(tool))) return "Searching web";
  const titledCanonical = canonicalFxToolName(toolTitle(tool));
  if (titledCanonical) return canonicalToolRowTitle(tool, titledCanonical);
  const wireTitle = fxWireToolRowTitle(tool);
  if (wireTitle) return wireTitle;
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
  const action = terminalAction(tool);
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
  if (failed(tool.status)) return undefined;
  const name = toolName(tool);
  const namedCanonical = canonicalFxToolName(name);
  if (namedCanonical) return canonicalActivity(tool, namedCanonical);
  if (telegramToolName(name)) return "used_chat_tools";
  if (PROVIDER_SEARCH_TOOLS.has(name)) return "searched_web";
  if (dynamicMcpTool(name)) return "used_external_tools";

  const title = toolTitle(tool);
  if (telegramToolName(title)) return "used_chat_tools";
  if (PROVIDER_SEARCH_TOOLS.has(title)) return "searched_web";
  const titledCanonical = canonicalFxToolName(title);
  if (titledCanonical) return canonicalActivity(tool, titledCanonical);
  if (titleStartsWith(tool, /^search(?:ing|ed) skills\b/iu)) return "searched_skills";
  if (titleStartsWith(tool, /^search(?:ing|ed) MCP tools\b/iu)) return "searched_mcp_tools";
  if (titleStartsWith(tool, /^inspect(?:ing|ed)\b/iu)) return "inspected_images";
  if (titleStartsWith(tool, /^read(?:ing)?\s+tool result\b/iu)) return "read_tool_results";

  switch (tool.kind) {
    case "execute":
      return terminalActivity(tool);
    case "read":
      if (titleStartsWith(tool, /^fetching\b/iu)) return "fetched_pages";
      if (titleStartsWith(tool, /^matching\b/iu)) return "searched_files";
      if (titleStartsWith(tool, /^searching\b/iu)) return searchActivity(tool);
      if (titleStartsWith(tool, /^reading\b/iu)) return "read_files";
      return tool.title.trim() ? undefined : "read_files";
    case "edit":
      if (hasNewFileDiff(tool)) return "created_files";
      if (titleStartsWith(tool, /^writing\b/iu)) return "wrote_files";
      return "edited_files";
    case "search":
      return searchActivity(tool);
    case "fetch":
      return "fetched_pages";
    default:
      if (titleStartsWith(tool, /^(?:remembering|listing)\b/iu)) return "used_memory";
      if (titleStartsWith(tool, /^searching capabilities\b/iu)) return "searched_capabilities";
      if (titleStartsWith(tool, /^search(?:ing|ed) skills\b/iu)) return "searched_skills";
      if (titleStartsWith(tool, /^search(?:ing|ed) MCP tools\b/iu)) return "searched_mcp_tools";
      if (titleStartsWith(tool, /^loading skill\b/iu)) return "used_skills";
      if (titleStartsWith(tool, /^installing skill\b/iu)) return "installed_skills";
      if (titleStartsWith(tool, /^managing\b/iu)) return "used_subagents";
      if (titleStartsWith(tool, /^asking\b/iu)) return "asked_user";
      if (titleStartsWith(tool, /^inspect(?:ing|ed)\b/iu)) return "inspected_images";
      if (titleStartsWith(tool, /^read(?:ing)?\s+tool result\b/iu)) return "read_tool_results";
      if (titleStartsWith(tool, /^selecting MCP tool/iu)) return undefined;
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
    case "wrote_files": return `wrote ${counted(count, "file")}`;
    case "edited_files": return `edited ${counted(count, "file")}`;
    case "read_files": return `read ${counted(count, "file")}`;
    case "searched": return "searched";
    case "searched_files": return "searched files";
    case "searched_code": return "searched code";
    case "searched_web": return "searched web";
    case "searched_capabilities": return "searched capabilities";
    case "searched_skills": return "searched skills";
    case "searched_mcp_tools": return "searched MCP tools";
    case "fetched_pages": return `fetched ${counted(count, "page")}`;
    case "used_terminal": return "used terminal";
    case "used_memory": return "used memory";
    case "used_skills": return "used skills";
    case "installed_skills": return `installed ${counted(count, "skill")}`;
    case "used_subagents": return "used subagents";
    case "inspected_images": return "inspected images";
    case "read_tool_results": return `read ${counted(count, "tool result")}`;
    case "asked_user": return "asked user";
    case "used_chat_tools": return "used chat tools";
    case "used_external_tools": return "used external tools";
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

  constructor(private readonly mcpIcons: McpIconMap = {}) {}

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
    expandStreamingTools: boolean;
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
        !options.final,
        !options.final && options.expandStreamingTools,
      )];
    });
    return { blocks };
  }

  private toolGroupBlock(
    tools: ToolState[],
    working: boolean,
    expanded: boolean,
  ): RichBlock {
    const blocks = tools.map((tool) => this.toolRow(tool));
    return {
      type: "details",
      summary: working ? "Working..." : completedToolSummary(tools, this.changedAt),
      blocks,
      ...(expanded ? { is_open: true as const } : {}),
    };
  }

  private toolRow(tool: ToolState): RichBlock {
    const argument = toolArgumentPreview(tool);
    const displayTitle = redactSecrets(displayToolTitle(tool));
    const canonicalName = inferredCanonicalFxToolName(tool);
    const fxIconId = canonicalName
      ? fxToolIconForTool(this.mcpIcons, canonicalName)
      : undefined;
    const iconId = fxIconId
      ?? mcpIconForTool(this.mcpIcons, tool.name ?? "")
      ?? mcpIconForTool(this.mcpIcons, tool.title);
    const title = iconId
      ? [
          {
            type: "custom_emoji" as const,
            custom_emoji_id: iconId,
            alternative_text: fxIconId ? "🛠️" : "🧩",
          },
          ` ${displayTitle}`,
        ]
      : [displayTitle];
    return {
      type: "paragraph",
      text: argument
        ? [...title, " ", { type: "code", text: argument }]
        : iconId ? title : title[0]!,
    };
  }

  plainFinal(includeTools: boolean): string {
    const parts = this.projected(includeTools).map((item) => {
      if (item.type === "assistant") return item.markdown.trim();
      const rows = item.tools.map((tool) => {
        const argument = toolArgumentPreview(tool);
        return `${redactSecrets(displayToolTitle(tool))}${argument ? ` ${argument}` : ""}`;
      });
      return [completedToolSummary(item.tools, this.changedAt), ...rows].join("\n");
    });
    return parts.filter(Boolean).join("\n\n") || "Done.";
  }
}
