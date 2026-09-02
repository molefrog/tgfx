import { describe, expect, test } from "bun:test";
import { activitySummary, describeTool, FX_TOOLS, TOOL_ACTIVITY_ORDER } from "../src/fx/tools";
import { TELEGRAM_MCP_TOOL_ROW_TITLES } from "../src/mcp/tool-labels";

describe("fx tool descriptions", () => {
  test("gives every registered fx tool a human title", () => {
    for (const name of Object.keys(FX_TOOLS)) {
      const { title } = describeTool({ name, input: {} });
      expect(title).toMatch(/^[A-Z][a-z]+ /u);
      expect(title).not.toContain("_");
    }
  });

  test("counts every fx tool except MCP selection in summaries", () => {
    for (const name of Object.keys(FX_TOOLS)) {
      const input = name === "shell" ? { action: "run", command: "ls" } : {};
      const { activity } = describeTool({ name, input });
      if (name === "mcp_select_tool") expect(activity).toBeUndefined();
      else expect(activity && TOOL_ACTIVITY_ORDER.includes(activity)).toBeTrue();
    }
  });

  test("picks the one argument that identifies each call", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["read_file", { path: "src/app.ts" }, "src/app.ts"],
      ["glob_files", { pattern: "**/*.md" }, "**/*.md"],
      ["grep_files", { pattern: "hello" }, "hello"],
      ["write_file", { path: "notes.txt", content: "ok" }, "notes.txt"],
      ["edit_file", { path: "notes.txt", old_string: "ok", new_string: "done" }, "notes.txt"],
      ["shell", { action: "run", command: "echo hi", cwd: "/w" }, "echo hi"],
      ["web_fetch", { url: "https://example.com" }, "https://example.com"],
      ["web_search", {}, ""],
      ["capability_search", { query: "telegram", server: "testsrv" }, "telegram"],
      ["skill", { name: "context-save", location: "/skills/x" }, "context-save"],
      ["install_skill", { source: "owner/repo@skill" }, "owner/repo@skill"],
      ["mcp_select_tool", { name: "mcp_testsrv_ping" }, "mcp_testsrv_ping"],
      ["subagent", { request: { action: "run", task: "Summarize the repo" } }, "Summarize the repo"],
      ["read_tool_result", { request: { handle: "result-1.txt", query: "checkpoint" } }, "checkpoint"],
      ["read_tool_result", { request: { handle: "result-1.txt", start_byte: 1 } }, ""],
      ["mcp_features", { action: "resource_read", server: "testsrv", uri: "test://guidelines" }, "test://guidelines"],
      ["vision", { paths: ["a.png"] }, '["a.png"]'],
    ];
    for (const [name, input, argument] of cases) {
      expect(describeTool({ name, input }).argument).toBe(argument);
    }
  });

  test("labels shell by its action and accepts the wrapped request form", () => {
    expect(describeTool({ name: "shell", input: { action: "run", command: "ls" } }))
      .toEqual({ title: "Running command", argument: "ls", activity: "commands" });
    expect(describeTool({ name: "shell", input: { action: "stop", session_id: "s1" } }))
      .toEqual({ title: "Managing shell", argument: "" });
    expect(describeTool({ name: "shell", input: { request: { action: "run", command: "ls" } } }).argument).toBe("ls");
  });

  test("recognizes the Telegram guidelines read among MCP resource reads", () => {
    expect(describeTool({
      name: "mcp_features",
      input: { action: "resource_read", server: "telegram", uri: "telegram://guidelines" },
    })).toEqual({ title: "Reading guidelines", argument: "", activity: "used_chat_tools" });
    expect(describeTool({
      name: "mcp_features",
      input: { action: "resource_read", server: "github", uri: "github://readme" },
    })).toEqual({ title: "Using MCP resource or prompt", argument: "github://readme", activity: "used_external_tools" });
  });

  test("names Telegram MCP tools from their table and other MCP tools by server and tool", () => {
    for (const [name, title] of Object.entries(TELEGRAM_MCP_TOOL_ROW_TITLES)) {
      expect(describeTool({ name: `mcp_telegram_${name}`, input: { emoji: "👍" } }))
        .toEqual({ title, argument: "", activity: "used_chat_tools" });
    }
    expect(describeTool({ name: "mcp_github_search_code", title: "mcp_github_search_code", input: { q: "x" } }))
      .toEqual({ title: "Using MCP tool", argument: "github_search_code", activity: "used_external_tools" });
  });

  test("falls back to the wire title and compact input for unknown or unnamed tools", () => {
    expect(describeTool({ title: "Reading README.md" })).toEqual({ title: "Reading README.md", argument: "" });
    expect(describeTool({ name: "future_tool", title: "Doing", input: { x: 1 } }))
      .toEqual({ title: "Doing", argument: '{"x":1}' });
    expect(describeTool({})).toEqual({ title: "Tool", argument: "" });
  });

  test("caps long arguments", () => {
    const { argument } = describeTool({ name: "shell", input: { action: "run", command: "x".repeat(2_000) } });
    expect([...argument].length).toBe(800);
    expect(argument.endsWith("…")).toBeTrue();
  });

  test("phrases every activity and pluralizes counted ones", () => {
    for (const activity of TOOL_ACTIVITY_ORDER) {
      expect(activitySummary(activity, 1)).toMatch(/^[a-z]/u);
      expect(activitySummary(activity, 2)).not.toMatch(/\b1 \w+$/u);
    }
    expect(activitySummary("commands", 1)).toBe("ran 1 command");
    expect(activitySummary("read_files", 2)).toBe("read 2 files");
    expect(activitySummary("installed_skills", 2)).toBe("installed 2 skills");
  });
});
