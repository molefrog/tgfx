import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MESSAGE_EXCERPT_LIMIT, StateStore } from "../src/state";
import type { InboundMessage, Route } from "../src/types";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

const ROUTE: Route = { key: "100:42:0", botId: "100", chatId: "42", topicId: "0", chatKind: "private" };

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "tgfx-mcp-resources-"));
  temporary.push(root);
  return root;
}

function inbound(input: {
  updateId: number; messageId: string; messageRef: string; text?: string;
  senderRef?: string; displayName?: string;
}): InboundMessage {
  return {
    updateId: input.updateId,
    event: "message.created",
    route: ROUTE,
    sender: {
      kind: "user", id: "42", ref: input.senderRef ?? "member_owner",
      displayName: input.displayName ?? "Mole Frog", isBot: false,
    },
    messageId: input.messageId,
    messageRef: input.messageRef,
    contextRef: `ctx_${input.updateId}`,
    timestamp: new Date(),
    ...(input.text === undefined ? {} : { text: input.text }),
    attachments: [],
    raw: { update_id: input.updateId } as InboundMessage["raw"],
  };
}

async function rpc(root: string, requests: Array<Record<string, unknown>>): Promise<Map<number, any>> {
  const child = Bun.spawn([process.execPath, resolve("src/index.ts"), "mcp"], {
    cwd: root,
    env: {
      ...process.env,
      TGFX_MCP_TOKEN: `100000:${"x".repeat(24)}`,
      TGFX_MCP_BOT_ID: "100",
      TGFX_MCP_ROUTE_KEY: ROUTE.key,
      TGFX_MCP_WORKSPACE: root,
      TGFX_MCP_DATABASE: join(root, ".tgfx", "state.sqlite"),
      TGFX_MCP_FILES: join(root, ".tgfx", "files"),
      TGFX_MCP_APPROVALS_CHAT: "42",
      TGFX_MCP_APPROVALS_TOPIC: "0",
      TGFX_MCP_ALLOWED_CHATS: JSON.stringify([]),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const identified = requests.filter((request) => request.id !== undefined);
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
    } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ...requests.map((request) => ({ jsonrpc: "2.0", ...request })),
  ];
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  const responses = new Map<number, any>();
  const reader = child.stdout.getReader();
  let buffered = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      const stderr = await new Response(child.stderr).text();
      throw new Error(`MCP server closed before all responses arrived: ${stderr}`);
    }
    buffered += new TextDecoder().decode(next.value);
    for (const line of buffered.split("\n").filter(Boolean)) {
      const response = JSON.parse(line);
      if (typeof response.id === "number" && response.id !== 1) responses.set(response.id, response);
    }
    if (identified.every((request) => responses.has(request.id as number))) {
      child.kill();
      await child.exited;
      return responses;
    }
  }
}

function chatRecent(response: any): { version: number; count: number; messages: any[] } {
  const contents = response.result.contents;
  expect(contents).toHaveLength(1);
  expect(contents[0].uri).toBe("telegram://chat/recent");
  expect(contents[0].mimeType).toBe("application/json");
  return JSON.parse(contents[0].text).chat_recent;
}

describe("Telegram MCP chat resources", () => {
  test("lists and serves the recent-messages resource with bounded excerpts", async () => {
    const root = workspace();
    const state = new StateStore(join(root, ".tgfx", "state.sqlite"));
    const longText = "a".repeat(MESSAGE_EXCERPT_LIMIT + 50);
    state.registerInbound(inbound({ updateId: 1, messageId: "1800", messageRef: "msg_user1", text: "Can you review the failing tests?" }));
    state.registerBotMessage({
      ref: "msg_bot1", botId: "100", routeKey: ROUTE.key, chatId: "42", topicId: "0",
      messageId: "1801", excerpt: "Sure — the renderer test needs a fixture update.",
    });
    state.registerInbound(inbound({ updateId: 2, messageId: "1802", messageRef: "msg_user2", text: longText }));
    state.close();

    const responses = await rpc(root, [
      { id: 2, method: "resources/list", params: {} },
      { id: 3, method: "resources/read", params: { uri: "telegram://chat/recent" } },
    ]);
    const listed = responses.get(2)!.result.resources;
    expect(listed.map((resource: any) => resource.uri)).toEqual(["telegram://chat/recent"]);
    expect(listed[0].name).toBe("recent_messages");

    const recent = chatRecent(responses.get(3)!);
    expect(recent.version).toBe(1);
    expect(recent.count).toBe(3);
    expect(recent.messages.map((message: any) => message.ref)).toEqual(["msg_user1", "msg_bot1", "msg_user2"]);
    expect(recent.messages[0]).toMatchObject({
      from: { kind: "member", ref: "member_owner", display_name: "Mole Frog" },
      text: "Can you review the failing tests?",
    });
    expect(recent.messages[1].from).toEqual({ kind: "bot" });
    expect(recent.messages[1].text).toBe("Sure — the renderer test needs a fixture update.");
    expect(recent.messages[2].text).toBe(`${"a".repeat(MESSAGE_EXCERPT_LIMIT)}…`);
    expect(recent.messages[2].text.length).toBe(MESSAGE_EXCERPT_LIMIT + 1);
  });

  test("a text-less re-registration keeps the stored excerpt", () => {
    const state = new StateStore(join(workspace(), ".tgfx", "state.sqlite"));
    state.registerInbound(inbound({ updateId: 1, messageId: "10", messageRef: "msg_a", text: "hello" }));
    // Poll answers and button clicks re-register the clicked message without text.
    state.registerInbound(inbound({ updateId: 2, messageId: "10", messageRef: "msg_b" }));
    const recent = state.recentMessages(ROUTE.key, 25);
    state.close();
    expect(recent).toHaveLength(1);
    expect(recent[0]!.ref).toBe("msg_b");
    expect(recent[0]!.excerpt).toBe("hello");
  });

  test("caps the listing at 25 newest messages, oldest first, and omits missing text", async () => {
    const root = workspace();
    const state = new StateStore(join(root, ".tgfx", "state.sqlite"));
    for (let index = 1; index <= 30; index++) {
      state.registerBotMessage({
        ref: `msg_${index}`, botId: "100", routeKey: ROUTE.key, chatId: "42", topicId: "0",
        messageId: String(index), ...(index === 30 ? {} : { excerpt: `note ${index}` }),
      });
    }
    // A message in another route must never appear in this chat's listing.
    state.registerBotMessage({
      ref: "msg_other_route", botId: "100", routeKey: "100:77:0", chatId: "77", topicId: "0",
      messageId: "1", excerpt: "different chat",
    });
    state.close();

    const responses = await rpc(root, [
      { id: 2, method: "resources/read", params: { uri: "telegram://chat/recent" } },
    ]);
    const recent = chatRecent(responses.get(2)!);
    expect(recent.count).toBe(25);
    expect(recent.messages[0].ref).toBe("msg_6");
    expect(recent.messages.at(-1).ref).toBe("msg_30");
    expect(recent.messages.at(-1).text).toBeUndefined();
    expect(recent.messages.at(-2).text).toBe("note 29");
  });
});
