import { TELEGRAM_GUIDELINES_URI } from "../mcp/guidelines";
import { TELEGRAM_MCP_TOOL_ROW_TITLES, type TelegramMcpToolName } from "../mcp/tool-labels";
import { redactSecrets } from "../secrets";

export type ToolActivity =
  | "commands"
  | "wrote_files"
  | "edited_files"
  | "read_files"
  | "searched_files"
  | "searched_code"
  | "searched_web"
  | "searched_capabilities"
  | "fetched_pages"
  | "used_skills"
  | "installed_skills"
  | "used_subagents"
  | "inspected_images"
  | "read_tool_results"
  | "asked_user"
  | "used_chat_tools"
  | "used_external_tools";

/** Order of activity phrases inside a tool group summary. */
export const TOOL_ACTIVITY_ORDER: ToolActivity[] = [
  "commands",
  "wrote_files",
  "edited_files",
  "read_files",
  "searched_files",
  "searched_code",
  "searched_web",
  "searched_capabilities",
  "fetched_pages",
  "used_skills",
  "installed_skills",
  "used_subagents",
  "inspected_images",
  "read_tool_results",
  "asked_user",
  "used_chat_tools",
  "used_external_tools",
];

export type ToolDescription = {
  /** Human row title, e.g. "Reading file". */
  title: string;
  /** The one argument that identifies the call, or "" when there is none. */
  argument: string;
  /** What the call counts as in a group summary; absent calls are not counted. */
  activity?: ToolActivity;
};

type ToolInput = Record<string, unknown>;
type Resolver<T> = T | ((input: ToolInput) => T);

type FxToolSpec = {
  title: Resolver<string>;
  argument?: string | ((input: ToolInput) => unknown);
  activity?: Resolver<ToolActivity | undefined>;
};

const ARGUMENT_MAX_CHARS = 800;

function isRecord(value: unknown): value is ToolInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Some fx tools wrap their arguments in `request`; both spellings are seen on the wire. */
function request(input: ToolInput): ToolInput {
  return isRecord(input.request) ? input.request : input;
}

export function readsTelegramGuidelines(input: unknown): boolean {
  return isRecord(input) && input.uri === TELEGRAM_GUIDELINES_URI;
}

/**
 * Every tool fx registers (src/builtins/tools.zig in vercel-labs/fx), keyed by
 * the `name` fx sends on ACP `tool_call` updates. Argument pickers read the
 * matching `rawInput`.
 */
export const FX_TOOLS = {
  read_file: { title: "Reading file", argument: "path", activity: "read_files" },
  glob_files: { title: "Finding files", argument: "pattern", activity: "searched_files" },
  grep_files: { title: "Searching code", argument: "pattern", activity: "searched_code" },
  edit_file: { title: "Editing file", argument: "path", activity: "edited_files" },
  write_file: { title: "Writing file", argument: "path", activity: "wrote_files" },
  shell: {
    title: (input) => request(input).action === "run" ? "Running command" : "Managing shell",
    argument: (input) => request(input).command,
    activity: (input) => request(input).action === "run" ? "commands" : undefined,
  },
  subagent: {
    title: "Running subagent",
    argument: (input) => request(input).task ?? request(input).message,
    activity: "used_subagents",
  },
  capability_search: { title: "Finding tools and skills", argument: "query", activity: "searched_capabilities" },
  skill: { title: "Loading skill", argument: "name", activity: "used_skills" },
  install_skill: { title: "Installing skill", argument: "source", activity: "installed_skills" },
  mcp_select_tool: { title: "Selecting MCP tool", argument: "name" },
  mcp_features: {
    title: (input) => readsTelegramGuidelines(input) ? "Reading guidelines" : "Using MCP resource or prompt",
    argument: (input) => readsTelegramGuidelines(input) ? undefined : input.uri ?? input.prompt ?? input.server,
    activity: (input) => readsTelegramGuidelines(input) ? "used_chat_tools" : "used_external_tools",
  },
  ask_user_question: { title: "Asking a question", activity: "asked_user" },
  web_fetch: { title: "Fetching web page", argument: "url", activity: "fetched_pages" },
  web_search: { title: "Searching web", argument: "query", activity: "searched_web" },
  vision: { title: "Inspecting images", argument: "paths", activity: "inspected_images" },
  read_tool_result: {
    title: "Reading tool result",
    argument: (input) => request(input).query,
    activity: "read_tool_results",
  },
} as const satisfies Record<string, FxToolSpec>;

export type FxToolName = keyof typeof FX_TOOLS;

function resolve<T>(value: Resolver<T>, input: ToolInput): T {
  return typeof value === "function" ? (value as (input: ToolInput) => T)(input) : value;
}

function text(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  let result: string;
  if (typeof value === "string") result = value;
  else if (isRecord(value) && Object.keys(value).length === 0) return "";
  else {
    try { result = JSON.stringify(value); } catch { result = String(value); }
  }
  result = redactSecrets(result);
  return [...result].length > ARGUMENT_MAX_CHARS ? `${[...result].slice(0, ARGUMENT_MAX_CHARS - 1).join("")}…` : result;
}

function telegramToolName(name: string): TelegramMcpToolName | undefined {
  const unqualified = name.replace(/^mcp_telegram_/u, "");
  return unqualified !== name && Object.hasOwn(TELEGRAM_MCP_TOOL_ROW_TITLES, unqualified)
    ? unqualified as TelegramMcpToolName
    : undefined;
}

export function describeTool(call: { name?: string | null; title?: string | null; input?: unknown }): ToolDescription {
  const name = call.name?.trim() ?? "";
  const input = isRecord(call.input) ? call.input : {};

  if (Object.hasOwn(FX_TOOLS, name)) {
    const spec: FxToolSpec = FX_TOOLS[name as FxToolName];
    const picked = typeof spec.argument === "string" ? input[spec.argument] : spec.argument?.(input);
    const activity = resolve(spec.activity, input);
    return {
      title: resolve(spec.title, input),
      argument: text(picked),
      ...(activity ? { activity } : {}),
    };
  }

  const telegram = telegramToolName(name);
  if (telegram) {
    return { title: TELEGRAM_MCP_TOOL_ROW_TITLES[telegram], argument: "", activity: "used_chat_tools" };
  }
  if (name.startsWith("mcp_")) {
    return { title: "Using MCP tool", argument: text(name.slice(4)), activity: "used_external_tools" };
  }
  return { title: redactSecrets(call.title?.trim() || "Tool"), argument: text(input) };
}

function counted(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function activitySummary(activity: ToolActivity, count: number): string {
  switch (activity) {
    case "commands": return `ran ${counted(count, "command")}`;
    case "wrote_files": return `wrote ${counted(count, "file")}`;
    case "edited_files": return `edited ${counted(count, "file")}`;
    case "read_files": return `read ${counted(count, "file")}`;
    case "searched_files": return "searched files";
    case "searched_code": return "searched code";
    case "searched_web": return "searched web";
    case "searched_capabilities": return "searched capabilities";
    case "fetched_pages": return `fetched ${counted(count, "page")}`;
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
