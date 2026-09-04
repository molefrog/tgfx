import type * as acp from "@agentclientprotocol/sdk";
import type { InputRichMessageWithoutUpload } from "grammy/types";
import { redactSecrets } from "../secrets";
import { fxToolIconForTool, mcpIconForTool, type McpIconMap } from "../telegram/mcp-icons";
import { markdownToRichBlocks, type RichBlock } from "../telegram/rich-markdown";
import type { OutputMode } from "../types";
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
  /** ACP's coarse kind (read, execute, search…), the activity hint when the name is missing. */
  kind?: string;
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

/** `status`: only the progress line changed, so a live draft has nothing new. */
export type ProjectorChange = "none" | "text" | "boundary" | "tool" | "status";

type ToolUpdate = Extract<acp.SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>;

const TOOL_ARGUMENT_PREVIEW_MAX_CHARS = 60;
const TOOL_SUMMARY_CATEGORY_LIMIT = 4;
const THINKING_CUSTOM_EMOJI = {
  type: "custom_emoji" as const,
  custom_emoji_id: "5573473356579078196",
  alternative_text: "🙂",
};
/** The thinking placeholder starts counting only once a wait is noticeable. */
const THINKING_ELAPSED_AFTER_MS = 5_000;
const THINKING = "Thinking…";
const WORKING = "Working…";
/**
 * In progress mode the status line names what fx is up to, roughly. A new
 * activity shows at once; falling back to an idle phrase waits this long, so
 * the gap between one tool finishing and the next starting is not a flicker.
 */
const PROGRESS_HOLD_MS = 2_500;
const PROGRESS_PHRASES: Record<ToolActivity, string> = {
  commands: "Running commands…",
  wrote_files: "Editing files…",
  edited_files: "Editing files…",
  read_files: "Reading files…",
  searched_files: "Searching code…",
  searched_code: "Searching code…",
  searched_web: "Browsing the web…",
  fetched_pages: "Browsing the web…",
  searched_capabilities: "Loading skills…",
  used_skills: "Loading skills…",
  installed_skills: "Loading skills…",
  used_subagents: "Running subagents…",
  inspected_images: "Looking at images…",
  read_tool_results: "Reading results…",
  asked_user: "Asking a question…",
  used_chat_tools: "Using Telegram…",
  used_external_tools: "Using tools…",
};

/** `answer` and `progress` deliver the answer alone; the other modes show the work. */
function answerOnly(output: OutputMode): boolean {
  return output === "answer" || output === "progress";
}

function progressPhrase(tool: ToolState): string {
  const { activity } = describeTool(tool);
  return activity ? PROGRESS_PHRASES[activity] : WORKING;
}

function idlePhrase(text: string): boolean {
  return text === THINKING || text === WORKING;
}

