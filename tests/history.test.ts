import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Update } from "grammy/types";
import { StateStore } from "../src/state";
import { normalizeMessageUpdate } from "../src/telegram/normalize";
import { ChatHistory } from "../src/history";

const clean: Array<() => void> = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
const bot = { id: "100", username: "fake_bot", displayName: "Bot" };
const route = "100:-9:0";
function setup() {
  const root = mkdtempSync(join(tmpdir(), "tgfx-history-"));
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const state = new StateStore(join(root, "state.db"), root);
  clean.push(() => state.close());
  let updateId = 0;
  function record(id: number, text = `message ${id}`, extra: Record<string, unknown> = {}, edited = false, invokesAgent = false) {
    const msg = { message_id: id, date: id, chat: { id: -9, type: "supergroup", title: "Team" },
      from: { id: 42, is_bot: false, first_name: "Ada" }, text, ...extra };
    const update = { update_id: ++updateId, [edited ? "edited_message" : "message"]: msg } as Update;
    const message = normalizeMessageUpdate(bot, update)!;
    message.invokesAgent = invokesAgent;
    state.history.recordInbound(message);
    return message;
  }
  return { state, history: state.history, record, root };
}

test("history survives action expiry and stores full text with identity", () => {
  const { state, record, history } = setup();
  const msg = record(1, "decision ".repeat(100));
  state.registerInbound(msg);
  state.resetRoute(route);
  state.prune();
  const result = history.read(route, msg.historySeq!);
  expect(result.messages[0]).toMatchObject({ text: msg.text, from: { id: "42", display_name: "Ada" } });
});

test("the preview supplies the newest five and a cursor for omitted messages", () => {
  const { record, history } = setup();
  for (let i = 1; i <= 8; i++) record(i);
  const request = record(9, "@fake_bot save decisions");
  const preview = history.preview(request)!;
  expect(preview).toMatchObject({ since_previous_turn: 8, included: 5, omitted: 3 });
  expect(preview.messages.map((m) => m.text)).toEqual(["message 4", "message 5", "message 6", "message 7", "message 8"]);
  const older = history.read(route, request.historySeq!, { cursor: preview.older_cursor });
  expect(older.messages.map((m) => m.text)).toEqual(["message 1", "message 2", "message 3"]);
});

test("the preview protects newer text when an earlier message is huge", () => {
  const { record, history } = setup();
  record(1, "a".repeat(10_000)); record(2, "Friday is agreed");
  const request = record(3, "save");
  const preview = history.preview(request)!;
  expect(preview.messages.at(-1)?.text).toBe("Friday is agreed");
  expect(preview.messages[0]?.truncated).toBeTrue();
  expect(preview.messages.reduce((n, m) => n + [...(m.text ?? "")].length, 0)).toBe(8_000);
});

test("an explicit reply includes an older quoted message within the context budget", () => {
  const { record, history } = setup();
  record(1, "important agreement");
  for (let i = 2; i <= 8; i++) record(i);
  const request = record(9, "save this", { reply_to_message: { message_id: 1, date: 1,
    chat: { id: -9, type: "supergroup", title: "Team" }, text: "important agreement" } });
  expect(history.preview(request)?.quoted_message?.text).toBe("important agreement");
});

test("a turn sees the original revision and excludes messages received later", () => {
  const { record, history } = setup();
  record(1, "Friday"); const request = record(2, "save");
  record(1, "Monday", { edit_date: 10 }, true); record(3, "later");
  expect(history.read(route, request.historySeq!).messages.map((m) => m.text)).toEqual(["Friday", "save"]);
  expect(history.read(route, history.latestSeq(route)).messages.map((m) => m.text)).toEqual(["Monday", "save", "later"]);
});

test("adding a mention by edit includes discussion received after the original message", () => {
  const { record, history } = setup();
  record(1, "original"); record(2, "new agreement");
  const edited = record(1, "@fake_bot save", { edit_date: 3 }, true, true);
  expect(history.preview(edited)?.messages.map((m) => m.text)).toEqual(["new agreement"]);
});

test("starting a later turn does not mark an unprocessed request as executed", () => {
  const { record, history } = setup();
  record(1, "@fake_bot queued", {}, false, true);
  const later = record(2, "other request");
  history.begin(route, later.contextRef, later.historySeq!, 1);
  const edit = record(1, "@fake_bot updated", {}, true, true);
  expect(edit.invokesAgent).toBeTrue();
});

test("replacement sessions can recover the bot's previous answer", () => {
  const { record, history } = setup();
  record(1, "what next?");
  history.recordBot(route, "2", "Launch Friday");
  const request = record(3, "continue");
  expect(history.preview(request, true)?.messages.some((m) => m.text === "Launch Friday")).toBeTrue();
});

test("restoring earlier bot text creates a new revision without changing past snapshots", () => {
  const { history } = setup();
  history.recordBot(route, "2", "Launch Friday");
  history.recordBot(route, "2", "Launch Monday");
  const through = history.latestSeq(route);
  history.recordBot(route, "2", "Launch Friday");
  expect(history.read(route, history.latestSeq(route)).messages[0]?.text).toBe("Launch Friday");
  expect(history.read(route, through).messages[0]?.text).toBe("Launch Monday");
});

test("recording unchanged bot text does not create a revision", () => {
  const { history } = setup();
  history.recordBot(route, "2", "Launch Friday");
  const through = history.latestSeq(route);
  history.recordBot(route, "2", "Launch Friday");
  expect(history.latestSeq(route)).toBe(through);
});

