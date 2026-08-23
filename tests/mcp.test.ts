import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

type ListedTool = {
  name: string;
  inputSchema: { properties?: Record<string, any>; required?: string[] };
  annotations?: Record<string, boolean>;
};

async function listTools(admin = false): Promise<ListedTool[]> {
  const root = mkdtempSync(join(tmpdir(), "tgfx-mcp-"));
  temporary.push(root);
  const chatId = "42";
  const child = Bun.spawn([process.execPath, resolve("src/index.ts"), "mcp"], {
    cwd: root,
    env: {
      ...process.env,
      TGFX_MCP_TOKEN: `100000:${"x".repeat(24)}`,
      TGFX_MCP_BOT_ID: "100",
      TGFX_MCP_ROUTE_KEY: `100:${chatId}:0`,
      TGFX_MCP_WORKSPACE: root,
      TGFX_MCP_DATABASE: join(root, ".tgfx", "state.sqlite"),
      TGFX_MCP_FILES: join(root, ".tgfx", "files"),
      TGFX_MCP_CONTROL_CHAT: chatId,
      TGFX_MCP_CONTROL_TOPIC: "0",
      TGFX_MCP_ADMIN_CHATS: JSON.stringify(admin ? [chatId] : []),
      TGFX_MCP_ADMIN_CAPABILITIES: JSON.stringify(admin
        ? ["pins", "topics", "delete_messages", "moderation", "join_requests"]
        : []),
      TGFX_MCP_SKIP_RIGHTS_CHECK: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
    } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  const reader = child.stdout.getReader();
  let buffered = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) throw new Error("MCP server closed before tools/list");
    buffered += new TextDecoder().decode(next.value);
    for (const line of buffered.split("\n").filter(Boolean)) {
      const response = JSON.parse(line);
      if (response.id === 2) {
        child.kill();
        await child.exited;
        return response.result.tools;
      }
    }
  }
}

describe("Telegram MCP catalog", () => {
  test("fails closed when internal capability environment is malformed", async () => {
    const root = mkdtempSync(join(tmpdir(), "tgfx-mcp-invalid-"));
    temporary.push(root);
    const child = Bun.spawn([process.execPath, resolve("src/index.ts"), "mcp"], {
      cwd: root,
      env: {
        ...process.env,
        TGFX_MCP_TOKEN: `100000:${"x".repeat(24)}`,
        TGFX_MCP_BOT_ID: "100",
        TGFX_MCP_ROUTE_KEY: "100:42:0",
        TGFX_MCP_WORKSPACE: root,
        TGFX_MCP_DATABASE: join(root, ".tgfx", "state.sqlite"),
        TGFX_MCP_FILES: join(root, ".tgfx", "files"),
        TGFX_MCP_CONTROL_CHAT: "42",
        TGFX_MCP_ADMIN_CHATS: "{}",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(stderr).toContain("Invalid internal tgfx MCP environment: TGFX_MCP_ADMIN_CHATS");
  });

  test("exposes only the six scoped core tools by default", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "reply_current", "set_reaction", "download_attachment",
      "send_file", "request_choice", "create_poll",
    ]);
    const schemas = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
    expect(schemas.reply_current.required).toEqual(["text"]);
    expect(schemas.reply_current.properties?.quote.default).toBeTrue();
    expect(schemas.set_reaction.required).toEqual(["emoji"]);
    expect(schemas.download_attachment.required).toEqual(["attachment_ref"]);
    expect(schemas.send_file.required).toEqual(["path"]);
    expect(schemas.request_choice.required).toEqual(["question", "options"]);
    expect(schemas.request_choice.properties?.options).toMatchObject({ minItems: 2, maxItems: 8 });
    expect(schemas.create_poll.required).toEqual(["question", "options"]);
    expect(schemas.create_poll.properties?.anonymous.default).toBeFalse();
    expect(schemas.create_poll.properties?.multiple.default).toBeFalse();
  });

  test("adds only explicitly enabled route-admin capabilities", async () => {
    const tools = await listTools(true);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("set_pinned_message");
    expect(names).toContain("manage_topic");
    expect(names).toContain("delete_messages");
    expect(names).toContain("moderate_member");
    expect(names).toContain("review_join_request");
    expect(tools).toHaveLength(13);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName.delete_messages.annotations?.destructiveHint).toBeTrue();
    expect(byName.moderate_member.inputSchema.properties?.action.enum).toEqual([
      "ban", "unban", "restrict", "restore",
    ]);
    expect(byName.manage_topic.inputSchema.properties?.action.enum).toEqual([
      "create", "rename", "close", "reopen",
    ]);
  });
});
