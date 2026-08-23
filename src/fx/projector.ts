import type * as acp from "@agentclientprotocol/sdk";
import { FormattedTextBuilder } from "../formatting";
import type { TelegramStreamFrame } from "../stream";
import type { FxAcpEvent, FxMirrorMode } from "./types";

interface TextSegment {
  type: "text";
  text: string;
  diagnostic: boolean;
}

interface ToolSegment {
  type: "tool";
  id: string;
  title: string;
  kind: string;
  status: string;
  content?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
}

interface SystemSegment {
  type: "system";
  text: string;
}

interface PlanSegment {
  type: "plan";
  entries: acp.PlanEntry[];
}

type Segment = TextSegment | ToolSegment | SystemSegment | PlanSegment;

function isDiagnostic(text: string): boolean {
  return /^(?:\[context\]|skill discovery warning:|warning:)/iu.test(text.trimStart());
}

function toolContent(update: { content?: acp.ToolCallContent[] | null }): string | undefined {
  const text = update.content
    ?.flatMap((item) => {
      if (item.type !== "content" || item.content.type !== "text") return [];
      return [item.content.text];
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function oneLine(text: string, limit = 180): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

function toolGlyph(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "in_progress":
      return "…";
    default:
      return "○";
  }
}

export class FxTelegramProjector {
  private readonly segments: Segment[] = [];
  private readonly tools = new Map<string, ToolSegment>();
  private session?: Extract<FxAcpEvent, { type: "session_started" }>;
  private stopReason?: string;

  constructor(readonly mode: FxMirrorMode) {}

  apply(event: FxAcpEvent): TelegramStreamFrame | undefined {
    switch (event.type) {
      case "session_started":
        this.session = event;
        break;
      case "permission_requested":
        this.applyPermission(event.request);
        break;
      case "turn_completed":
        this.stopReason = event.stopReason;
        break;
      case "session_update":
        this.applyUpdate(event.update);
        break;
    }

    return this.render();
  }

  private addText(text: string, diagnostic = isDiagnostic(text)): void {
    const last = this.segments.at(-1);
    if (last?.type === "text" && last.diagnostic === diagnostic) {
      last.text += text;
      return;
    }
    this.segments.push({ type: "text", text, diagnostic });
  }

  private applyPermission(request: acp.RequestPermissionRequest): void {
    const id = request.toolCall.toolCallId;
    let tool = this.tools.get(id);
    if (!tool) {
      tool = {
        type: "tool",
        id,
        title: request.toolCall.title ?? "Permission requested",
        kind: request.toolCall.kind ?? "other",
        status: request.toolCall.status ?? "pending",
      };
      this.tools.set(id, tool);
      this.segments.push(tool);
    }
    tool.title = request.toolCall.title ?? tool.title;
    tool.kind = request.toolCall.kind ?? tool.kind;
    tool.status = request.toolCall.status ?? tool.status;
    tool.rawInput = request.toolCall.rawInput;
  }

  private applyUpdate(update: acp.SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") this.addText(update.content.text);
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text" && this.mode === "raw") {
          this.segments.push({
            type: "system",
            text: `thought: ${update.content.text}`,
          });
        }
        return;
      case "tool_call": {
        const tool: ToolSegment = {
          type: "tool",
          id: update.toolCallId,
          title: update.title,
          kind: update.kind ?? "other",
          status: update.status ?? "pending",
          content: toolContent(update),
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
        };
        this.tools.set(tool.id, tool);
        this.segments.push(tool);
        return;
      }
      case "tool_call_update": {
        const tool = this.tools.get(update.toolCallId);
        if (!tool) return;
        if (update.title != null) tool.title = update.title;
        if (update.kind != null) tool.kind = update.kind;
        if (update.status != null) tool.status = update.status;
        if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
        if (update.rawOutput !== undefined) tool.rawOutput = update.rawOutput;
        const content = toolContent(update);
        if (content !== undefined) tool.content = content;
        return;
      }
      case "plan": {
        const existing = this.segments.find(
          (segment): segment is PlanSegment => segment.type === "plan",
        );
        if (existing) existing.entries = update.entries;
        else this.segments.push({ type: "plan", entries: update.entries });
        return;
      }
      case "available_commands_update":
        if (this.mode === "raw") {
          this.segments.push({
            type: "system",
            text: `${update.availableCommands.length} FX slash commands advertised`,
          });
        }
        return;
      case "usage_update":
        if (this.mode === "raw") {
          this.segments.push({
            type: "system",
            text: `context ${update.used}/${update.size} tokens`,
          });
        }
        return;
      default:
        if (this.mode === "raw") {
          this.segments.push({
            type: "system",
            text: `ACP update: ${update.sessionUpdate}`,
          });
        }
    }
  }

  private shouldRenderCollapsedTool(tool: ToolSegment): boolean {
    const toolIndex = this.segments.indexOf(tool);
    const newerTool = this.segments.slice(toolIndex + 1).some(
      (segment) => segment.type === "tool",
    );
    const laterText = this.segments.slice(toolIndex + 1).some(
      (segment) => segment.type === "text"
        && !segment.diagnostic
        && segment.text.trim().length > 0,
    );
    return !newerTool && !laterText;
  }

  private render(): TelegramStreamFrame | undefined {
    if (!this.session) return undefined;
    const blocks: Array<(builder: FormattedTextBuilder) => void> = [];

    blocks.push((builder) => {
      builder.appendEntityText(
        `${this.session!.agentName} ${this.session!.agentVersion}`,
        "bold",
      );
      builder.appendPlain(" · ");
      builder.appendEntityText(this.session!.model, "code");
      builder.appendPlain(` · ${this.mode}`);
    });

    for (const segment of this.segments) {
      if (segment.type === "text") {
        if (segment.diagnostic && this.mode !== "raw") continue;
        const text = segment.text.trim();
        if (!text) continue;
        blocks.push((builder) => {
          if (segment.diagnostic) builder.appendPlain(`⚙ ${text}`);
          else builder.appendMarkdown(text);
        });
        continue;
      }

      if (segment.type === "system") {
        if (this.mode !== "raw") continue;
        blocks.push((builder) => builder.appendPlain(`[${segment.text}]`));
        continue;
      }

      if (segment.type === "plan") {
        if (this.mode === "collapse") continue;
        blocks.push((builder) => {
          builder.appendEntityText("Plan", "bold");
          for (const entry of segment.entries) {
            const marker = entry.status === "completed"
              ? "✓"
              : entry.status === "in_progress" ? "→" : "○";
            builder.appendPlain(`\n${marker} ${entry.content}`);
          }
        });
        continue;
      }

      if (this.mode === "collapse" && !this.shouldRenderCollapsedTool(segment)) {
        continue;
      }

      blocks.push((builder) => {
        const line = `λ ${toolGlyph(segment.status)} ${segment.title} · ${segment.kind}`;
        builder.appendEntityText(line, "code");

        if (segment.rawInput !== undefined) {
          builder.appendPlain(`\ninput: ${oneLine(JSON.stringify(segment.rawInput))}`);
        }
        if (this.mode === "raw" && segment.content) {
          builder.appendPlain(`\nresult: ${oneLine(segment.content)}`);
        }
        if (this.mode === "raw" && segment.rawOutput !== undefined) {
          builder.appendPlain(`\nraw output: ${oneLine(JSON.stringify(segment.rawOutput))}`);
        }
      });
    }

    if (this.stopReason && this.stopReason !== "end_turn" && this.mode === "raw") {
      blocks.push((builder) => builder.appendPlain(`[stopped: ${this.stopReason}]`));
    }

    const builder = new FormattedTextBuilder();
    blocks.forEach((block, index) => {
      if (index > 0) builder.appendPlain("\n\n");
      block(builder);
    });

    return builder.build();
  }
}