test.each(["clear", "replacement", "expiry"])("managed pin edits keep history current after %s", (reason) => {
  const { state, history } = setup();
  state.registerBotMessage({ ref: "msg_pin", botId: "100", routeKey: route, chatId: "-9",
    topicId: "0", messageId: "2", excerpt: "Launch Friday" });
  state.db.query("INSERT INTO managed_pins VALUES (?,?,?,?)").run("100", route, "msg_pin", new Date().toISOString());
  if (reason === "clear") state.resetRoute(route);
  else if (reason === "replacement") state.setRouteSession(route, "new-session", true);
  else state.db.query("UPDATE telegram_messages SET expires_at=? WHERE ref=?").run("2000-01-01", "msg_pin");
  state.prune();
  const pin = state.managedMessageReference("msg_pin", route)!;
  state.updateMessageExcerpt(pin.ref, route, "Launch Monday");
  expect(history.read(route, history.latestSeq(route)).messages[0]?.text).toBe("Launch Monday");
  expect(state.messageReference(pin.ref, route)).toBeUndefined();
});

test("delivery advances only to the request boundary, keeping intervening discussion", () => {
  const { state, record, history } = setup();
  const first = record(1, "help");
  history.begin(route, first.contextRef, first.historySeq!, 9);
  record(2, "next decision");
  const outbox = state.createOutbox({ effectKey: "reply", botId: "100", routeKey: route, inboxId: 9, kind: "final", payload: {} });
  state.markOutbox(outbox, "sent", "3");
  const next = record(4, "save");
  expect(history.preview(next)?.messages.map((m) => m.text)).toEqual(["next decision"]);
});

test("failed delivery leaves the discussion available to the next turn", () => {
  const { state, record, history } = setup();
  record(1, "decision"); const first = record(2, "save");
  history.begin(route, first.contextRef, first.historySeq!, 9);
  const outbox = state.createOutbox({ effectKey: "reply", botId: "100", routeKey: route, inboxId: 9, kind: "final", payload: {} });
  state.markOutbox(outbox, "failed");
  expect(history.preview(record(3, "try again"))?.messages[0]?.text).toBe("decision");
});

test("clearing context prevents automatic reinjection but preserves explicit history reads", () => {
  const { record, history } = setup();
  record(1); history.reset(route);
  const request = record(2, "fresh start");
  expect(history.preview(request, true)).toBeUndefined();
  expect(history.read(route, request.historySeq!).messages).toHaveLength(2);
});

test("paging goes backward and forward without duplicating messages", () => {
  const { record, history } = setup();
  for (let i = 1; i <= 60; i++) record(i);
  const through = history.latestSeq(route);
  const page = history.read(route, through);
  const previous = history.read(route, through, { cursor: page.older_cursor });
  expect(previous.messages.at(-1)?.text).toBe("message 35");
  const again = history.read(route, through, { cursor: previous.newer_cursor });
  expect(again.messages.map((m) => m.ref)).toEqual(page.messages.map((m) => m.ref));
});

test("search can expand into surrounding discussion", () => {
  const { record, history } = setup();
  record(1, "before"); record(2, "Friday launch"); record(3, "after");
  const through = history.latestSeq(route);
  const match = history.read(route, through, { query: "FRIDAY" }).messages[0]!;
  const surrounding = history.read(route, through, { around: match.ref, limit: 3 });
  expect(surrounding.messages.map((m) => m.text)).toEqual(["before", "Friday launch", "after"]);
});

test("truncated text remains fully readable including Unicode", () => {
  const { record, history } = setup();
  const original = "🐸".repeat(40_000);
  const request = record(1, original);
  const first = history.read(route, request.historySeq!).messages[0]!;
  const rest = history.read(route, request.historySeq!, { cursor: first.remainder_cursor }).messages[0]!;
  expect(first.text! + rest.text!).toBe(original);
  expect(rest.truncated).toBeUndefined();
});

test("cursors and message references cannot cross topics or workspaces", () => {
  const { record, history, state, root } = setup();
  record(1); record(2);
  const through = history.latestSeq(route);
  const page = history.read(route, through, { limit: 1 });
  expect(() => history.read("100:-9:7", through, { cursor: page.older_cursor })).toThrow("cursor");
  const other = new ChatHistory(state.db, `${root}/other`);
  expect(other.read(route, through).messages).toHaveLength(0);
  expect(() => other.read(route, through, { around: page.messages[0]!.ref })).toThrow("Unknown");
});

test("history survives reopening the database with the same workspace", () => {
  const { record, root } = setup();
  record(1, "persistent decision");
  const reopened = new StateStore(join(root, "state.db"), root);
  try { expect(reopened.history.read(route, reopened.history.latestSeq(route)).messages[0]?.text).toBe("persistent decision"); }
  finally { reopened.close(); }
});

test("group migration preserves messages and cursors when Telegram reuses message IDs", () => {
  const { record, history } = setup();
  record(1, "old first"); record(2, "old second");
  const page = history.read(route, history.latestSeq(route), { limit: 1 });
  const newRoute = "100:-99:0";
  history.migrate(route, newRoute);
  record(1, "new first", { chat: { id: -99, type: "supergroup", title: "Team" } });
  const through = history.latestSeq(newRoute);
  expect(history.read(newRoute, through).messages.map((m) => m.text)).toEqual(["old first", "old second", "new first"]);
  expect(history.read(newRoute, through, { cursor: page.older_cursor }).messages[0]?.text).toBe("old first");
});

test("archive deletion removes text and invalidates its cursors", () => {
  const { record, history } = setup();
  record(1); record(2);
  const page = history.read(route, history.latestSeq(route), { limit: 1 });
  history.clear("-9", "100");
  expect(history.stats()).toHaveLength(0);
  expect(() => history.read(route, 100, { cursor: page.older_cursor })).toThrow("cursor");
  expect(history.preview(record(3, "new"), true)).toBeUndefined();
});
