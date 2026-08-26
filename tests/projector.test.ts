import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import type { InputRichMessageWithoutUpload } from "grammy/types";
import { AcpProjector } from "../src/fx/projector";

type RichBlock = NonNullable<InputRichMessageWithoutUpload["blocks"]>[number];
type DetailsBlock = Extract<RichBlock, { type: "details" }>;

const update = (value: object) => value as acp.SessionUpdate;

function draft(projector: AcpProjector, collapseTools = true): RichBlock[] {
  return projector.rich({ final: false, collapseTools }).blocks ?? [];
}

function final(projector: AcpProjector, collapseTools = true): RichBlock[] {
  return projector.rich({ final: true, collapseTools }).blocks ?? [];
}

function details(block: RichBlock | undefined): DetailsBlock {
  if (block?.type !== "details") throw new Error(`Expected details block, received ${block?.type ?? "nothing"}`);
  return block;
}

function rendered(block: unknown): string {
  return JSON.stringify(block);
}

describe("ordered ACP projector", () => {
  test("reparses split ACP Markdown into a heading and rich inline text", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "agent_message_chunk",
      messageId: "markdown-message",
      content: { type: "text", text: "# Section heading\n\nParagraph with **bold" },
    }));
    projector.apply(update({
      sessionUpdate: "agent_message_chunk",
      messageId: "markdown-message",
      content: { type: "text", text: "** and *italic*." },
    }));

    expect(final(projector)).toEqual([
      { type: "heading", size: 1, text: "Section heading" },
      {
        type: "paragraph",
        text: [
          "Paragraph with ",
          { type: "bold", text: "bold" },
          " and ",
          { type: "italic", text: "italic" },
          ".",
        ],
      },
    ]);
  });

  test("interleaves rich assistant blocks and consecutive tool groups", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Let me **research** the repo." },
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "read", title: "Reading", status: "pending",
      rawInput: { path: "src/app.ts" }, content: [],
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "search", title: "Searching", status: "pending",
      rawInput: { query: "renderer" }, content: [],
    }));
    projector.apply(update({ sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed" }));
    projector.apply(update({ sessionUpdate: "tool_call_update", toolCallId: "search", status: "completed" }));
    projector.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Here is what I found:\n\n- one\n- two" },
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "tests", title: "Running tests", status: "completed",
      rawInput: { suite: "projector" }, content: [],
    }));

    const blocks = draft(projector);
    expect(blocks.map((block) => block.type)).toEqual([
      "paragraph", "details", "paragraph", "list", "details",
    ]);
    expect(rendered(blocks[0])).toContain('"type":"bold"');
    expect(rendered(blocks[0])).toContain("research");

    const firstGroup = details(blocks[1]);
    expect(firstGroup.summary).toBe("Working...");
    expect(firstGroup.is_open).toBeTrue();
    expect(rendered(firstGroup).indexOf("Reading")).toBeLessThan(rendered(firstGroup).indexOf("Searching"));

    const trailingGroup = details(blocks[4]);
    expect(trailingGroup.summary).toBe("Working...");
    expect(trailingGroup.is_open).toBeTrue();
    expect(rendered(trailingGroup)).toContain("Running tests");
    expect(blocks.some((block) => block.type === "thinking")).toBeFalse();
  });

  test("keeps first-sight tool order when tools complete in reverse", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "first", title: "First", status: "in_progress", content: [],
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "second", title: "Second", status: "in_progress", content: [],
    }));
    projector.apply(update({ sessionUpdate: "tool_call_update", toolCallId: "second", status: "completed" }));

    let group = details(draft(projector)[0]);
    expect(rendered(group)).not.toContain("First");
    expect(rendered(group)).toContain("Second");

    projector.apply(update({ sessionUpdate: "tool_call_update", toolCallId: "first", status: "completed" }));
    group = details(draft(projector)[0]);
    expect(rendered(group).indexOf("First")).toBeLessThan(rendered(group).indexOf("Second"));
  });

  test("shows only completed and failed tools", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "pending", title: "Pending", status: "pending", content: [],
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "running", title: "Running", status: "in_progress", content: [],
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "complete", title: "Complete", status: "completed", content: [],
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "failed", title: "Failed", status: "failed", content: [],
    }));

    const group = details(draft(projector)[0]);
    expect(group.summary).toBe("Working...");
    expect(rendered(group)).not.toContain("Pending");
    expect(rendered(group)).not.toContain("Running");
    expect(rendered(group)).toContain("✓ Complete");
    expect(rendered(group)).toContain("✗ Failed");
  });

  test("opens every draft group as Working and closes every final group", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "one", title: "One", status: "completed", content: [],
    }));
    expect(details(draft(projector)[0]).is_open).toBeTrue();

    projector.apply(update({
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Content after the first group." },
    }));
    let blocks = draft(projector);
    expect(details(blocks[0]).summary).toBe("Working...");
    expect(details(blocks[0]).is_open).toBeTrue();

    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "two", title: "Two", status: "completed", content: [],
    }));
    blocks = draft(projector);
    expect(details(blocks[0]).is_open).toBeTrue();
    expect(details(blocks[2]).is_open).toBeTrue();
    expect(details(blocks[2]).summary).toBe("Working...");

    const finalBlocks = final(projector);
    expect(details(finalBlocks[0]).is_open).toBeUndefined();
    expect(details(finalBlocks[2]).is_open).toBeUndefined();
    expect(details(finalBlocks[0]).summary).toBe("Worked for 1s");
    expect(details(finalBlocks[2]).summary).toBe("Worked for 1s");
    expect(finalBlocks.some((block) => block.type === "thinking")).toBeFalse();
  });

  test("formats final tool summaries from completed activity", () => {
    const cases: Array<{
      count: number;
      kind: string;
      title: string;
      expected: string;
    }> = [
      { count: 5, kind: "execute", title: "Running command", expected: "Ran 5 commands" },
      { count: 2, kind: "read", title: "Reading file", expected: "Read 2 files" },
      { count: 1, kind: "search", title: "Searching code", expected: "Searched code" },
    ];

    for (const activity of cases) {
      const projector = new AcpProjector();
      for (let index = 0; index < activity.count; index += 1) {
        projector.apply(update({
          sessionUpdate: "tool_call",
          toolCallId: `${activity.kind}-${index}`,
          title: activity.title,
          kind: activity.kind,
          status: "completed",
          content: [],
        }));
      }
      expect(details(final(projector)[0]).summary).toBe(activity.expected);
    }
  });

  test("uses stable composite summaries, structured create detection, and generic fallback", () => {
    const projector = new AcpProjector();
    const calls = [
      { id: "move", title: "Moving file", kind: "move", content: [] },
      { id: "search", title: "Searching code", kind: "search", content: [] },
      { id: "read", title: "Reading file", kind: "read", content: [] },
      { id: "create", title: "Changing file", kind: "edit", content: [
        { type: "diff", path: "/workspace/new.ts", oldText: null, newText: "export {};" },
      ] },
      { id: "delete", title: "Deleting file", kind: "delete", content: [] },
      { id: "command-1", title: "Running tests", kind: "execute", content: [] },
      { id: "command-2", title: "Starting formatter", kind: "execute", content: [] },
    ];
    for (const call of calls) {
      projector.apply(update({
        sessionUpdate: "tool_call",
        toolCallId: call.id,
        title: call.title,
        kind: call.kind,
        status: "completed",
        content: call.content,
      }));
    }
    expect(details(final(projector)[0]).summary).toBe(
      "Ran 2 commands, created 1 file, read 1 file, searched code + 2 more",
    );

    const unknown = new AcpProjector();
    unknown.apply(update({
      sessionUpdate: "tool_call", toolCallId: "unknown", title: "Custom activity",
      kind: "other", status: "completed", content: [],
    }));
    expect(details(final(unknown)[0]).summary).toBe("Worked for 1s");
    expect(unknown.plainFinal(true).split("\n")[0]).toBe("Worked for 1s");
  });

  test("uses only the initial thinking block before real output", () => {
    const projector = new AcpProjector();
    expect(draft(projector)).toEqual([{ type: "thinking", text: "λ Thinking…" }]);

    projector.apply(update({
      sessionUpdate: "agent_thought_chunk", messageId: "thought-1",
      content: { type: "text", text: "First " },
    }));
    projector.apply(update({
      sessionUpdate: "agent_thought_chunk", messageId: "thought-1",
      content: { type: "text", text: "thought" },
    }));
    projector.apply(update({
      sessionUpdate: "agent_thought_chunk", messageId: "thought-2",
      content: { type: "text", text: "ignored" },
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "pending", title: "Pending tool", status: "in_progress", content: [],
    }));
    expect(draft(projector)).toEqual([{ type: "thinking", text: "λ First thought" }]);

    projector.apply(update({ sessionUpdate: "tool_call_update", toolCallId: "pending", status: "completed" }));
    const blocks = draft(projector);
    expect(blocks.map((block) => block.type)).toEqual(["details"]);
    expect(rendered(blocks)).not.toContain("First thought");
    expect(rendered(blocks)).not.toContain("ignored");
  });

  test("renders arguments that arrive with completion and exact arguments recovered from content", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "late-input", title: "Searching", status: "pending", content: [],
    }));
    expect(draft(projector).map((block) => block.type)).toEqual(["thinking"]);
    projector.apply(update({
      sessionUpdate: "tool_call_update", toolCallId: "late-input", status: "completed",
      rawInput: { query: "needle" },
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "content-argument", title: "Reading", status: "pending", content: [],
    }));
    projector.apply(update({
      sessionUpdate: "tool_call_update", toolCallId: "content-argument", status: "completed",
      content: [{
        type: "content",
        content: { type: "text", text: "<path>src/projector.ts</path>\n<content>file body</content>" },
      }],
    }));

    const group = details(draft(projector)[0]);
    expect(group.summary).toBe("Working...");
    expect(rendered(group)).toContain('\\"query\\":\\"needle\\"');
    expect(rendered(group)).toContain("src/projector.ts");
  });

  test("renders exact terminal commands but never guesses arguments from arbitrary output", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "terminal", title: "Using terminal",
      status: "in_progress", content: [],
    }));
    projector.apply(update({
      sessionUpdate: "tool_call_update", toolCallId: "terminal", status: "completed",
      rawOutput: { command: "bun test --filter projector", exit_code: 0 },
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "opaque", title: "Custom tool",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "result mentions secret-guess" } }],
    }));

    const group = details(draft(projector)[0]);
    expect(rendered(group)).toContain("bun test --filter projector");
    expect(rendered(group)).not.toContain("secret-guess");
  });

  test("keeps tool argument previews on one line and within 120 characters", () => {
    const projector = new AcpProjector();
    const command = `printf 'first line\nsecond line ${"x".repeat(160)}'`;
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "terminal", title: "Running",
      status: "completed", rawOutput: { command, exit_code: 0 }, content: [],
    }));

    const collapsed = details(draft(projector, true)[0]);
    const row = collapsed.blocks[0];
    if (row?.type !== "paragraph" || !Array.isArray(row.text)) {
      throw new Error("Expected a rich tool preview row");
    }
    const preview = row.text.find((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return false;
      return (part as { type?: unknown }).type === "code";
    }) as { type: "code"; text: string } | undefined;
    if (!preview) {
      throw new Error("Expected a code-formatted tool argument preview");
    }
    expect(preview.text).not.toContain("\n");
    expect(preview.text).toContain("first line second line");
    expect([...preview.text].length).toBe(120);
    expect(preview.text.endsWith("…")).toBeTrue();

    const expanded = details(draft(projector, false)[0]);
    const fullOutput = expanded.blocks.find((block) => block.type === "pre");
    if (!fullOutput || fullOutput.type !== "pre" || typeof fullOutput.text !== "string") {
      throw new Error("Expected complete expanded tool output");
    }
    expect(JSON.parse(fullOutput.text).command).toBe(command);
  });

  test("keeps expanded tool output directly inside its ordered outer group", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "expanded", title: "Inspecting",
      status: "completed", rawInput: { path: "src/app.ts" }, rawOutput: { lines: 10 }, content: [],
    }));
    const group = details(draft(projector, false)[0]);
    expect(group.is_open).toBeTrue();
    expect(group.blocks.map((block) => block.type)).toEqual(["paragraph", "pre", "pre"]);
  });

  test("does not split a tool group on whitespace-only assistant chunks", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "one", title: "One", status: "completed", content: [],
    }));
    projector.apply(update({
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\n   \n" },
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "two", title: "Two", status: "failed", content: [],
    }));

    const blocks = draft(projector);
    expect(blocks.map((block) => block.type)).toEqual(["details"]);
    expect(details(blocks[0]).summary).toBe("Working...");
    expect(rendered(blocks[0]).indexOf("One")).toBeLessThan(rendered(blocks[0]).indexOf("Two"));
  });

  test("drops FX startup diagnostics without splitting surrounding output", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Before diagnostics. " },
    }));
    projector.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "[context] skill catalog omitted 10 entries" },
    }));
    projector.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "skill discovery warning: invalid metadata" },
    }));
    projector.apply(update({
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "After diagnostics." },
    }));

    expect(projector.snapshot().prose).toBe("Before diagnostics. After diagnostics.");
    const blocks = final(projector);
    expect(rendered(blocks)).toContain("Before diagnostics. After diagnostics.");
    expect(rendered(blocks)).not.toContain("skill catalog");
    expect(rendered(blocks)).not.toContain("skill discovery warning");
  });

  test("drops diagnostics preceded by whitespace and markers split across chunks", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "agent_message_chunk", messageId: "answer",
      content: { type: "text", text: "Visible answer.\n\n[con" },
    }));
    projector.apply(update({
      sessionUpdate: "agent_message_chunk", messageId: "answer",
      content: { type: "text", text: "text] omitted startup details" },
    }));
    projector.apply(update({
      sessionUpdate: "agent_message_chunk", messageId: "diagnostic",
      content: { type: "text", text: "  skill discovery warning: invalid metadata" },
    }));
    expect(projector.snapshot().prose).toBe("Visible answer.\n");
    expect(rendered(final(projector))).toContain("Visible answer.");
    expect(rendered(final(projector))).not.toContain("omitted startup details");
  });

  test("retains the dynamic slash command catalog", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "status", description: "Show status" },
        { name: "model", description: "Switch model", input: { hint: "model" } },
      ],
    }));
    expect(projector.snapshot().commands).toEqual([
      { name: "status", description: "Show status" },
      { name: "model", description: "Switch model", input: { hint: "model" } },
    ]);
  });

  test("redacts split secrets across streamed prose and terminal tool details", () => {
    const projector = new AcpProjector();
    const token = `123456789:${"A".repeat(30)}`;
    projector.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Never echo ${token.slice(0, 20)}` },
    }));
    projector.apply(update({
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: token.slice(20) },
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "secret", title: `Using ${token}`,
      status: "completed", rawInput: { token },
      content: [{ type: "content", content: { type: "text", text: `<path>${token}</path>` } }],
    }));

    const collapsed = rendered(draft(projector, true));
    const expanded = rendered(final(projector, false));
    const plain = projector.plainFinal(true);
    for (const output of [collapsed, expanded, plain]) {
      expect(output).not.toContain(token);
      expect(output).toContain("[redacted Telegram token]");
    }
  });

  test("preserves assistant/tool order in the plain fallback and omits unfinished tools", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Before." },
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "one", title: "Tool one", status: "completed",
      rawInput: { path: "one.ts" }, content: [],
    }));
    projector.apply(update({
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "After." },
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "two", title: "Tool two", status: "failed", content: [],
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "unfinished", title: "Unfinished", status: "in_progress", content: [],
    }));

    const plain = projector.plainFinal(true);
    expect(plain.indexOf("Before.")).toBeLessThan(plain.indexOf("Tool one"));
    expect(plain.indexOf("Tool one")).toBeLessThan(plain.indexOf("After."));
    expect(plain.indexOf("After.")).toBeLessThan(plain.indexOf("Tool two"));
    expect(plain).not.toContain("Unfinished");
    expect(projector.plainFinal(false)).toBe("Before.\n\nAfter.");
  });
});
