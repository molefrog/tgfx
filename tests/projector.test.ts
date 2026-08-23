import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import { FxTelegramProjector } from "../src/fx/projector";
import type { FxAcpEvent, FxMirrorMode } from "../src/fx/types";

const started: FxAcpEvent = {
  type: "session_started",
  sessionId: "session-1",
  agentName: "FX",
  agentVersion: "0.0.4",
  model: "zai/glm-5.2",
  mode: "ask",
  availableModelCount: 229,
};

function update(value: object): FxAcpEvent {
  return {
    type: "session_update",
    update: value as acp.SessionUpdate,
  };
}

function projector(mode: FxMirrorMode): FxTelegramProjector {
  const result = new FxTelegramProjector(mode);
  result.apply(started);
  return result;
}

describe("FX Telegram projector", () => {
  test("timeline retains one mutable line per tool call", () => {
    const view = projector("timeline");
    view.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "First paragraph." },
    }));
    view.apply(update({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Reading",
      kind: "read",
      status: "pending",
      content: [],
    }));

    const pending = view.apply(update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "Reading package.json",
      status: "in_progress",
    }))!;
    expect(pending.text).toContain("λ … Reading package.json · read");
    expect(pending.text.match(/λ/gu)).toHaveLength(1);

    const complete = view.apply(update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      content: [{
        type: "content",
        content: { type: "text", text: "package contents" },
      }],
    }))!;
    expect(complete.text).toContain("λ ✓ Reading package.json · read");
    expect(complete.text).not.toContain("package contents");
  });

  test("collapse removes a completed tool when prose resumes", () => {
    const view = projector("collapse");
    view.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Paragraph one." },
    }));
    view.apply(update({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Searching",
      kind: "search",
      status: "in_progress",
      content: [],
    }));
    expect(view.apply(update({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "Searching sendMessageDraft",
      status: "completed",
    }))!.text).toContain("λ ✓ Searching sendMessageDraft · search");

    const final = view.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Final **marked** paragraph." },
    }))!;
    expect(final.text).toContain("Paragraph one.");
    expect(final.text).toContain("Final marked paragraph.");
    expect(final.text).not.toContain("λ");
    expect(final.entities).toContainEqual({
      type: "bold",
      offset: final.text.indexOf("marked"),
      length: 6,
    });
  });

  test("raw includes diagnostics, inputs, and bounded tool results", () => {
    const view = projector("raw");
    view.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "warning: startup context" },
    }));
    const frame = view.apply(update({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "terminal.exec bun --version",
      kind: "execute",
      status: "completed",
      rawInput: { action: "exec", command: "bun --version" },
      content: [{
        type: "content",
        content: { type: "text", text: "1.3.14" },
      }],
    }))!;

    expect(frame.text).toContain("⚙ warning: startup context");
    expect(frame.text).toContain('input: {"action":"exec","command":"bun --version"}');
    expect(frame.text).toContain("result: 1.3.14");
  });

  test("timeline exposes structured arguments when ACP supplies rawInput", () => {
    const view = projector("timeline");
    const frame = view.apply(update({
      sessionUpdate: "tool_call",
      toolCallId: "tool-terminal",
      title: "Using terminal",
      kind: "execute",
      status: "pending",
      rawInput: { action: "exec", command: "bun --version" },
      content: [],
    }))!;

    expect(frame.text).toContain("λ ○ Using terminal · execute");
    expect(frame.text).toContain('input: {"action":"exec","command":"bun --version"}');
  });
});
