import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { StateStore } from "../src/state";
import type { InboundMessage } from "../src/types";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type Json = Record<string, any>;

class McpClient {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly responses = new Map<number, Json>();
  private buffer = "";
  private id = 0;

  constructor(readonly child: Subprocess<"pipe", "pipe", "pipe">) {
    this.reader = child.stdout.getReader();
  }

  notify(method: string, params: Json = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async request(method: string, params: Json): Promise<Json> {
    const id = ++this.id;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    while (!this.responses.has(id)) await this.read();
    const response = this.responses.get(id)!;
    this.responses.delete(id);
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result;
  }

  private async read(): Promise<void> {
    const next = await this.reader.read();
    if (next.done) throw new Error("MCP server closed unexpectedly");
    this.buffer += new TextDecoder().decode(next.value);
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (typeof message.id === "number") this.responses.set(message.id, message);
    }
  }
}

describe("Telegram MCP actions", () => {
  test("executes the scoped core tools and deduplicates a completed effect", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-mcp-actions-"));
    temporary.push(workspace);
    const database = join(workspace, ".tgfx", "state.sqlite");
    const files = join(workspace, ".tgfx", "files");
    const state = new StateStore(database);
    state.ensurePollState("100");
    const inbound: InboundMessage = {
      updateId: 1,
      event: "message.created",
      route: { key: "100:42:0", botId: "100", chatId: "42", topicId: "0", chatKind: "private" },
      sender: { kind: "user", id: "42", ref: "usr_current", displayName: "Ada", isBot: false },
      messageId: "7",
      messageRef: "msg_current",
      contextRef: "ctx_current",
      timestamp: new Date(),
      text: "test tools",
      textKind: "text",
      attachments: [{
        ref: "att_current", kind: "document", fileId: "file-secret", fileUniqueId: "unique",
        name: "source.txt", mimeType: "text/plain", size: 5,
      }],
      raw: { update_id: 1 } as never,
    };
    state.ensureRoute(inbound.route);
    state.registerInbound(inbound);
    state.close();
    await writeFile(join(workspace, "result.txt"), "workspace result");

    let nextMessageId = 100;
    const requests: Array<{ method: string; body: string }> = [];
    const token = "100:offline-test-token";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith(`/file/bot${token}/`)) return new Response("hello");
        const method = url.pathname.split("/").at(-1)!;
        const body = await request.text();
        requests.push({ method, body });
        const message = {
          message_id: nextMessageId++, date: Math.floor(Date.now() / 1000),
          chat: { id: 42, type: "private", first_name: "Ada" },
        };
        const result = method === "getFile"
          ? { file_id: "file-secret", file_unique_id: "unique", file_path: "attachments/source.txt" }
          : method === "sendPoll"
            ? { ...message, poll: { id: "poll-telegram-id", question: "Pick", options: [] } }
            : method === "setMessageReaction" ? true : message;
        return Response.json({ ok: true, result });
      },
    });

    const child = Bun.spawn([process.execPath, resolve("src/index.ts"), "mcp"], {
      cwd: workspace,
      env: {
        ...process.env,
        TGFX_MCP_TOKEN: token,
        TGFX_MCP_BOT_ID: "100",
        TGFX_MCP_ROUTE_KEY: "100:42:0",
        TGFX_MCP_WORKSPACE: workspace,
        TGFX_MCP_DATABASE: database,
        TGFX_MCP_FILES: files,
        TGFX_MCP_APPROVALS_CHAT: "42",
        TGFX_MCP_APPROVALS_TOPIC: "0",
        TGFX_MCP_ALLOWED_CHATS: "[]",
        TGFX_MCP_PROTECTED_USERS: '["100","42"]',
        TGFX_INTERNAL_TELEGRAM_API_ROOT: `http://127.0.0.1:${server.port}`,
        TGFX_INTERNAL_TELEGRAM_FILE_ROOT: `http://127.0.0.1:${server.port}/file/bot${token}`,
      },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const client = new McpClient(child);
    try {
      await client.request("initialize", {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
      });
      client.notify("notifications/initialized");
      const call = (name: string, args: Json) => client.request("tools/call", { name, arguments: args });

      const reaction = await call("set_reaction", { emoji: "👍" });
      const duplicateReaction = await call("set_reaction", { emoji: "👍" });
      expect(reaction.structuredContent).toMatchObject({ reacted: true });
      expect(duplicateReaction.structuredContent).toEqual(reaction.structuredContent);
      expect((await call("request_choice", {
        question: "Choose", options: ["A", "B"],
      })).structuredContent.interaction_ref).toMatch(/^interaction_/);
      expect((await call("create_poll", {
        question: "Pick", options: ["A", "B"], anonymous: false, multiple: false,
      })).structuredContent.poll_ref).toMatch(/^interaction_/);
      const sentFile = await call("send_file", { path: "result.txt" });
      if (!sentFile.structuredContent) throw new Error(JSON.stringify(sentFile));
      expect(sentFile.structuredContent.sent).toBeTrue();
      const download = await call("download_attachment", { attachment_ref: "att_current" });
      expect(download.structuredContent).toMatchObject({ downloaded: true, bytes: 5, mime_type: "text/plain" });
      expect(await readFile(download.structuredContent.path, "utf8")).toBe("hello");

      expect(requests.map((request) => request.method)).toEqual(expect.arrayContaining([
        "sendMessage", "setMessageReaction", "sendPoll", "sendDocument", "getFile",
      ]));
      expect(requests.filter((request) => request.method === "setMessageReaction")).toHaveLength(1);
    } finally {
      child.kill();
      await child.exited;
      await server.stop(true);
    }
  });

  test("executes every enabled admin tool only after its required approval", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tgfx-mcp-admin-"));
    temporary.push(workspace);
    const database = join(workspace, ".tgfx", "state.sqlite");
    const files = join(workspace, ".tgfx", "files");
    const routeKey = "100:-9:0";
    const state = new StateStore(database);
    state.ensurePollState("100");
    const inbound: InboundMessage = {
      updateId: 1, event: "message.created",
      route: { key: routeKey, botId: "100", chatId: "-9", topicId: "0", chatKind: "supergroup" },
      sender: { kind: "user", id: "42", ref: "usr_operator", displayName: "Operator", isBot: false },
      messageId: "7", messageRef: "msg_current", contextRef: "ctx_admin", timestamp: new Date(),
      text: "administer", textKind: "text", attachments: [], raw: { update_id: 1 } as never,
    };
    state.ensureRoute(inbound.route);
    state.registerInbound(inbound);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    state.registerPrincipal({
      ref: "member_target", botId: "100", routeKey, kind: "user",
      telegramId: "99", displayName: "Target", expiresAt,
    });
    state.createInteraction({
      id: "join_request", botId: "100", routeKey, kind: "join_request",
      payload: { memberRef: "member_target", displayName: "Target" }, expiresAt,
    });
    state.close();

    let nextMessageId = 200;
    const requests: Array<{ method: string; body: string }> = [];
    const token = "100:offline-admin-token";
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const method = new URL(request.url).pathname.split("/").at(-1)!;
        const body = await request.text();
        requests.push({ method, body });
        const message = {
          message_id: nextMessageId++, date: Math.floor(Date.now() / 1000),
          chat: { id: -9, type: "supergroup", title: "Team" },
        };
        const result = method === "getChatMember"
          ? { status: "creator", is_anonymous: false, user: { id: 100, is_bot: true, first_name: "Bot" } }
          : method === "createForumTopic"
            ? { message_thread_id: 77, name: "Ops", icon_color: 0x6FB9F0 }
            : method === "sendMessage" || method === "editMessageText" ? message : true;
        return Response.json({ ok: true, result });
      },
    });
    const child = Bun.spawn([process.execPath, resolve("src/index.ts"), "mcp"], {
      cwd: workspace,
      env: {
        ...process.env,
        TGFX_MCP_TOKEN: token,
        TGFX_MCP_BOT_ID: "100",
        TGFX_MCP_ROUTE_KEY: routeKey,
        TGFX_MCP_WORKSPACE: workspace,
        TGFX_MCP_DATABASE: database,
        TGFX_MCP_FILES: files,
        TGFX_MCP_APPROVALS_CHAT: "42",
        TGFX_MCP_APPROVALS_TOPIC: "0",
        TGFX_MCP_ALLOWED_CHATS: '["-9"]',
        TGFX_MCP_PROTECTED_USERS: '["100","42"]',
        TGFX_INTERNAL_TELEGRAM_API_ROOT: `http://127.0.0.1:${server.port}`,
      },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const client = new McpClient(child);
    try {
      await client.request("initialize", {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
      });
      client.notify("notifications/initialized");
      const call = (name: string, args: Json) => client.request("tools/call", { name, arguments: args });
      const approve = async (operation: Promise<Json>): Promise<Json> => {
        const approvalState = new StateStore(database);
        try {
          let id: string | undefined;
          for (let attempt = 0; attempt < 100 && !id; attempt++) {
            id = approvalState.db.query<{ interaction_id: string }, []>(`
              SELECT interaction_id FROM telegram_interactions
              WHERE state='pending' AND kind LIKE 'telegram_admin:%'
              ORDER BY updated_at DESC LIMIT 1
            `).get()?.interaction_id;
            if (!id) await Bun.sleep(10);
          }
          if (!id) throw new Error("admin approval was not created");
          expect(approvalState.resolveInteraction(id, "approve")).toBeTrue();
        } finally { approvalState.close(); }
        const response = await operation;
        if (response.isError) throw new Error(JSON.stringify(response));
        return response;
      };

      expect((await approve(call("set_pinned_message", { text: "Bulletin one" }))).structuredContent.pinned).toBeTrue();
      expect((await approve(call("set_pinned_message", { text: "Bulletin two" }))).structuredContent.pinned).toBeTrue();
      expect((await approve(call("pin_message", { message_ref: "msg_current", silent: true }))).structuredContent.pinned).toBeTrue();
      expect((await approve(call("unpin_message", { message_ref: "msg_current" }))).structuredContent.unpinned).toBeTrue();
      expect((await approve(call("manage_topic", { action: "create", name: "Ops" }))).structuredContent.topic_id).toBe("77");
      expect((await call("manage_topic", { action: "rename", topic_id: "77", name: "Operations" })).structuredContent.updated).toBeTrue();
      expect((await approve(call("delete_messages", { message_refs: ["msg_current"] }))).structuredContent.deleted).toBeTrue();
      expect((await approve(call("moderate_member", { member_ref: "member_target", action: "ban" }))).structuredContent.moderated).toBeTrue();
      expect((await approve(call("review_join_request", {
        request_ref: "join_join_request", decision: "decline",
      }))).structuredContent.reviewed).toBeTrue();

      const methods = requests.map((request) => request.method);
      expect(methods).toEqual(expect.arrayContaining([
        "pinChatMessage", "editMessageText", "unpinChatMessage", "createForumTopic",
        "editForumTopic", "deleteMessages", "banChatMember", "declineChatJoinRequest",
      ]));
      expect(requests.filter((request) =>
        request.method === "sendMessage" && request.body.includes("Bulletin one")
      )).toHaveLength(1);
      expect(requests.some((request) =>
        request.method === "editMessageText" && request.body.includes("Bulletin two")
      )).toBeTrue();
      const verify = new StateStore(database);
      try {
        expect(verify.db.query("SELECT count(*) AS count FROM managed_pins").get()).toEqual({ count: 1 });
        expect(verify.interaction("join_request")?.state).toBe("resolved");
      } finally { verify.close(); }
    } finally {
      child.kill();
      await child.exited;
      await server.stop(true);
    }
  });
});
