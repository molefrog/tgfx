import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TELEGRAM_MCP_TOOL_ROW_TITLES } from "../src/mcp/tool-labels";
import { FakeTelegram } from "./fixtures/fake-telegram";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

type ListedTool = {
  name: string;
  inputSchema: { properties?: Record<string, any>; required?: string[] };
  annotations?: Record<string, boolean>;
};

async function listTools(options: { chatId?: string; allowed?: string[]; apiRoot?: string } = {}): Promise<ListedTool[]> {
  const root = mkdtempSync(join(tmpdir(), "tgfx-mcp-"));
  temporary.push(root);
  const chatId = options.chatId ?? "42";
  const child = Bun.spawn([process.execPath, resolve("src/index.ts"), "mcp"], {
    cwd: root,
    env: {
      ...process.env,
      TGFX_MCP_TOKEN: `100000:${"x".repeat(24)}`,
      TGFX_MCP_BOT_ID: "100",
      TGFX_MCP_ROUTE_KEY: `100:${chatId}:0`,
      TGFX_MCP_WORKSPACE: root,
      TGFX_MCP_HOME: join(root, "tgfx-home"),
      TGFX_MCP_DATABASE: join(root, "tgfx-home", "state", "100.db"),
      TGFX_MCP_FILES: join(root, "tgfx-home", "files", "100"),
      TGFX_MCP_APPROVALS_CHAT: "42",
      TGFX_MCP_APPROVALS_TOPIC: "0",
      TGFX_MCP_ALLOWED_CHATS: JSON.stringify(options.allowed ?? []),
      ...(options.apiRoot ? { TGFX_INTERNAL_TELEGRAM_API_ROOT: options.apiRoot } : {}),
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

async function resourceExchange(): Promise<{ listed: any; read: any }> {
  const root = mkdtempSync(join(tmpdir(), "tgfx-mcp-res-"));
  temporary.push(root);
  const child = Bun.spawn([process.execPath, resolve("src/index.ts"), "mcp"], {
    cwd: root,
    env: {
      ...process.env,
      TGFX_MCP_TOKEN: `100000:${"x".repeat(24)}`,
      TGFX_MCP_BOT_ID: "100",
      TGFX_MCP_ROUTE_KEY: "100:42:0",
      TGFX_MCP_WORKSPACE: root,
      TGFX_MCP_HOME: join(root, "tgfx-home"),
      TGFX_MCP_DATABASE: join(root, "tgfx-home", "state", "100.db"),
      TGFX_MCP_FILES: join(root, "tgfx-home", "files", "100"),
      TGFX_MCP_APPROVALS_CHAT: "42",
      TGFX_MCP_APPROVALS_TOPIC: "0",
      TGFX_MCP_ALLOWED_CHATS: JSON.stringify([]),
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
    { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "telegram://guidelines" } },
  ];
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  const reader = child.stdout.getReader();
  const responses = new Map<number, any>();
  let buffered = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) throw new Error("MCP server closed before resources/read");
    buffered += new TextDecoder().decode(next.value);
    for (const line of buffered.split("\n").filter(Boolean)) {
      const response = JSON.parse(line);
      if (typeof response.id === "number") responses.set(response.id, response);
    }
    if (responses.has(2) && responses.has(3)) {
      child.kill();
      await child.exited;
      return { listed: responses.get(2).result, read: responses.get(3).result };
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
        TGFX_MCP_HOME: join(root, "tgfx-home"),
        TGFX_MCP_DATABASE: join(root, "tgfx-home", "state", "100.db"),
        TGFX_MCP_FILES: join(root, "tgfx-home", "files", "100"),
        TGFX_MCP_APPROVALS_CHAT: "42",
        TGFX_MCP_ALLOWED_CHATS: "{}",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(stderr).toContain("Invalid internal tgfx MCP environment: TGFX_MCP_ALLOWED_CHATS");
  });

  test("exposes the scoped core tools by default", async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "set_reaction", "download_attachment", "send_file", "send_photo", "send_voice", "send_video_note", "get_sticker_pack",
      "send_sticker_by_id", "send_sticker_file",
      "request_choice", "create_poll",
    ]);
    const schemas = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema]));
    expect(schemas.set_reaction.required).toEqual(["emoji"]);
    expect(schemas.download_attachment.required).toEqual(["attachment_ref"]);
    expect(schemas.send_file.required).toEqual(["path"]);
    for (const name of ["send_photo", "send_voice", "send_video_note"]) {
      expect(schemas[name].required).toEqual(["path"]);
    }
    expect(schemas.send_video_note.properties).not.toHaveProperty("caption");
    expect(schemas.get_sticker_pack.required).toEqual(["name"]);
    expect(schemas.get_sticker_pack.properties?.download_images.default).toBeFalse();
    expect(schemas.send_sticker_by_id.required).toEqual(["file_id"]);
    expect(schemas.send_sticker_file.required).toEqual(["path"]);
    expect(schemas.request_choice.required).toEqual(["question", "options"]);
    expect(schemas.request_choice.properties?.options).toMatchObject({ minItems: 2, maxItems: 8 });
    expect(schemas.create_poll.required).toEqual(["question", "options"]);
    expect(schemas.create_poll.properties?.anonymous.default).toBeFalse();
    expect(schemas.create_poll.properties?.multiple.default).toBeFalse();
  });

  test("serves the guidelines resource without an active turn", async () => {
    const { listed, read } = await resourceExchange();
    expect(listed.resources.map((resource: { uri: string }) => resource.uri)).toContain("telegram://guidelines");
    expect(read.contents[0].uri).toBe("telegram://guidelines");
    expect(read.contents[0].text).toContain("sticker");
    expect(read.contents[0].text).toContain("send_sticker_by_id");
  });

  test("derives admin tools from the bot's live Telegram rights", async () => {
    const telegram = new FakeTelegram();
    telegram.chatMembers.set("-9", {
      status: "administrator",
      user: { id: 100, is_bot: true, first_name: "Bot" },
      can_pin_messages: true,
      can_manage_topics: true,
      can_delete_messages: true,
      can_restrict_members: true,
      can_invite_users: true,
      is_anonymous: false,
    });
    try {
      const tools = await listTools({ chatId: "-9", allowed: ["-9"], apiRoot: telegram.url });
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(Object.keys(TELEGRAM_MCP_TOOL_ROW_TITLES));
      expect(names).toContain("set_pinned_message");
      expect(names).toContain("manage_topic");
      expect(names).toContain("delete_messages");
      expect(names).toContain("moderate_member");
      expect(names).toContain("review_join_request");
      expect(tools).toHaveLength(18);
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
      expect(byName.delete_messages!.annotations?.destructiveHint).toBeTrue();
      expect(byName.moderate_member!.inputSchema.properties?.action.enum).toEqual([
        "ban", "unban", "restrict", "restore",
      ]);
      expect(byName.manage_topic!.inputSchema.properties?.action.enum).toEqual([
        "create", "rename", "close", "reopen",
      ]);
    } finally {
      await telegram.stop();
    }
  });

  test("publishes only the tools matching partial Telegram rights", async () => {
    const telegram = new FakeTelegram();
    telegram.chatMembers.set("-9", {
      status: "administrator",
      user: { id: 100, is_bot: true, first_name: "Bot" },
      can_pin_messages: true,
      can_manage_topics: false,
      can_delete_messages: false,
      can_restrict_members: false,
      can_invite_users: false,
      is_anonymous: false,
    });
    try {
      const tools = await listTools({ chatId: "-9", allowed: ["-9"], apiRoot: telegram.url });
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("set_pinned_message");
      expect(names).toContain("pin_message");
      expect(names).not.toContain("manage_topic");
      expect(names).not.toContain("delete_messages");
      expect(names).not.toContain("moderate_member");
      expect(names).not.toContain("review_join_request");
    } finally {
      await telegram.stop();
    }
  });

  test("keeps admin tools off for an allowlisted group where the bot is a plain member", async () => {
    const telegram = new FakeTelegram();
    try {
      const tools = await listTools({ chatId: "-9", allowed: ["-9"], apiRoot: telegram.url });
      expect(tools.map((tool) => tool.name)).toEqual([
        "set_reaction", "download_attachment", "send_file", "send_photo", "send_voice", "send_video_note", "get_sticker_pack",
        "send_sticker_by_id", "send_sticker_file",
        "request_choice", "create_poll",
      ]);
    } finally {
      await telegram.stop();
    }
  });
});
