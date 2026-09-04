import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state";
import type { InboundMessage } from "../src/types";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function store(): StateStore {
  const root = mkdtempSync(join(tmpdir(), "tgfx-state-"));
  temporary.push(root);
  const state = new StateStore(join(root, "state.sqlite"));
  state.ensurePollState("100");
  return state;
}

function inbound(): InboundMessage {
  return {
    updateId: 7,
    event: "message.created",
    route: { key: "100:42:0", botId: "100", chatId: "42", topicId: "0", chatKind: "private" },
    sender: { kind: "user", id: "42", ref: "usr_ref", displayName: "Ada", isBot: false },
    messageId: "9",
    messageRef: "msg_ref",
    contextRef: "ctx_ref",
    timestamp: new Date("2026-08-23T10:00:00Z"),
    text: "hello",
    textKind: "text",
    attachments: [{
      ref: "att_ref", kind: "document", fileId: "secret-file-id", fileUniqueId: "unique", name: "a.txt",
    }],
    raw: { update_id: 7 } as never,
  };
}

describe("SQLite operational journal", () => {
  test("removes unused route caches from an older journal while preserving its work", () => {
    const state = store();
    const route = inbound().route;
    state.ensureRoute(route);
    state.setRouteSession(route.key, "saved-session");
    const savedRoute = state.route(route.key);
    const id = state.ingestUpdate({
      botId: "100", updateId: 7, routeKey: route.key, authorized: true, payload: { prompt: "pending" },
    })!;
    state.db.exec(`
      ALTER TABLE routes ADD COLUMN last_prompt_json TEXT;
      ALTER TABLE routes ADD COLUMN dynamic_commands_json TEXT NOT NULL DEFAULT '[]';
      UPDATE routes SET last_prompt_json='["unused prompt"]', dynamic_commands_json='["unused command"]';
    `);
    state.close();

    const reopened = new StateStore(state.path);
    try {
      expect(reopened.route(route.key)).toEqual(savedRoute);
      expect(reopened.route(route.key)).not.toHaveProperty("last_prompt_json");
      expect(reopened.route(route.key)).not.toHaveProperty("dynamic_commands_json");
      expect(reopened.recoverInbox().received.map((row) => row.id)).toEqual([id]);
      expect(JSON.parse(reopened.inbox(id)!.payload_json)).toEqual({ prompt: "pending" });
      expect(reopened.nextOffset("100")).toBe(8);
    } finally { reopened.close(); }
  });

  test("advances unauthorized updates without retaining payload", () => {
    const state = store();
    state.ingestUpdate({ botId: "100", updateId: 4, authorized: false, payload: { secret: true } });
    expect(state.nextOffset("100")).toBe(5);
    expect(state.db.query("SELECT count(*) AS n FROM telegram_inbox").get()).toEqual({ n: 0 });
    state.close();
  });

  test("stores an accepted update atomically and clears it after completion", () => {
    const state = store();
    const id = state.ingestUpdate({
      botId: "100", updateId: 7, routeKey: "100:42:0", authorized: true, payload: { hello: "world" },
    })!;
    expect(state.nextOffset("100")).toBe(8);
    expect(state.claimInbox(id)).toBeTrue();
    state.markInbox(id, "done");
    expect(state.inbox(id)?.payload_json).toBeNull();
    state.close();
  });

  test("surfaces interrupted work without dispatching it again", () => {
    const state = store();
    const id = state.ingestUpdate({
      botId: "100", updateId: 8, routeKey: "100:42:0", authorized: true, payload: { prompt: "work" },
    })!;
    expect(state.claimInbox(id)).toBeTrue();
    expect(state.recoverInbox()).toEqual({ received: [], interrupted: 1 });
    expect(state.inbox(id)?.status).toBe("interrupted");
    state.close();
  });

  test("reconciles a sent final with its inbox after a crash between commits", () => {
    const state = store();
    state.ensureRoute({ key: "100:42:0", botId: "100", chatId: "42", topicId: "0", chatKind: "private" });
    const id = state.ingestUpdate({
      botId: "100", updateId: 9, routeKey: "100:42:0", authorized: true, payload: { prompt: "done" },
    })!;
    expect(state.claimInbox(id)).toBeTrue();
    state.markInbox(id, "running");
    const outbox = state.createOutbox({
      effectKey: "final:100:9", botId: "100", routeKey: "100:42:0", inboxId: id,
      kind: "rich_final", payload: { chatId: "42", topicId: "0", plain: "done" },
    });
    state.markOutbox(outbox, "sending");
    state.markOutbox(outbox, "sent", "901");
    expect(state.db.query("SELECT payload_json FROM telegram_outbox WHERE id=?").get(outbox))
      .toEqual({ payload_json: "{}" });

    expect(state.recoverInbox().interrupted).toBe(0);
    expect(state.inbox(id)).toMatchObject({ status: "done", payload_json: null });
    state.close();
  });

  test("keeps failed deliveries for inspection without retrying them on startup", () => {
    const state = store();
    const payload = { chatId: "42", topicId: "0", plain: "undelivered answer" };
    const id = state.createOutbox({
      effectKey: "final:100:9", botId: "100", routeKey: "100:42:0", kind: "rich_final", payload,
    });
    state.markOutbox(id, "failed", undefined, "delivery failed");
    expect(state.recoverableOutbox()).toEqual([]);
    expect(state.db.query("SELECT payload_json FROM telegram_outbox WHERE id=?").get(id))
      .toEqual({ payload_json: JSON.stringify(payload) });
    state.close();
  });

  test("scopes context, message, principal, and attachment capabilities to one route", () => {
    const state = store();
    const message = inbound();
    state.ensureRoute(message.route);
    state.registerInbound(message);
    expect(state.activeContext(message.route.key)?.context_ref).toBe("ctx_ref");
    expect(state.messageReference("msg_ref", message.route.key)?.message_id).toBe("9");
    expect(state.messageReference("msg_ref", "100:99:0")).toBeUndefined();
    expect(state.principal("usr_ref", message.route.key)?.telegram_id).toBe("42");
    expect(state.activeContext(message.route.key)?.attachments_json).toContain("secret-file-id");
    const next = inbound();
    next.updateId = 8;
    next.messageId = "10";
    next.messageRef = "msg_next";
    next.contextRef = "ctx_next";
    state.registerInbound(next);
    expect(state.activeContext(message.route.key)?.context_ref).toBe("ctx_next");
    expect(state.activateContext(message.route.key, "ctx_ref")).toBeTrue();
    expect(state.activeContext(message.route.key)?.context_ref).toBe("ctx_ref");
    expect(state.activateContext(message.route.key, "ctx_other_route")).toBeFalse();
    expect(state.activeContext(message.route.key)?.context_ref).toBe("ctx_ref");
    state.resetRoute(message.route.key);
    expect(state.activeContext(message.route.key)).toBeUndefined();
    expect(state.messageReference("msg_ref", message.route.key)).toBeUndefined();
    expect(state.principal("usr_ref", message.route.key)).toBeUndefined();
    state.close();
  });

  test("partitions routes by bot and topic and increments generation on reset", () => {
    const state = store();
    state.ensureRoute({ key: "100:-9:1", botId: "100", chatId: "-9", topicId: "1", chatKind: "supergroup" });
    state.ensureRoute({ key: "101:-9:1", botId: "101", chatId: "-9", topicId: "1", chatKind: "supergroup" });
    state.resetRoute("100:-9:1");
    expect(state.route("100:-9:1")?.generation).toBe(2);
    expect(state.route("101:-9:1")?.generation).toBe(1);
    state.setRouteSession("101:-9:1", "replacement", true);
    expect(state.route("101:-9:1")?.generation).toBe(2);
    expect(state.route("101:-9:1")?.session_id).toBe("replacement");
    state.close();
  });

  test("uses compare-and-set for approvals and idempotency ledger", () => {
    const state = store();
    state.createInteraction({
      id: "approval", botId: "100", routeKey: "100:42:0", kind: "fx_permission",
      payload: { prompt: "Proceed?", options: ["yes", "no"] },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(state.resolveInteraction("approval", "yes")).toBeTrue();
    expect(state.resolveInteraction("approval", "no")).toBeFalse();
    expect(state.beginEffect({ effectKey: "effect", botId: "100", routeKey: "100:42:0", toolName: "send" })).toBe("new");
    state.completeEffect("effect", { sent: true });
    expect(state.beginEffect({ effectKey: "effect", botId: "100", routeKey: "100:42:0", toolName: "send" })).toBe("complete");
    expect(state.effectResult("effect")).toEqual({ sent: true });
    state.close();
  });

  test("remembers an approval's card and lists the bot's open approvals", () => {
    const state = store();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    state.createInteraction({ id: "fx", botId: "100", routeKey: "100:42:0", kind: "fx_permission", payload: { prompt: "?" }, expiresAt });
    state.createInteraction({ id: "admin", botId: "100", routeKey: "100:42:0", kind: "telegram_admin:delete", payload: {}, expiresAt });
    state.createInteraction({ id: "choice", botId: "100", routeKey: "100:42:0", kind: "choice", payload: {}, expiresAt });
    state.createInteraction({ id: "other-bot", botId: "200", routeKey: "200:42:0", kind: "fx_permission", payload: {}, expiresAt });
    state.attachInteractionCard("fx", { chatId: "42", messageId: 7 });
    expect(state.pendingApprovals("100").sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "admin", kind: "telegram_admin:delete" },
      { id: "fx", kind: "fx_permission", card: { chatId: "42", messageId: 7 } },
    ]);
    expect(JSON.parse(state.interaction("fx")!.payload_json)).toEqual({ prompt: "?", card: { chatId: "42", messageId: 7 } });
    state.resolveInteraction("fx", "allow");
    expect(state.pendingApprovals("100").map((pending) => pending.id)).toEqual(["admin"]);
    state.close();
  });

  test("expires only matching pending interactions on a route", () => {
    const state = store();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    state.createInteraction({
      id: "old-picker", botId: "100", routeKey: "100:42:0", kind: "model_picker", payload: {}, expiresAt,
    });
    state.createInteraction({
      id: "other-route", botId: "100", routeKey: "100:43:0", kind: "model_picker", payload: {}, expiresAt,
    });
    state.createInteraction({
      id: "permission", botId: "100", routeKey: "100:42:0", kind: "fx_permission", payload: {}, expiresAt,
    });

    expect(state.expireInteractions("100:42:0", "model_picker")).toBe(1);
    expect(state.interaction("old-picker")?.state).toBe("expired");
    expect(state.interaction("other-route")?.state).toBe("pending");
    expect(state.interaction("permission")?.state).toBe("pending");
    state.close();
  });

  test("adopting a new workspace resets sessions and queued prompts but keeps delivery state", () => {
    const state = store();
    state.ensureRoute({ key: "100:42:0", botId: "100", chatId: "42", topicId: "0", chatKind: "private" });
    state.setRouteSession("100:42:0", "sess-a");
    const id = state.ingestUpdate({
      botId: "100", updateId: 15, routeKey: "100:42:0", authorized: true, payload: { prompt: "work" },
    })!;
    state.createOutbox({
      effectKey: "outgoing", botId: "100", routeKey: "100:42:0", kind: "text",
      payload: { chatId: "42", topicId: "0", text: "answer" },
    });
    state.createInteraction({
      id: "pending-approval", botId: "100", routeKey: "100:42:0", kind: "fx_permission",
      payload: { prompt: "Proceed?", options: ["yes"] },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(state.adoptWorkspace("/project-a")).toEqual({ changed: false, discarded: 0 });
    expect(state.adoptWorkspace("/project-a")).toEqual({ previous: "/project-a", changed: false, discarded: 0 });
    const moved = state.adoptWorkspace("/project-b");
    expect(moved).toEqual({ previous: "/project-a", changed: true, discarded: 1 });

    const route = state.route("100:42:0")!;
    expect(route.session_id).toBeNull();
    expect(route.generation).toBe(2);
    expect(state.inbox(id)).toMatchObject({ status: "discarded", payload_json: null });
    expect(state.interaction("pending-approval")?.state).toBe("expired");
    // Telegram-side facts survive the move: cursor and undelivered replies.
    expect(state.nextOffset("100")).toBe(16);
    expect(state.recoverableOutbox()).toHaveLength(1);
    state.close();
  });

  test("coalesces albums and lets a queued edit supersede the original message", () => {
    const state = store();
    const original = {
      kind: "message",
      message: { route: { chatId: "42" }, messageId: "9", attachments: [{ ref: "a" }] },
    };
    const first = state.ingestUpdate({
      botId: "100", updateId: 20, routeKey: "100:42:0", authorized: true, payload: original,
    })!;
    const second = state.ingestUpdate({
      botId: "100", updateId: 21, routeKey: "100:42:0", authorized: true,
      payload: { ...original, message: { ...original.message, attachments: [{ ref: "b" }] } },
    })!;
    state.coalesceInbox(first, {
      ...original,
      message: { ...original.message, attachments: [{ ref: "a" }, { ref: "b" }] },
    }, [second]);
    expect(JSON.parse(state.inbox(first)!.payload_json).message.attachments).toHaveLength(2);
    expect(state.inbox(second)?.status).toBe("done");

    const edited = state.ingestUpdate({
      botId: "100", updateId: 22, routeKey: "100:42:0", authorized: true,
      payload: { ...original, message: { ...original.message, text: "edited" } },
      supersede: { chatId: "42", messageId: "9" },
    })!;
    expect(state.inbox(first)?.status).toBe("discarded");
    expect(JSON.parse(state.inbox(edited)!.payload_json).message.text).toBe("edited");
    state.close();
  });

  test("keeps Telegram poll IDs host-side and exposes only scoped interaction refs", () => {
    const state = store();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    state.createInteraction({
      id: "opaque-poll", botId: "100", routeKey: "100:42:0", kind: "poll",
      payload: {
        pollId: "telegram-internal-poll-id", messageId: "91", messageRef: "msg_poll",
        question: "Pick one", options: ["A", "B"], anonymous: false,
      },
      expiresAt,
    });
    expect(state.pollInteraction("telegram-internal-poll-id")?.interaction_id).toBe("opaque-poll");
    expect(state.pollInteraction("missing")).toBeUndefined();

    state.createInteraction({
      id: "join-request", botId: "100", routeKey: "100:42:0", kind: "join_request",
      payload: { memberRef: "member_ref", displayName: "Ada", bio: "hello" },
      expiresAt,
    });
    expect(state.pendingJoinRequests("100:42:0")).toEqual([{
      request_ref: "join_join-request", member_ref: "member_ref", display_name: "Ada", bio: "hello",
    }]);
    expect(state.pendingJoinRequests("100:99:0")).toEqual([]);
    state.close();
  });

  test("atomically migrates every route-scoped reference to a supergroup chat ID", () => {
    const state = store();
    const message = inbound();
    message.route = {
      key: "100:-9:0", botId: "100", chatId: "-9", topicId: "0", chatKind: "group",
    };
    state.ensureRoute(message.route);
    state.setRouteSession(message.route.key, "session-before-migration");
    state.registerInbound(message);
    const inbox = state.ingestUpdate({
      botId: "100", updateId: 99, routeKey: message.route.key,
      authorized: true, payload: { kind: "migration" },
    })!;
    const migrated = state.migrateChat("100", "-9", "-1009");
    expect(migrated).toEqual([{ oldKey: "100:-9:0", newKey: "100:-1009:0" }]);
    expect(state.route("100:-9:0")).toBeUndefined();
    expect(state.route("100:-1009:0")).toMatchObject({
      chat_id: "-1009", chat_kind: "supergroup", session_id: "session-before-migration",
    });
    expect(state.inbox(inbox)?.route_key).toBe("100:-1009:0");
    expect(state.messageReference("msg_ref", "100:-1009:0")?.chat_id).toBe("-1009");
    expect(state.activeContext("100:-1009:0")?.chat_id).toBe("-1009");
    state.close();
  });
});
