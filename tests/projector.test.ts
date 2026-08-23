import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { AcpProjector } from "../src/fx/projector";

const update = (value: object) => value as acp.SessionUpdate;

describe("generic ACP projector", () => {
  test("accumulates prose and patches one tool call without hardcoded tool names", () => {
    const projector = new AcpProjector();
    projector.apply(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "First paragraph.\n\n" } }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "1", title: "Searching", name: "custom_search",
      kind: "search", status: "pending", rawInput: { query: "drafts" }, content: [],
    }));
    projector.apply(update({
      sessionUpdate: "tool_call_update", toolCallId: "1", title: "Searching 12 files", status: "completed",
      rawOutput: { matches: 3 },
    }));
    projector.apply(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Final paragraph." } }));
    const snapshot = projector.snapshot();
    expect(snapshot.prose).toBe("First paragraph.\n\nFinal paragraph.");
    expect(snapshot.tools).toHaveLength(1);
    expect(snapshot.tools[0]).toMatchObject({ title: "Searching 12 files", status: "completed", input: { query: "drafts" }, output: { matches: 3 } });
  });

  test("renders mutable thinking during a turn and removes it from the final", () => {
    const projector = new AcpProjector();
    projector.apply(update({ sessionUpdate: "tool_call", toolCallId: "1", title: "Running tests", status: "in_progress", content: [] }));
    const draft = projector.rich({ final: false, collapseTools: true });
    expect(draft.blocks?.some((block) => block.type === "thinking")).toBeTrue();
    projector.apply(update({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed" }));
    const final = projector.rich({ final: true, collapseTools: true });
    expect(final.blocks).toBeUndefined();
    expect(final.markdown).toContain("<details><summary>Worked for");
    expect(final.markdown).not.toContain("tg-thinking");
  });

  test("retains the dynamic slash command catalog", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "status", description: "Show status" }, { name: "model", description: "Switch model", input: { hint: "model" } }],
    }));
    expect(projector.snapshot().commands[1]).toEqual({ name: "model", description: "Switch model", input: { hint: "model" } });
  });

  test("keeps fx startup diagnostics out of assistant prose", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "[context] skill catalog omitted 10 entries" },
    }));
    projector.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Actual answer." },
    }));
    expect(projector.snapshot().prose).toBe("Actual answer.");
    expect(projector.snapshot().diagnostics).toEqual(["[context] skill catalog omitted 10 entries"]);
    const final = projector.rich({ final: true, collapseTools: true });
    expect(final.markdown).toContain("1 𝒇x diagnostic");
  });

  test("passes completed assistant Markdown to Telegram Rich Messages without rewriting it", () => {
    const projector = new AcpProjector();
    const markdown = "# Result\n\nA **bold** sentence with `code`.\n\n| A | B |\n|---|---|\n| 1 | 2 |";
    projector.apply(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: markdown } }));
    expect(projector.rich({ final: true, collapseTools: true })).toEqual({ markdown });
    const draft = projector.rich({ final: false, collapseTools: true });
    expect(draft.markdown).toBeUndefined();
    expect(draft.blocks?.filter((block) => block.type === "paragraph").map((block) => block.text)).toEqual([
      "# Result", "A **bold** sentence with `code`.", "| A | B |\n|---|---|\n| 1 | 2 |",
    ]);
  });

  test("redacts Telegram-token-shaped secrets across streamed prose and tool details", () => {
    const projector = new AcpProjector();
    const token = `123456789:${"A".repeat(30)}`;
    projector.apply(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Never echo ${token.slice(0, 20)}` } }));
    projector.apply(update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: token.slice(20) } }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "secret", title: `Using ${token}`,
      status: "completed", rawInput: { token }, content: [],
    }));
    const final = JSON.stringify(projector.rich({ final: true, collapseTools: false }));
    const draft = JSON.stringify(projector.rich({ final: false, collapseTools: false }));
    expect(final).not.toContain(token);
    expect(draft).not.toContain(token);
    expect(final).toContain("[redacted Telegram token]");
    expect(projector.plainFinal(true)).not.toContain(token);
  });
});
