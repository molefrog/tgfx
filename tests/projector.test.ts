import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";
import type { InputRichMessageWithoutUpload } from "grammy/types";
import { AcpProjector } from "../src/fx/projector";

type RichBlock = NonNullable<InputRichMessageWithoutUpload["blocks"]>[number];
type DetailsBlock = Extract<RichBlock, { type: "details" }>;

const update = (value: object) => value as acp.SessionUpdate;
const THINKING_EMOJI = {
  type: "custom_emoji" as const,
  custom_emoji_id: "5573473356579078196",
  alternative_text: "🙂",
};
const WORKING_SUMMARY = "Working...";
/** The newest draft group ends with an elapsed counter; tests run within its first second. */
const ELAPSED_ROW = { type: "paragraph" as const, text: "⏱ 1s" };

function draft(projector: AcpProjector, expandStreamingTools = true): RichBlock[] {
  return projector.rich({ final: false, expandStreamingTools }).blocks ?? [];
}

function final(projector: AcpProjector): RichBlock[] {
  return projector.rich({ final: true, expandStreamingTools: true }).blocks ?? [];
}

function details(block: RichBlock | undefined): DetailsBlock {
  if (block?.type !== "details") throw new Error(`Expected details block, received ${block?.type ?? "nothing"}`);
  return block;
}

function rendered(block: unknown): string {
  return JSON.stringify(block);
}

function say(projector: AcpProjector, text: string, messageId?: string): void {
  projector.apply(update({
    sessionUpdate: "agent_message_chunk",
    ...(messageId ? { messageId } : {}),
    content: { type: "text", text },
  }));
}

// fx announces a call with its name and arguments, then reports the outcome
// (with the tool's output as content) in a separate update.
function call(projector: AcpProjector, id: string, name: string, rawInput: object = {}): void {
  projector.apply(update({
    sessionUpdate: "tool_call", toolCallId: id, name, title: name, kind: "other", status: "pending", rawInput,
  }));
}

function complete(projector: AcpProjector, id: string, status = "completed"): void {
  projector.apply(update({
    sessionUpdate: "tool_call_update", toolCallId: id, status,
    content: [{ type: "content", content: { type: "text", text: "tool output" } }],
  }));
}

function finished(projector: AcpProjector, id: string, name: string, rawInput: object = {}, status = "completed"): void {
  call(projector, id, name, rawInput);
  complete(projector, id, status);
}

