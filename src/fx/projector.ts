import type * as acp from "@agentclientprotocol/sdk";
import type { InputRichMessageWithoutUpload } from "grammy/types";
import { redactSecrets } from "../secrets";

type RichBlock = NonNullable<InputRichMessageWithoutUpload["blocks"]>[number];
export type ToolState = {
  id: string; title: string; name?: string; kind?: string; status: string;
  input?: unknown; output?: unknown; content: unknown[]; startedAt: number; finishedAt?: number;
};
export type TimelineSnapshot = {
  prose: string; thought: string; tools: ToolState[];
  commands: Array<{ name: string; description: string; input?: { hint: string } }>;
  diagnostics: string[]; changedAt: number;
};

function stringify(value: unknown, limit = 4_000): string {
  if (value === undefined) return "";
  let text: string;
  try { text = typeof value === "string" ? value : JSON.stringify(value, null, 2); }
  catch { text = String(value); }
  text = redactSecrets(text);
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export class AcpProjector {
  private prose = "";
  private thought = "";
  private tools = new Map<string, ToolState>();
  private commands: TimelineSnapshot["commands"] = [];
  private diagnostics: string[] = [];
  private changedAt = Date.now();
  readonly startedAt = Date.now();

  apply(update: acp.SessionUpdate): void {
    this.changedAt = Date.now();
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") {
          const text = update.content.text;
          if (text.startsWith("[context] ") || text.startsWith("skill discovery warning:")) {
            this.diagnostics.push(text.trim());
          } else {
            this.prose += text;
          }
        }
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text") this.thought += update.content.text;
        return;
      case "tool_call":
        this.tools.set(update.toolCallId, {
          id: update.toolCallId, title: update.title,
          ...(update.name ? { name: update.name } : {}),
          ...(update.kind ? { kind: update.kind } : {}),
          status: update.status ?? "pending", input: update.rawInput, output: update.rawOutput,
          content: update.content ? [...update.content] : [], startedAt: Date.now(),
          ...(update.status === "completed" || update.status === "failed" ? { finishedAt: Date.now() } : {}),
        });
        return;
      case "tool_call_update": {
        const previous = this.tools.get(update.toolCallId) ?? {
          id: update.toolCallId, title: update.title ?? "Tool", status: "pending", content: [], startedAt: Date.now(),
        };
        const status = update.status ?? previous.status;
        this.tools.set(update.toolCallId, {
          ...previous,
          ...(update.title ? { title: update.title } : {}),
          ...(update.kind ? { kind: update.kind } : {}),
          ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
          ...(update.rawOutput !== undefined ? { output: update.rawOutput } : {}),
          ...(update.content ? { content: [...update.content] } : {}), status,
          ...(status === "completed" || status === "failed" ? { finishedAt: previous.finishedAt ?? Date.now() } : {}),
        });
        return;
      }
      case "available_commands_update":
        this.commands = update.availableCommands.map((command) => ({
          name: command.name, description: command.description,
          ...(command.input ? { input: command.input } : {}),
        }));
        return;
      default: return;
    }
  }

  snapshot(): TimelineSnapshot {
    return {
      prose: redactSecrets(this.prose), thought: redactSecrets(this.thought), tools: [...this.tools.values()],
      commands: [...this.commands], diagnostics: this.diagnostics.map(redactSecrets), changedAt: this.changedAt,
    };
  }

  rich(options: { final: boolean; collapseTools: boolean; includeTools?: boolean }): InputRichMessageWithoutUpload {
    const snapshot = this.snapshot();
    if (options.final) return { markdown: this.finalMarkdown(options.collapseTools, options.includeTools ?? true) };
    const blocks: RichBlock[] = [];
    if (snapshot.prose.trim()) {
      for (const paragraph of snapshot.prose.trim().split(/\n\s*\n/)) blocks.push({ type: "paragraph", text: paragraph });
    }
    const includeTools = options.includeTools ?? true;
    const active = snapshot.tools.filter((tool) => !tool.finishedAt);
    const completed = snapshot.tools.filter((tool) => tool.finishedAt);
    if (includeTools && !options.collapseTools) {
      for (const tool of snapshot.tools) blocks.push(this.toolBlock(tool));
    } else if (includeTools && completed.length && active.length === 0) {
      const elapsed = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
      blocks.push({
        type: "details", summary: `Worked for ${elapsed}s · ${completed.length} tool${completed.length === 1 ? "" : "s"}`,
        blocks: completed.map((tool) => ({ type: "paragraph" as const, text: `${tool.status === "failed" ? "✗" : "✓"} ${redactSecrets(tool.title)}` })),
      });
    }
    const activity = active.at(-1);
    const text = activity ? `λ ${redactSecrets(activity.title)}`
      : snapshot.thought.trim() ? `λ ${snapshot.thought.trim().slice(-600)}` : "λ Thinking…";
    blocks.push({ type: "thinking", text });
    if (blocks.length === 0) blocks.push({ type: "paragraph", text: "Thinking…" });
    return { blocks };
  }

  private finalMarkdown(collapseTools: boolean, includeTools: boolean): string {
    const snapshot = this.snapshot();
    const parts: string[] = [];
    if (snapshot.prose.trim()) parts.push(snapshot.prose.trim());
    if (includeTools && snapshot.tools.length) {
      if (collapseTools) {
        const elapsed = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
        const rows = snapshot.tools.map((tool) =>
          `<p>${tool.status === "failed" ? "✗" : "✓"} ${escapeHtml(redactSecrets(tool.title))}</p>`
        ).join("");
        parts.push(
          `<details><summary>Worked for ${elapsed}s · ${snapshot.tools.length} tool${snapshot.tools.length === 1 ? "" : "s"}</summary>${rows}</details>`,
        );
      } else {
        parts.push(...snapshot.tools.map((tool) => this.toolMarkdown(tool)));
      }
    }
    if (snapshot.diagnostics.length) {
      const rows = snapshot.diagnostics.map((text) => `<p>${escapeHtml(text)}</p>`).join("");
      parts.push(
        `<details><summary>${snapshot.diagnostics.length} 𝒇x diagnostic${snapshot.diagnostics.length === 1 ? "" : "s"}</summary>${rows}</details>`,
      );
    }
    return parts.join("\n\n") || "Done.";
  }

  private toolMarkdown(tool: ToolState): string {
    const input = stringify(tool.input);
    const output = stringify(tool.output);
    const body = [input && `<pre><code class="language-json">${escapeHtml(input)}</code></pre>`,
      output && `<pre><code class="language-json">${escapeHtml(output)}</code></pre>`]
      .filter(Boolean).join("") || `<p>${escapeHtml(tool.status)}</p>`;
    return `<details><summary>${tool.finishedAt ? (tool.status === "failed" ? "✗" : "✓") : "λ"} ${escapeHtml(redactSecrets(tool.title))}</summary>${body}</details>`;
  }

  private toolBlock(tool: ToolState): RichBlock {
    const details: RichBlock[] = [];
    const input = stringify(tool.input);
    const output = stringify(tool.output);
    if (input) details.push({ type: "pre", language: "json", text: input });
    if (output) details.push({ type: "pre", language: "json", text: output });
    if (details.length === 0) details.push({ type: "paragraph", text: tool.status });
    return { type: "details", summary: `${tool.finishedAt ? (tool.status === "failed" ? "✗" : "✓") : "λ"} ${redactSecrets(tool.title)}`, blocks: details };
  }

  plainFinal(includeTools: boolean): string {
    const snapshot = this.snapshot();
    const parts = [snapshot.prose.trim()];
    if (includeTools && snapshot.tools.length) parts.push(snapshot.tools.map((tool) => `${tool.status === "failed" ? "✗" : "✓"} ${redactSecrets(tool.title)}`).join("\n"));
    return parts.filter(Boolean).join("\n\n") || "Done.";
  }
}
