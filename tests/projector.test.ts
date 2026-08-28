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

  test("separates paragraphs across a hidden tool without changing a lone paragraph", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Before the hidden tool." },
    }));
    projector.apply(update({
      sessionUpdate: "tool_call",
      toolCallId: "pending-search",
      title: "Searching web",
      status: "pending",
      content: [],
    }));
    projector.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "After the hidden tool." },
    }));

    expect(draft(projector)).toEqual([
      { type: "paragraph", text: ["Before the hidden tool.", "\n\n"] },
      { type: "paragraph", text: "After the hidden tool." },
    ]);

    const lone = new AcpProjector();
    lone.apply(update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Only paragraph." },
    }));
    expect(draft(lone)).toEqual([
      { type: "paragraph", text: "Only paragraph." },
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
    expect(firstGroup.summary).toBe(WORKING_SUMMARY);
    expect(firstGroup.is_open).toBeTrue();
    expect(rendered(firstGroup.summary)).not.toContain("custom_emoji");
    expect(rendered(firstGroup).indexOf("Reading")).toBeLessThan(rendered(firstGroup).indexOf("Searching"));

    const trailingGroup = details(blocks[4]);
    expect(trailingGroup.summary).toEqual(WORKING_SUMMARY);
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
    expect(group.summary).toEqual(WORKING_SUMMARY);
    expect(rendered(group)).not.toContain("Pending");
    expect(rendered(group)).not.toContain("Running");
    expect(rendered(group)).toContain("┣ Complete");
    expect(rendered(group)).toContain("┗ × Failed");
  });

  test("keeps every draft group working and open until finalization", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "one", title: "One", status: "completed", content: [],
    }));
    expect(details(draft(projector)[0]).is_open).toBeTrue();

    projector.apply(update({
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Content after the first group." },
    }));
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

  test("maps every standardized FX tool name before consulting title or kind", () => {
    const cases: Array<{
      name: string;
      expected: string;
      content?: unknown[];
    }> = [
      { name: "list_files", expected: "Searched files" },
      { name: "glob_files", expected: "Searched files" },
      { name: "grep_files", expected: "Searched code" },
      { name: "semantic_search", expected: "Searched code" },
      { name: "read_file", expected: "Read 1 file" },
      {
        name: "write_file",
        expected: "Created 1 file",
        content: [{ type: "diff", path: "/workspace/new.ts", oldText: null, newText: "export {};" }],
      },
      { name: "write_file", expected: "Wrote 1 file" },
      { name: "edit_file", expected: "Edited 1 file" },
      { name: "delete_file", expected: "Deleted 1 file" },
      { name: "rename_file", expected: "Renamed 1 file" },
      { name: "copy_file", expected: "Copied 1 file" },
      { name: "create_folder", expected: "Created 1 folder" },
      { name: "file_info", expected: "Inspected 1 file" },
      { name: "open_file", expected: "Opened 1 file" },
      { name: "web_search", expected: "Searched web" },
      { name: "web_fetch", expected: "Fetched 1 page" },
      { name: "vision", expected: "Inspected media" },
      { name: "memory", expected: "Used memory" },
      { name: "skill", expected: "Used skills" },
      { name: "install_skill", expected: "Used skills" },
      { name: "subagent", expected: "Used subagents" },
      { name: "terminal", expected: "Used terminal" },
      { name: "mcp_features", expected: "Used external tools" },
      { name: "ask_user_question", expected: "Asked user" },
      { name: "read_tool_result", expected: "Inspected tool results" },
    ];

    for (const [index, tool] of cases.entries()) {
      const projector = new AcpProjector();
      projector.apply(update({
        sessionUpdate: "tool_call",
        toolCallId: `canonical-${tool.name}-${index}`,
        name: tool.name,
        // Exact FX names must win even when kind is absent and the title looks like
        // a Telegram MCP call that would otherwise be classified first.
        title: "mcp_telegram_set_reaction",
        status: "completed",
        content: tool.content ?? [],
      }));

      expect(details(final(projector)[0]).summary).toBe(tool.expected);
    }
  });

  test("classifies terminal actions and name-less FX search evidence", () => {
    const cases: Array<{
      title: string;
      expected: string;
      kind?: string;
      name?: string;
      rawInput?: unknown;
      content?: unknown[];
    }> = [
      { name: "terminal", title: "Terminal", rawInput: { kind: "exec" }, expected: "Ran 1 command" },
      { name: "terminal", title: "Terminal", rawInput: { action: "read" }, expected: "Used terminal" },
      { name: "perplexity_search", title: "read_file", expected: "Searched web" },
      { name: "mcp_github_search_code", title: "read_file", expected: "Used external tools" },
      { title: "Matching files", kind: "read", expected: "Searched files" },
      {
        title: "Searching",
        kind: "search",
        content: [{ type: "content", content: { type: "text", text: "[grep] 2 matches" } }],
        expected: "Searched code",
      },
      {
        title: "Searching",
        kind: "search",
        content: [{ type: "content", content: { type: "text", text: '{"id":"search","results":[]}' } }],
        expected: "Searched web",
      },
      {
        title: "Searching",
        kind: "search",
        content: [{ type: "content", content: { type: "text", text: "Web search results for query: fx" } }],
        expected: "Searched web",
      },
      { title: "Searching", kind: "search", expected: "Searched" },
      { title: "Listing memories", kind: "other", expected: "Used memory" },
      { title: "Reading tool result", kind: "other", expected: "Inspected tool results" },
      { title: "Asking", kind: "other", expected: "Asked user" },
      { title: "Using MCP feature", kind: "other", expected: "Used external tools" },
    ];

    for (const [index, tool] of cases.entries()) {
      const projector = new AcpProjector();
      projector.apply(update({
        sessionUpdate: "tool_call",
        toolCallId: `wire-${index}`,
        title: tool.title,
        status: "completed",
        content: tool.content ?? [],
        ...(tool.kind ? { kind: tool.kind } : {}),
        ...(tool.name ? { name: tool.name } : {}),
        ...(tool.rawInput !== undefined ? { rawInput: tool.rawInput } : {}),
      }));
      expect(details(final(projector)[0]).summary).toBe(tool.expected);
    }
  });

  test("keeps actual FX 0.0.6 title/kind fallback summaries", () => {
    const cases: Array<{
      count: number;
      kind: string;
      title: string;
      expected: string;
    }> = [
      { count: 5, kind: "execute", title: "Running command", expected: "Ran 5 commands" },
      { count: 2, kind: "read", title: "Reading file", expected: "Read 2 files" },
      { count: 5, kind: "read", title: "Listing directory", expected: "Searched files" },
      { count: 1, kind: "search", title: "Searching code", expected: "Searched code" },
      { count: 2, kind: "edit", title: "Writing file", expected: "Wrote 2 files" },
      { count: 2, kind: "edit", title: "Creating folder", expected: "Created 2 folders" },
      { count: 2, kind: "read", title: "Inspecting file", expected: "Inspected 2 files" },
      { count: 2, kind: "other", title: "Inspecting media", expected: "Inspected media" },
      { count: 2, kind: "execute", title: "Waiting for terminal", expected: "Used terminal" },
      { count: 2, kind: "other", title: "Remembering fact", expected: "Used memory" },
      { count: 2, kind: "other", title: "Loading skill", expected: "Used skills" },
      { count: 2, kind: "other", title: "Managing subagent", expected: "Used subagents" },
      { count: 2, kind: "other", title: "perplexity_search", expected: "Searched web" },
      { count: 2, kind: "other", title: "mcp_github_search_code", expected: "Used external tools" },
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

  test("omits failed tools from activity summaries", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "command", title: "Running command",
      kind: "execute", status: "completed", content: [],
    }));
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "failed", title: "Loading skill",
      status: "failed", content: [],
    }));

    expect(details(final(projector)[0]).summary).toBe("Ran 1 command");
    expect(projector.plainFinal(true).split("\n")[0]).toBe("Ran 1 command");
  });

  test("aggregates listings once and omits unknown tools from composite overflow", () => {
    const projector = new AcpProjector();
    for (let index = 0; index < 5; index += 1) {
      projector.apply(update({
        sessionUpdate: "tool_call",
        toolCallId: `listing-${index}`,
        title: "Listing directory",
        kind: "read",
        status: "completed",
        content: [],
      }));
    }
    projector.apply(update({
      sessionUpdate: "tool_call",
      toolCallId: "command",
      title: "Running tests",
      kind: "execute",
      status: "completed",
      content: [],
    }));
    projector.apply(update({
      sessionUpdate: "tool_call",
      toolCallId: "unknown",
      title: "Custom activity",
      kind: "other",
      status: "completed",
      content: [],
    }));

    expect(details(final(projector)[0]).summary).toBe("Ran 1 command, searched files");
    expect(projector.plainFinal(true).split("\n")[0]).toBe("Ran 1 command, searched files");
  });

  test("renders every Telegram MCP tool with a human title and one summary category", () => {
    const telegramTools = [
      ["set_reaction", "Reacting to Telegram message"],
      ["download_attachment", "Downloading Telegram attachment"],
      ["send_file", "Sending workspace file"],
      ["get_sticker_pack", "Loading Telegram sticker pack"],
      ["send_sticker_by_id", "Sending Telegram sticker"],
      ["send_sticker_file", "Uploading Telegram sticker"],
      ["request_choice", "Asking Telegram user to choose"],
      ["create_poll", "Creating Telegram poll"],
      ["set_pinned_message", "Setting managed pinned message"],
      ["pin_message", "Pinning referenced message"],
      ["unpin_message", "Unpinning referenced message"],
      ["manage_topic", "Managing forum topic"],
      ["delete_messages", "Deleting Telegram messages"],
      ["moderate_member", "Moderating Telegram member"],
      ["review_join_request", "Reviewing chat join request"],
    ] as const;
    const projector = new AcpProjector();

    for (const [name] of telegramTools) {
      projector.apply(update({
        sessionUpdate: "tool_call",
        toolCallId: `telegram-${name}`,
        title: `mcp_telegram_${name}`,
        kind: "other",
        status: "completed",
        content: [],
      }));
    }

    const group = details(final(projector)[0]);
    expect(group.summary).toBe("Used Telegram");
    expect(group.blocks).toEqual(telegramTools.map(([, title], index) => ({
      type: "paragraph",
      text: `${index === telegramTools.length - 1 ? "┗" : "┣"} ${title}`,
    })));
    expect(projector.plainFinal(true).split("\n")).toEqual([
      "Used Telegram",
      ...telegramTools.map(([, title], index) => (
        `${index === telegramTools.length - 1 ? "┗" : "┣"} ${title}`
      )),
    ]);
    expect(rendered(group.blocks)).not.toContain("mcp_telegram_");

    const named = new AcpProjector();
    for (const [name] of telegramTools) {
      named.apply(update({
        sessionUpdate: "tool_call",
        toolCallId: `named-telegram-${name}`,
        name: `mcp_telegram_${name}`,
        title: "Using Telegram",
        kind: "other",
        status: "completed",
        content: [],
      }));
    }
    expect(details(final(named)[0]).blocks).toEqual(telegramTools.map(([, title], index) => ({
      type: "paragraph",
      text: `${index === telegramTools.length - 1 ? "┗" : "┣"} ${title}`,
    })));
  });

  test("hides MCP discovery plumbing but summarizes MCP feature execution", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "read", name: "read_file",
      title: "Reading file", kind: "read", status: "completed", content: [],
    }));
    for (const [name, title] of [
      ["mcp_search_tools", "Searching MCP tools"],
      ["mcp_select_tool", "Selecting MCP tool"],
      ["mcp_features", "Using MCP feature"],
    ] as const) {
      projector.apply(update({
        sessionUpdate: "tool_call", toolCallId: name, name, title,
        kind: "other", status: "completed", content: [],
      }));
    }

    expect(details(final(projector)[0]).summary).toBe("Read 1 file, used external tools");
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
      sessionUpdate: "tool_call", toolCallId: "pending", title: "Pending tool", status: "in_progress", content: [],
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
    expect(group.summary).toEqual(WORKING_SUMMARY);
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

  test("keeps tool argument previews on one line and within 60 characters", () => {
    const projector = new AcpProjector();
    const command = `printf 'first line\nsecond line ${"x".repeat(160)}'`;
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "terminal", title: "Running",
      status: "completed", rawOutput: { command, exit_code: 0 }, content: [],
    }));

    const group = details(draft(projector)[0]);
    const row = group.blocks[0];
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
    expect([...preview.text].length).toBe(60);
    expect(preview.text.endsWith("…")).toBeTrue();

  });

  test("never renders tool results inside the group", () => {
    const projector = new AcpProjector();
    projector.apply(update({
      sessionUpdate: "tool_call", toolCallId: "expanded", title: "Inspecting",
      status: "completed", rawInput: { path: "src/app.ts" }, rawOutput: { lines: 10 },
      content: [{ type: "content", content: { type: "text", text: "hidden result" } }],
    }));
    const group = details(draft(projector)[0]);
    expect(group.is_open).toBeTrue();
    expect(group.blocks.map((block) => block.type)).toEqual(["paragraph"]);
    expect(rendered(group)).not.toContain("lines");
    expect(rendered(group)).not.toContain("hidden result");
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
    expect(details(blocks[0]).summary).toEqual(WORKING_SUMMARY);
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

  test("redacts split secrets across streamed prose and compact tool rows", () => {
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

    const draftOutput = rendered(draft(projector));
    const finalOutput = rendered(final(projector));
    const plain = projector.plainFinal(true);
    for (const output of [draftOutput, finalOutput, plain]) {
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
