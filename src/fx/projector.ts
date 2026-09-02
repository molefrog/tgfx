import type * as acp from "@agentclientprotocol/sdk";
import type { InputRichMessageWithoutUpload } from "grammy/types";
import { redactSecrets } from "../secrets";
import { fxToolIconForTool, mcpIconForTool, type McpIconMap } from "../telegram/mcp-icons";
import { markdownToRichBlocks, type RichBlock } from "../telegram/rich-markdown";
import {
  activitySummary,
  describeTool,
  readsTelegramGuidelines,
  TOOL_ACTIVITY_ORDER,
  type ToolActivity,
} from "./tools";

type AssistantEntry = { type: "assistant"; messageId?: string; markdown: string };
type ToolEntry = { type: "tool"; toolCallId: string };
type TimelineEntry = AssistantEntry | ToolEntry;

export type ToolState = {
  id: string;
  /** fx's tool name from the `tool_call` update; "" when the agent sent none. */
  name: string;
  /** The agent's own label, used only for tools we do not know by name. */
  title: string;
  status: string;
  /** `rawInput` from the update, `{}` until it arrives. */
  input: Record<string, unknown>;
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

type ToolUpdate = Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;

const TOOL_ARGUMENT_PREVIEW_MAX_CHARS = 60;
const TOOL_SUMMARY_CATEGORY_LIMIT = 4;
const THINKING_CUSTOM_EMOJI = {
  type: "custom_emoji" as const,
  custom_emoji_id: "5573473356579078196",
  alternative_text: "🙂",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function terminal(status: string): boolean {
  return status === "completed" || status === "done" || status === "failed" || status === "error";
}

function failed(status: string): boolean {
  return status === "failed" || status === "error";
}

// A tool gets a row as soon as fx names it, because its arguments arrive with
// the name. An unnamed tool (older fx) has nothing to show until it finishes.
function visible(tool: ToolState): boolean {
  return tool.name !== "" || terminal(tool.status);
}

// Everything a row is rendered from; status and progress updates leave it unchanged.
function rowKey(tool: ToolState): string {
  return JSON.stringify([tool.name, tool.title, tool.input]);
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

function argumentPreview(argument: string): string {
  const oneLine = argument.replace(/\s+/gu, " ").trim();
  const characters = [...oneLine];
  if (characters.length <= TOOL_ARGUMENT_PREVIEW_MAX_CHARS) return oneLine;
  return `${characters.slice(0, TOOL_ARGUMENT_PREVIEW_MAX_CHARS - 1).join("")}…`;
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
    if (!terminal(tool.status) || failed(tool.status)) continue;
    const activity = describeTool(tool).activity;
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
      case "tool_call_update":
        return this.patchTool(update) ? "tool" : "none";
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

  private patchTool(update: ToolUpdate): boolean {
    const now = Date.now();
    const id = update.toolCallId;
    const previous = this.tools.get(id);
    if (!previous) this.timeline.push({ type: "tool", toolCallId: id });

    const status = update.status ?? previous?.status ?? "pending";
    const next: ToolState = {
      id,
      name: typeof update.name === "string" ? update.name : previous?.name ?? "",
      title: typeof update.title === "string" ? update.title : previous?.title ?? "Tool",
      status,
      input: isRecord(update.rawInput) ? update.rawInput : previous?.input ?? {},
      startedAt: previous?.startedAt ?? now,
      ...(terminal(status) ? { finishedAt: previous?.finishedAt ?? now } : {}),
    };
    this.tools.set(id, next);
    if (!visible(next)) return false;
    return !previous || !visible(previous) || rowKey(previous) !== rowKey(next);
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
        const shown = group.filter(visible);
        if (shown.length) {
          items.push({ type: "tools", tools: shown });
          rendered = true;
        }
      }
      const hidden = group.length > 0 && !rendered;
      group = [];
      return hidden;
    };

    const suppressBefore = this.guidelinesBootstrapIndex();
    for (const [index, entry] of this.timeline.entries()) {
      if (entry.type === "tool") {
        const tool = this.tools.get(entry.toolCallId);
        if (tool) group.push(tool);
        continue;
      }
      // The bootstrap directive forbids announcing the guidelines read; when the
      // model narrates anyway, drop that preamble instead of relaying it.
      if (index < suppressBefore) continue;

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

  // Timeline index of the guidelines resource read, but only when it is the
  // turn's first tool call (a bootstrap turn); -1 otherwise. Assistant text
  // before that index is a forbidden announcement and is not rendered.
  private guidelinesBootstrapIndex(): number {
    for (const [index, entry] of this.timeline.entries()) {
      if (entry.type !== "tool") continue;
      const tool = this.tools.get(entry.toolCallId);
      return tool && readsTelegramGuidelines(tool.input) ? index : -1;
    }
    return -1;
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

  // fx's own tools get their fx icon; MCP calls get their server's icon. An
  // MCP resource read through `mcp_features` belongs to the server it reads.
  private toolIcon(tool: ToolState): { id: string; fx: boolean } | undefined {
    const server = tool.name === "mcp_features" && typeof tool.input.server === "string"
      ? mcpIconForTool(this.mcpIcons, `mcp_${tool.input.server}`)
      : undefined;
    if (server) return { id: server, fx: false };
    const fx = fxToolIconForTool(this.mcpIcons, tool.name);
    if (fx) return { id: fx, fx: true };
    const mcp = mcpIconForTool(this.mcpIcons, tool.name);
    return mcp ? { id: mcp, fx: false } : undefined;
  }

  private toolRow(tool: ToolState): RichBlock {
    const { title, argument } = describeTool(tool);
    const icon = this.toolIcon(tool);
    const preview = argumentPreview(argument);
    if (!icon && !preview) return { type: "paragraph", text: title };
    return {
      type: "paragraph",
      text: [
        ...(icon
          ? [{ type: "custom_emoji" as const, custom_emoji_id: icon.id, alternative_text: icon.fx ? "🛠️" : "🧩" }, ` ${title}`]
          : [title]),
        ...(preview ? [" ", { type: "code" as const, text: preview }] : []),
      ],
    };
  }

  plainFinal(includeTools: boolean): string {
    const parts = this.projected(includeTools).map((item) => {
      if (item.type === "assistant") return item.markdown.trim();
      const rows = item.tools.map((tool) => {
        const { title, argument } = describeTool(tool);
        const preview = argumentPreview(argument);
        return preview ? `${title} ${preview}` : title;
      });
      return [completedToolSummary(item.tools, this.changedAt), ...rows].join("\n");
    });
    return parts.filter(Boolean).join("\n\n") || "Done.";
  }
}