function elapsedSeconds(from: number, to: number): number {
  return Math.max(1, Math.round((to - from) / 1_000));
}

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
  private waiting?: string;
  private firstThoughtMessageId?: string;
  private hasThought = false;
  private timeline: TimelineEntry[] = [];
  private tools = new Map<string, ToolState>();
  private commands: TimelineSnapshot["commands"] = [];
  private readonly startedAt: number;
  private changedAt: number;
  /** What the progress line should say, and what it says until the hold expires. */
  private wantedPhrase = THINKING;
  private phase: { text: string; since: number };

  constructor(
    private readonly mcpIcons: McpIconMap = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.startedAt = clock();
    this.changedAt = this.startedAt;
    this.phase = { text: THINKING, since: this.startedAt };
  }

  apply(update: acp.SessionUpdate): ProjectorChange {
    this.changedAt = this.clock();
    const shown = this.phase.text;
    const change = this.applyUpdate(update);
    // Settle the progress line now, so a later update is not blamed for this one's news.
    const line = this.progressLine(this.changedAt);
    return change === "none" && line !== shown ? "status" : change;
  }

  private applyUpdate(update: acp.SessionUpdate): ProjectorChange {
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
        if (!this.toolInProgress()) this.wantedPhrase = THINKING;
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
    const now = this.clock();
    const id = update.toolCallId;
    const previous = this.tools.get(id);
    if (!previous) this.timeline.push({ type: "tool", toolCallId: id });

    const reported = update.status ?? previous?.status ?? "pending";
    // fx marks a yielded `run` completed, then streams the command's late output
    // as `in_progress` on the same call without completing it again. A finished
    // row stays finished; only its content changed.
    const status = previous && terminal(previous.status) && !terminal(reported) ? previous.status : reported;
    const kind = typeof update.kind === "string" ? update.kind : previous?.kind;
    const next: ToolState = {
      id,
      name: typeof update.name === "string" ? update.name : previous?.name ?? "",
      title: typeof update.title === "string" ? update.title : previous?.title ?? "Tool",
      ...(kind ? { kind } : {}),
      status,
      input: isRecord(update.rawInput) ? update.rawInput : previous?.input ?? {},
      startedAt: previous?.startedAt ?? now,
      ...(terminal(status) ? { finishedAt: previous?.finishedAt ?? now } : {}),
    };
    this.tools.set(id, next);
    // The progress line follows every call, even one that has no row yet.
    this.wantedPhrase = progressPhrase(next);
    if (!visible(next)) return false;
    return !previous || !visible(previous) || rowKey(previous) !== rowKey(next);
  }

  private toolInProgress(): boolean {
    for (const tool of this.tools.values()) if (!terminal(tool.status)) return true;
    return false;
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

  private projected(): ProjectedItem[] {
    const items: ProjectedItem[] = [];
    let group: ToolState[] = [];

    // True when the group had tools but none had a row to show (unnamed and
    // still running), so the prose around it needs its own paragraph break.
    const flushTools = (): boolean => {
      const shown = group.filter(visible);
      if (shown.length) items.push({ type: "tools", tools: shown });
      const hidden = group.length > 0 && !shown.length;
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

  /**
   * The answer: the last run of prose, ignoring a tool call that comes after
   * it (a reaction, a sent file). While drafting, prose only counts once the
   * tools are behind it; anything fx said before a tool was narration.
   */
  private answer(items: ProjectedItem[], draft: boolean): Extract<ProjectedItem, { type: "assistant" }>[] {
    let end = items.length;
    if (!draft) {
      while (end > 0 && items[end - 1]!.type === "tools") end--;
    }
    let start = end;
    while (start > 0 && items[start - 1]!.type === "assistant") start--;
    return items.slice(start, end) as Extract<ProjectedItem, { type: "assistant" }>[];
  }

  private progressLine(now: number): string {
    const wanted = this.wantedPhrase;
    if (wanted !== this.phase.text && (!idlePhrase(wanted) || now - this.phase.since >= PROGRESS_HOLD_MS)) {
      this.phase = { text: wanted, since: now };
    }
    return this.phase.text;
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

  /**
   * A line the live draft shows while the turn waits on a person, or nothing
   * once it no longer does. The draft is the only place a streaming chat can
   * say that the turn is blocked on approval.
   */
  setWaiting(text: string | undefined): ProjectorChange {
    if (this.waiting === text) return "none";
    this.waiting = text;
    return "tool";
  }

  private waitingBlocks(): RichBlock[] {
    return this.waiting ? [{ type: "paragraph", text: { type: "italic", text: this.waiting } }] : [];
  }

  rich(options: { final: boolean; output: OutputMode }): InputRichMessageWithoutUpload {
    const now = this.clock();
    const all = this.projected();
    const items: ProjectedItem[] = answerOnly(options.output) ? this.answer(all, !options.final) : all;
    if (!items.length) {
      if (options.final) return { blocks: [{ type: "paragraph", text: "Done." }] };
      // Only ever append to the placeholder: clients type draft changes in from
      // the first differing character.
      const waited = now - this.startedAt;
      const suffix = waited >= THINKING_ELAPSED_AFTER_MS ? ` ${elapsedSeconds(this.startedAt, now)}s` : "";
      const line = options.output === "progress" ? this.progressLine(now) : THINKING;
      return { blocks: [
        { type: "thinking", text: [THINKING_CUSTOM_EMOJI, ` ${line}${suffix}`] },
        ...this.waitingBlocks(),
      ] };
    }

    const blocks = items.flatMap((item, index) => {
      if (item.type === "assistant") return item.blocks;
      const live = !options.final && index === items.length - 1;
      return [this.toolGroupBlock(item.tools, !options.final, live ? now : undefined)];
    });
    return { blocks: options.final ? blocks : [...blocks, ...this.waitingBlocks()] };
  }

  // Consecutive calls that would print the same row fold into one row with a
  // count, so a command polled ten times is one line, not ten.
  private rows(tools: ToolState[]): Array<{ tool: ToolState; count: number }> {
    const rows: Array<{ tool: ToolState; count: number; key: string }> = [];
    for (const tool of tools) {
      const { title, argument } = describeTool(tool);
      const key = JSON.stringify([title, argumentPreview(argument)]);
      const previous = rows.at(-1);
      if (previous?.key === key) previous.count++;
      else rows.push({ tool, count: 1, key });
    }
    return rows;
  }

  // A draft group stays open under a "Working..." label; the final message
  // labels it with what was done and collapses it. A live group (the newest
  // thing in a draft) ends with an elapsed counter. It is the last row on
  // purpose: every heartbeat changes only those digits, so the client animates
  // nothing above them.
  private toolGroupBlock(tools: ToolState[], working: boolean, liveAt?: number): RichBlock {
    const blocks = this.rows(tools).map(({ tool, count }) => this.toolRow(tool, count));
    if (liveAt !== undefined) {
      const startedAt = Math.min(...tools.map((tool) => tool.startedAt));
      blocks.push({ type: "paragraph", text: `⏱ ${elapsedSeconds(startedAt, liveAt)}s` });
    }
    return {
      type: "details",
      summary: working ? "Working..." : completedToolSummary(tools, this.changedAt),
      blocks,
      ...(working ? { is_open: true as const } : {}),
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

  private toolRow(tool: ToolState, count = 1): RichBlock {
    const { title: name, argument } = describeTool(tool);
    const title = count > 1 ? `${name} ×${count}` : name;
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

  plainFinal(output: OutputMode): string {
    const all = this.projected();
    const items: ProjectedItem[] = answerOnly(output) ? this.answer(all, false) : all;
    const parts = items.map((item) => {
      if (item.type === "assistant") return item.markdown.trim();
      const rows = this.rows(item.tools).map(({ tool, count }) => {
        const { title: name, argument } = describeTool(tool);
        const title = count > 1 ? `${name} ×${count}` : name;
        const preview = argumentPreview(argument);
        return preview ? `${title} ${preview}` : title;
      });
      return [completedToolSummary(item.tools, this.changedAt), ...rows].join("\n");
    });
    return parts.filter(Boolean).join("\n\n") || "Done.";
  }
}