describe("ordered ACP projector", () => {
  test("reparses split ACP Markdown into a heading and rich inline text", () => {
    const projector = new AcpProjector();
    say(projector, "# Section heading\n\nParagraph with **bold", "markdown-message");
    say(projector, "** and *italic*.", "markdown-message");

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

  test("separates paragraphs across a hidden tool without changing a lone paragraph", () => {
    const projector = new AcpProjector();
    say(projector, "Before the hidden tool.");
    projector.apply(update({ sessionUpdate: "tool_call", toolCallId: "unnamed", title: "Searching", status: "pending" }));
    say(projector, "After the hidden tool.");

    expect(draft(projector)).toEqual([
      { type: "paragraph", text: ["Before the hidden tool.", "\n\n"] },
      { type: "paragraph", text: "After the hidden tool." },
    ]);

    const lone = new AcpProjector();
    say(lone, "Only paragraph.");
    expect(draft(lone)).toEqual([{ type: "paragraph", text: "Only paragraph." }]);
  });

  test("interleaves rich assistant blocks and consecutive tool groups", () => {
    const projector = new AcpProjector();
    say(projector, "Let me **research** the repo.");
    call(projector, "read", "read_file", { path: "src/app.ts" });
    call(projector, "search", "grep_files", { pattern: "renderer" });
    complete(projector, "read");
    complete(projector, "search");
    say(projector, "Here is what I found:\n\n- one\n- two");
    finished(projector, "tests", "shell", { action: "run", command: "bun test" });

    const blocks = draft(projector);
    expect(blocks.map((block) => block.type)).toEqual([
      "paragraph", "details", "paragraph", "list", "details",
    ]);
    expect(rendered(blocks[0])).toContain('"type":"bold"');
    expect(rendered(blocks[0])).toContain("research");

    const firstGroup = details(blocks[1]);
    expect(firstGroup.summary).toBe(WORKING_SUMMARY);
    expect(firstGroup.is_open).toBeTrue();
    expect(rendered(firstGroup).indexOf("Reading file")).toBeLessThan(rendered(firstGroup).indexOf("Searching code"));

    const trailingGroup = details(blocks[4]);
    expect(trailingGroup.summary).toEqual(WORKING_SUMMARY);
    expect(trailingGroup.is_open).toBeTrue();
    expect(rendered(trailingGroup)).toContain("Running command");
    expect(rendered(trailingGroup)).toContain("bun test");
    expect(blocks.some((block) => block.type === "thinking")).toBeFalse();
  });

  test("keeps first-sight tool order when tools complete in reverse", () => {
    const projector = new AcpProjector();
    call(projector, "first", "read_file", { path: "first.ts" });
    call(projector, "second", "read_file", { path: "second.ts" });
    complete(projector, "second");

    let group = details(draft(projector)[0]);
    expect(rendered(group).indexOf("first.ts")).toBeLessThan(rendered(group).indexOf("second.ts"));

    complete(projector, "first");
    group = details(draft(projector)[0]);
    expect(rendered(group).indexOf("first.ts")).toBeLessThan(rendered(group).indexOf("second.ts"));
  });

  test("waits for unnamed tools to finish before listing them", () => {
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
    expect(group.summary).toEqual(WORKING_SUMMARY);
    expect(rendered(group)).not.toContain("Pending");
    expect(rendered(group)).not.toContain("Running");
    expect(group.blocks).toEqual([
      { type: "paragraph", text: "Complete" },
      { type: "paragraph", text: "Failed" },
      ELAPSED_ROW,
    ]);
  });

  test("keeps every draft group working and open until finalization", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "one", title: "One", status: "completed", content: [],
    }));
    expect(details(draft(projector)[0]).is_open).toBeTrue();

    say(projector, "Content after the first group.");
    let blocks = draft(projector);
    expect(details(blocks[0]).summary).toBe(WORKING_SUMMARY);
    expect(details(blocks[0]).is_open).toBeTrue();

    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "two", title: "Two", status: "completed", content: [],
    }));
    blocks = draft(projector);
    expect(details(blocks[0]).summary).toBe(WORKING_SUMMARY);
    expect(details(blocks[0]).is_open).toBeTrue();
    expect(details(blocks[2]).is_open).toBeTrue();
    expect(details(blocks[2]).summary).toEqual(WORKING_SUMMARY);

    const alwaysCollapsed = draft(projector, false);
    expect(details(alwaysCollapsed[0]).is_open).toBeUndefined();
    expect(details(alwaysCollapsed[0]).summary).toEqual(WORKING_SUMMARY);
    expect(details(alwaysCollapsed[2]).summary).toEqual(WORKING_SUMMARY);
    expect(details(alwaysCollapsed[2]).is_open).toBeUndefined();

    const finalBlocks = final(projector);
    expect(details(finalBlocks[0]).is_open).toBeUndefined();
    expect(details(finalBlocks[2]).is_open).toBeUndefined();
    expect(details(finalBlocks[0]).summary).toBe("Worked for 1s");
    expect(details(finalBlocks[2]).summary).toBe("Worked for 1s");
    expect(finalBlocks.some((block) => block.type === "thinking")).toBeFalse();
  });

  test("labels rows from fx tool names, never from the agent's wire title", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "read", name: "read_file",
      title: "mcp_telegram_set_reaction", status: "completed", rawInput: { path: "src/app.ts" },
    }));
    let group = details(final(projector)[0]);
    expect(group.summary).toBe("Read 1 file");
    expect(group.blocks).toEqual([{ type: "paragraph", text: ["Reading file", " ", { type: "code", text: "src/app.ts" }] }]);

    const omitted = new AcpProjector();
    finished(omitted, "select", "mcp_select_tool", { name: "mcp_github_search_code" });
    group = details(final(omitted)[0]);
    expect(group.summary).toBe("Worked for 1s");
    expect(rendered(group.blocks)).toContain("Selecting MCP tool");
  });

  test("lists named tools with their arguments as soon as fx announces them", () => {
    const projector = new AcpProjector();
    expect(projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "cmd", name: "shell", title: "Running", status: "pending",
      rawInput: { action: "run", command: "bun test" },
    }))).toBe("tool");
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "unnamed", title: "Mystery", status: "pending",
    }));

    const group = details(draft(projector)[0]);
    expect(group.summary).toBe(WORKING_SUMMARY);
    expect(group.blocks).toEqual([
      { type: "paragraph", text: ["Running command", " ", { type: "code", text: "bun test" }] },
      ELAPSED_ROW,
    ]);
    expect(projector.plainFinal(true)).toContain("Running command bun test");

    // Finishing changes nothing visible in the row, so no redraw is requested.
    expect(projector.apply(update({ sessionUpdate: "tool_call_update", toolCallId: "cmd", status: "completed" }))).toBe("none");
  });

  test("renders a provider-backed web search from its fx lifecycle before the answer", () => {
    // Wire shape from fx dev 7e02f32 (vercel-labs/fx#556): the search is
    // announced with an empty rawInput and completed after the answer streams.
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "chatcmpl-tool-1", name: "web_search",
      title: "Searching web", kind: "search", status: "pending", rawInput: {},
    }));
    say(projector, "Bun 1.4 is the latest release.");
    projector.apply(update({
      sessionUpdate: "tool_call_update", toolCallId: "chatcmpl-tool-1", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Web search completed" } }],
    }));

    const blocks = final(projector);
    expect(blocks.map((block) => block.type)).toEqual(["details", "paragraph"]);
    const group = details(blocks[0]);
    expect(group.summary).toBe("Searched web");
    expect(group.blocks).toEqual([{ type: "paragraph", text: "Searching web" }]);
  });

  test("renders the guidelines resource read with the telegram icon", () => {
    const projector = new AcpProjector({ telegram: "5231146084922860619" });
    finished(projector, "guidelines-read", "mcp_features", {
      action: "resource_read", server: "telegram", uri: "telegram://guidelines",
    });

    const group = details(final(projector)[0]);
    expect(group.summary).toBe("Used chat tools");
    expect(group.blocks).toEqual([{
      type: "paragraph",
      text: [
        { type: "custom_emoji", custom_emoji_id: "5231146084922860619", alternative_text: "🧩" },
        " Reading guidelines",
      ],
    }]);
  });

  test("renders the guidelines read without an icon or URI when the icon map is empty", () => {
    const projector = new AcpProjector();
    finished(projector, "guidelines-read-plain", "mcp_features", {
      action: "resource_read", server: "telegram", uri: "telegram://guidelines",
    });

    expect(details(final(projector)[0]).blocks).toEqual([{ type: "paragraph", text: "Reading guidelines" }]);
    expect(projector.plainFinal(true)).toContain("Reading guidelines");
    expect(projector.plainFinal(true)).not.toContain("telegram://");
  });

  test("uses the MCP server icon for resource reads through mcp_features", () => {
    const icons = { github: "gh-emoji", "tool:mcp_features": "features-emoji" };
    const projector = new AcpProjector(icons);
    finished(projector, "readme", "mcp_features", { action: "resource_read", server: "github", uri: "github://readme" });
    finished(projector, "unknown", "mcp_features", { action: "resource_read", server: "acme", uri: "acme://x" });

    const rows = details(final(projector)[0]).blocks;
    expect(rendered(rows[0])).toContain('"custom_emoji_id":"gh-emoji"');
    expect(rendered(rows[1])).toContain('"custom_emoji_id":"features-emoji"');
  });

  test("drops assistant preamble that announces the guidelines bootstrap read", () => {
    const projector = new AcpProjector();
    say(projector, "I'll start by reading the Telegram guidelines, then handle the message.");
    finished(projector, "bootstrap-read", "mcp_features", {
      action: "resource_read", server: "telegram", uri: "telegram://guidelines",
    });
    say(projector, "Hey! What's up?");

    const blocks = final(projector);
    expect(rendered(blocks)).not.toContain("I'll start by reading");
    expect(rendered(blocks)).toContain("Reading guidelines");
    expect(rendered(blocks)).toContain("Hey! What's up?");
    expect(projector.plainFinal(true)).not.toContain("I'll start by reading");
  });

  test("keeps assistant text before a first tool that is not the guidelines read", () => {
    const projector = new AcpProjector();
    say(projector, "Let me check that file.");
    finished(projector, "regular-read", "read_file", { path: "README.md" });

    expect(rendered(final(projector))).toContain("Let me check that file.");
  });

  test("composes group summaries in a stable order and folds overflow", () => {
    const projector = new AcpProjector();
    finished(projector, "cmd-1", "shell", { action: "run", command: "bun test" });
    finished(projector, "cmd-2", "shell", { action: "run", command: "bun run build" });
    finished(projector, "write", "write_file", { path: "notes.txt", content: "ok" });
    finished(projector, "read", "read_file", { path: "README.md" });
    finished(projector, "grep", "grep_files", { pattern: "hello" });
    for (let index = 0; index < 5; index += 1) finished(projector, `glob-${index}`, "glob_files", { pattern: "*.md" });
    finished(projector, "future", "future_tool", { x: 1 });

    const summary = "Ran 2 commands, wrote 1 file, read 1 file, searched files + 1 more";
    expect(details(final(projector)[0]).summary).toBe(summary);
    expect(projector.plainFinal(true).split("\n")[0]).toBe(summary);

    const unknown = new AcpProjector();
    finished(unknown, "future", "future_tool", { x: 1 });
    expect(details(final(unknown)[0]).summary).toBe("Worked for 1s");
    expect(unknown.plainFinal(true).split("\n")[0]).toBe("Worked for 1s");
  });

  test("omits failed tools from activity summaries but still lists them", () => {
    const projector = new AcpProjector();
    finished(projector, "command", "shell", { action: "run", command: "ls" });
    finished(projector, "failed", "skill", { name: "missing" }, "failed");

    const group = details(final(projector)[0]);
    expect(group.summary).toBe("Ran 1 command");
    expect(rendered(group.blocks)).toContain("Loading skill");
    expect(projector.plainFinal(true).split("\n")[0]).toBe("Ran 1 command");
  });

  test("adds server custom emoji to MCP tool rows only when icons are supplied", () => {
    const projector = new AcpProjector({
      github: "github-emoji",
      mcp: "mcp-emoji",
      telegram: "telegram-emoji",
    });
    for (const [id, name] of [
      ["github", "mcp_github_search_code"],
      ["telegram", "mcp_telegram_send_file"],
      ["unknown", "mcp_new_service_call"],
    ] as const) {
      finished(projector, id, name, { query: "tgfx" });
    }

    const rows = details(final(projector)[0]).blocks;
    expect(rendered(rows[0])).toContain('"custom_emoji_id":"github-emoji"');
    expect(rendered(rows[1])).toContain('"custom_emoji_id":"telegram-emoji"');
    expect(rendered(rows[2])).toContain('"custom_emoji_id":"mcp-emoji"');

    const plain = new AcpProjector();
    finished(plain, "github", "mcp_github_search_code", { query: "tgfx" });
    expect(rendered(details(final(plain)[0]).blocks)).not.toContain("custom_emoji");
  });

  test("prefers exact fx tool icons over MCP server matching", () => {
    const projector = new AcpProjector({
      "tool:read_file": "read-file-emoji",
      "tool:web_fetch": "fetch-emoji",
      mcp: "generic-mcp-emoji",
    });
    finished(projector, "read", "read_file", { path: "README.md" });
    finished(projector, "fetch", "web_fetch", { url: "https://example.com" });

    const rows = details(final(projector)[0]).blocks;
    expect(rendered(rows[0])).toContain('"custom_emoji_id":"read-file-emoji"');
    expect(rendered(rows[1])).toContain('"custom_emoji_id":"fetch-emoji"');
    expect(rendered(rows)).not.toContain("generic-mcp-emoji");
  });

  test("uses only the initial thinking block before real output", () => {
    const projector = new AcpProjector();
    expect(draft(projector)).toEqual([{
      type: "thinking",
      text: [THINKING_EMOJI, " Thinking…"],
    }]);

    expect(projector.apply(update({
      sessionUpdate: "agent_thought_chunk", messageId: "thought-1",
      content: { type: "text", text: "First " },
    }))).toBe("none");
    expect(projector.apply(update({
      sessionUpdate: "agent_thought_chunk", messageId: "thought-1",
      content: { type: "text", text: "thought" },
    }))).toBe("none");
    projector.apply(update({
      sessionUpdate: "agent_thought_chunk", messageId: "thought-2",
      content: { type: "text", text: "ignored" },
    }));
    expect(projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "pending", title: "Reading", status: "in_progress",
    }))).toBe("none");
    expect(draft(projector)).toEqual([{
      type: "thinking",
      text: [THINKING_EMOJI, " Thinking…"],
    }]);

    expect(projector.apply(update({
      sessionUpdate: "tool_call_update", toolCallId: "pending", status: "completed",
    }))).toBe("tool");
    const blocks = draft(projector);
    expect(blocks.map((block) => block.type)).toEqual(["details"]);
    expect(rendered(blocks)).not.toContain("First thought");
    expect(rendered(blocks)).not.toContain("ignored");
  });

  test("renders arguments that only arrive with completion", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "late-input", name: "grep_files", title: "Searching", status: "pending",
    }));
    expect(details(draft(projector)[0]).blocks).toEqual([{ type: "paragraph", text: "Searching code" }, ELAPSED_ROW]);
    projector.apply(update({
      sessionUpdate: "tool_call_update", toolCallId: "late-input", status: "completed",
      rawInput: { pattern: "needle" },
    }));

    const group = details(draft(projector)[0]);
    expect(group.summary).toEqual(WORKING_SUMMARY);
    expect(group.blocks).toEqual([
      { type: "paragraph", text: ["Searching code", " ", { type: "code", text: "needle" }] },
      ELAPSED_ROW,
    ]);
  });

  test("keeps tool argument previews on one line and within 60 characters", () => {
    const projector = new AcpProjector();
    const command = `printf 'first line\nsecond line ${"x".repeat(160)}'`;
    finished(projector, "shell", "shell", { action: "run", command });

    const row = details(draft(projector)[0]).blocks[0];
    if (row?.type !== "paragraph" || !Array.isArray(row.text)) {
      throw new Error("Expected a rich tool preview row");
    }
    const preview = row.text.find((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return false;
      return (part as { type?: unknown }).type === "code";
    }) as { type: "code"; text: string } | undefined;
    if (!preview) throw new Error("Expected a code-formatted tool argument preview");
    expect(preview.text).not.toContain("\n");
    expect(preview.text).toContain("first line second line");
    expect([...preview.text].length).toBe(60);
    expect(preview.text.endsWith("…")).toBeTrue();
  });

  test("never renders tool output inside the group", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "expanded", name: "read_file", title: "Reading",
      status: "completed", rawInput: { path: "src/app.ts" }, rawOutput: { lines: 10 },
      content: [{ type: "content", content: { type: "text", text: "hidden result" } }],
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "opaque", title: "Custom tool", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "result mentions secret-guess" } }],
    }));

    const group = details(draft(projector)[0]);
    expect(group.is_open).toBeTrue();
    expect(group.blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(rendered(group)).not.toContain("lines");
    expect(rendered(group)).not.toContain("hidden result");
    expect(rendered(group)).not.toContain("secret-guess");
  });

  test("does not split a tool group on whitespace-only assistant chunks", () => {
    const projector = new AcpProjector();
    finished(projector, "one", "read_file", { path: "one.ts" });
    say(projector, "\n\n   \n");
    finished(projector, "two", "read_file", { path: "two.ts" }, "failed");

    const blocks = draft(projector);
    expect(blocks.map((block) => block.type)).toEqual(["details"]);
    expect(details(blocks[0]).summary).toEqual(WORKING_SUMMARY);
    expect(rendered(blocks[0]).indexOf("one.ts")).toBeLessThan(rendered(blocks[0]).indexOf("two.ts"));
  });

  test("drops fx startup diagnostics without splitting surrounding output", () => {
    const projector = new AcpProjector();
    say(projector, "Before diagnostics. ");
    say(projector, "[context] skill catalog omitted 10 entries");
    say(projector, "skill discovery warning: invalid metadata");
    say(projector, "After diagnostics.");

    expect(projector.snapshot().prose).toBe("Before diagnostics. After diagnostics.");
    const blocks = final(projector);
    expect(rendered(blocks)).toContain("Before diagnostics. After diagnostics.");
    expect(rendered(blocks)).not.toContain("skill catalog");
    expect(rendered(blocks)).not.toContain("skill discovery warning");
  });

  test("drops diagnostics preceded by whitespace and markers split across chunks", () => {
    const projector = new AcpProjector();
    say(projector, "Visible answer.\n\n[con", "answer");
    say(projector, "text] omitted startup details", "answer");
    say(projector, "  skill discovery warning: invalid metadata", "diagnostic");
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

  test("redacts split secrets across streamed prose and compact tool rows", () => {
    const projector = new AcpProjector();
    const token = `123456789:${"A".repeat(30)}`;
    say(projector, `Never echo ${token.slice(0, 20)}`);
    say(projector, token.slice(20));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "secret", title: `Using ${token}`,
      status: "completed", rawInput: { token },
    }));
    finished(projector, "path", "read_file", { path: token });

    const draftOutput = rendered(draft(projector));
    const finalOutput = rendered(final(projector));
    const plain = projector.plainFinal(true);
    for (const output of [draftOutput, finalOutput, plain]) {
      expect(output).not.toContain(token);
      expect(output).toContain("[redacted Telegram token]");
    }
  });

  test("appends an elapsed counter only to the newest draft group", () => {
    let now = 10_000;
    const projector = new AcpProjector({}, () => now);
    call(projector, "one", "read_file", { path: "one.ts" });
    now += 7_000;
    let group = details(draft(projector)[0]);
    expect(group.blocks.at(-1)).toEqual({ type: "paragraph", text: "⏱ 7s" });

    // A new row lands above the counter, so only the block's tail changes.
    call(projector, "two", "grep_files", { pattern: "x" });
    group = details(draft(projector)[0]);
    expect(rendered(group.blocks.at(-2))).toContain("Searching code");
    expect(group.blocks.at(-1)).toEqual({ type: "paragraph", text: "⏱ 7s" });

    // Once prose follows, the group is history and stops counting.
    say(projector, "Found it.");
    expect(rendered(details(draft(projector)[0]))).not.toContain("⏱");
    expect(rendered(final(projector))).not.toContain("⏱");
  });

  test("adds a wait counter to the thinking placeholder after five seconds", () => {
    let now = 0;
    const projector = new AcpProjector({}, () => now);
    now = 4_000;
    expect(draft(projector)).toEqual([{ type: "thinking", text: [THINKING_EMOJI, " Thinking…"] }]);
    now = 6_400;
    expect(draft(projector)).toEqual([{ type: "thinking", text: [THINKING_EMOJI, " Thinking… 6s"] }]);
  });

  test("keeps a finished tool finished when fx streams its late output afterwards", () => {
    const projector = new AcpProjector();
    finished(projector, "run", "shell", { action: "run", command: "sleep 45 && echo ok" });
    expect(projector.apply(update({
      sessionUpdate: "tool_call_update", toolCallId: "run", status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "ok\n" } }],
    }))).toBe("none");
    expect(details(final(projector)[0]).summary).toBe("Ran 1 command");
  });

  test("folds consecutive identical rows into one counted row", () => {
    const projector = new AcpProjector();
    finished(projector, "run", "shell", { action: "run", command: "sleep 9" });
    for (const id of ["p1", "p2", "p3"]) finished(projector, id, "shell", { action: "interact", session_id: "shell-1" });
    finished(projector, "again", "shell", { action: "run", command: "sleep 9" });

    const rows = details(final(projector)[0]).blocks.map((block) => rendered(block));
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain("Waiting for command ×3");
    expect(rows[2]).toContain("Running command");
    expect(rows[2]).not.toContain("×");
    expect(projector.plainFinal(true)).toContain("Waiting for command ×3");
  });

  test("preserves assistant/tool order in the plain fallback and lists unfinished tools", () => {
    const projector = new AcpProjector();
    say(projector, "Before.");
    finished(projector, "one", "read_file", { path: "one.ts" });
    say(projector, "After.");
    finished(projector, "two", "read_file", { path: "two.ts" }, "failed");
    call(projector, "unfinished", "read_file", { path: "unfinished.ts" });

    const plain = projector.plainFinal(true);
    expect(plain.indexOf("Before.")).toBeLessThan(plain.indexOf("one.ts"));
    expect(plain.indexOf("one.ts")).toBeLessThan(plain.indexOf("After."));
    expect(plain.indexOf("After.")).toBeLessThan(plain.indexOf("two.ts"));
    // A tool that never finished is listed but not counted in its group.
    const lastGroup = plain.slice(plain.indexOf("After."));
    expect(lastGroup).toContain("Reading file unfinished.ts");
    expect(lastGroup).not.toContain("Read 1 file");
    expect(projector.plainFinal(false)).toBe("Before.\n\nAfter.");
  });
});
