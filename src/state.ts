import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { InboundMessage, Route } from "./types";

type InboxStatus = "received" | "dispatching" | "running" | "done" | "failed" | "interrupted" | "discarded";
type OutboxStatus = "pending" | "sending" | "sent" | "failed" | "abandoned";

/** The Telegram message that carries an interaction's buttons. */
export type InteractionCard = { chatId: string; messageId: number };

export type InboxRow = {
  id: number;
  bot_id: string;
  update_id: number;
  route_key: string;
  status: InboxStatus;
  payload_json: string;
  attempts: number;
  error: string | null;
};

export type RouteRow = {
  route_key: string;
  bot_id: string;
  chat_id: string;
  topic_id: string;
  chat_kind: Route["chatKind"];
  session_id: string | null;
  generation: number;
  dynamic_commands_json: string;
  last_prompt_json: string | null;
  updated_at: string;
};

export type ContextCapability = {
  context_ref: string;
  bot_id: string;
  route_key: string;
  chat_id: string;
  topic_id: string;
  message_ref: string;
  message_id: string;
  sender_ref: string;
  attachments_json: string;
  expires_at: string;
};

export type MessageReference = {
  ref: string;
  bot_id: string;
  route_key: string;
  chat_id: string;
  topic_id: string;
  message_id: string;
  sender_ref: string | null;
  owned_by_bot: number;
};

export type RecentMessage = {
  ref: string;
  sender_ref: string | null;
  sender_display_name: string | null;
  owned_by_bot: number;
  created_at: string;
  excerpt: string | null;
};

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS runtime_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_poll_state (
  bot_id TEXT PRIMARY KEY,
  next_offset INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routes (
  route_key TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  chat_kind TEXT NOT NULL,
  session_id TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  dynamic_commands_json TEXT NOT NULL DEFAULT '[]',
  last_prompt_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_principals (
  ref TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  principal_kind TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  display_name TEXT,
  expires_at TEXT NOT NULL,
  UNIQUE(bot_id, route_key, principal_kind, telegram_id)
);

CREATE TABLE IF NOT EXISTS telegram_messages (
  ref TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_ref TEXT,
  owned_by_bot INTEGER NOT NULL DEFAULT 0,
  excerpt TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(bot_id, chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS telegram_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  route_key TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(bot_id, update_id)
);

CREATE INDEX IF NOT EXISTS telegram_inbox_route_status
  ON telegram_inbox(route_key, status, id);

CREATE TABLE IF NOT EXISTS telegram_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  effect_key TEXT NOT NULL UNIQUE,
  bot_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  inbox_id INTEGER,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  telegram_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS telegram_outbox_status ON telegram_outbox(status, id);

CREATE TABLE IF NOT EXISTS telegram_interactions (
  interaction_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  result_json TEXT,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_pins (
  bot_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  message_ref TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(bot_id, route_key)
);

CREATE TABLE IF NOT EXISTS effect_ledger (
  effect_key TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  state TEXT NOT NULL,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_capabilities (
  context_ref TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  message_ref TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_ref TEXT NOT NULL,
  attachments_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS context_route_active
  ON context_capabilities(route_key, active, created_at DESC);
`;

function now(): string { return new Date().toISOString(); }

/** Message text is retained only as this bounded excerpt, never in full. */
export const MESSAGE_EXCERPT_LIMIT = 200;

export function messageExcerpt(text: string | undefined | null): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const points = [...trimmed];
  if (points.length <= MESSAGE_EXCERPT_LIMIT) return trimmed;
  return `${points.slice(0, MESSAGE_EXCERPT_LIMIT).join("")}…`;
}

export class StateStore {
  readonly db: Database;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    this.db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.db.exec(SCHEMA);
    const messageColumns = this.db.query<{ name: string }, []>(
      "SELECT name FROM pragma_table_info('telegram_messages')",
    ).all();
    if (!messageColumns.some((column) => column.name === "excerpt")) {
      this.db.exec("ALTER TABLE telegram_messages ADD COLUMN excerpt TEXT");
    }
  }

  close(): void { this.db.close(); }

  ensurePollState(botId: string): void {
    this.db.query(`
      INSERT INTO telegram_poll_state(bot_id, next_offset, updated_at)
      VALUES ($botId, 0, $now) ON CONFLICT(bot_id) DO NOTHING
    `).run({ botId, now: now() });
  }

  nextOffset(botId: string): number {
    const row = this.db.query<{ next_offset: number }, [string]>(
      "SELECT next_offset FROM telegram_poll_state WHERE bot_id = ?",
    ).get(botId);
    return row?.next_offset ?? 0;
  }

  advanceCursor(botId: string, nextOffset: number): void {
    this.db.query(`
      INSERT INTO telegram_poll_state(bot_id,next_offset,updated_at)
      VALUES ($bot,$next,$now)
      ON CONFLICT(bot_id) DO UPDATE SET
        next_offset=MAX(next_offset,excluded.next_offset),updated_at=excluded.updated_at
    `).run({ bot: botId, next: nextOffset, now: now() });
  }

  /**
   * The journal follows the bot, not the folder, but fx sessions are bound to
   * the folder they were launched in. Stamp the owning workspace; when it
   * changes, start a new generation on every route and discard prompts that
   * were queued for the previous folder. Telegram-side facts — poll cursor,
   * update dedup, undelivered outbox, effect ledger — survive the move.
   */
  adoptWorkspace(workspace: string): { previous?: string; changed: boolean; discarded: number } {
    return this.db.transaction(() => {
      const previous = this.db.query<{ value: string }, []>(
        "SELECT value FROM runtime_meta WHERE key='workspace'",
      ).get()?.value;
      this.db.query(`
        INSERT INTO runtime_meta(key,value) VALUES ('workspace',$workspace)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).run({ workspace });
      if (!previous || previous === workspace) {
        return { ...(previous ? { previous } : {}), changed: false, discarded: 0 };
      }
      const timestamp = now();
      this.db.query(`
        UPDATE routes SET session_id=NULL, generation=generation+1,
          dynamic_commands_json='[]', last_prompt_json=NULL, updated_at=?
      `).run(timestamp);
      const discarded = this.db.query(`
        UPDATE telegram_inbox SET status='discarded', payload_json=NULL,
          error='workspace changed', updated_at=?
        WHERE status IN ('received','dispatching','running','interrupted','failed')
      `).run(timestamp).changes;
      this.db.query("UPDATE context_capabilities SET active=0, expires_at=?").run(timestamp);
      this.db.query("UPDATE telegram_messages SET expires_at=?").run(timestamp);
      this.db.query("UPDATE telegram_principals SET expires_at=?").run(timestamp);
      this.db.query("UPDATE telegram_interactions SET state='expired', updated_at=? WHERE state='pending'")
        .run(timestamp);
      return { previous, changed: true, discarded };
    })();
  }

  /** Cursor and authorized payload become durable in the same transaction. */
  ingestUpdate(input: {
    botId: string;
    updateId: number;
    routeKey?: string;
    payload?: unknown;
    authorized: boolean;
    supersede?: { chatId: string; messageId: string };
  }): number | undefined {
    return this.db.transaction(() => {
      let inboxId: number | undefined;
      if (input.authorized && input.routeKey && input.payload !== undefined) {
        this.db.query(`
          INSERT INTO telegram_inbox(
            bot_id, update_id, route_key, status, payload_json, created_at, updated_at
          ) VALUES ($botId, $updateId, $routeKey, 'received', $payload, $now, $now)
          ON CONFLICT(bot_id, update_id) DO NOTHING
        `).run({
          botId: input.botId,
          updateId: input.updateId,
          routeKey: input.routeKey,
          payload: JSON.stringify(input.payload),
          now: now(),
        });
        const row = this.db.query<{ id: number }, [string, number]>(
          "SELECT id FROM telegram_inbox WHERE bot_id = ? AND update_id = ?",
        ).get(input.botId, input.updateId);
        inboxId = row?.id;
        if (inboxId !== undefined && input.supersede) {
          this.db.query(`
            UPDATE telegram_inbox SET status='discarded',payload_json=NULL,updated_at=$now
            WHERE bot_id=$botId AND id<>$id AND status='received'
              AND json_extract(payload_json, '$.kind')='message'
              AND json_extract(payload_json, '$.message.route.chatId')=$chatId
              AND json_extract(payload_json, '$.message.messageId')=$messageId
          `).run({
            botId: input.botId, id: inboxId, chatId: input.supersede.chatId,
            messageId: input.supersede.messageId, now: now(),
          });
        }
      }
      this.db.query(`
        INSERT INTO telegram_poll_state(bot_id, next_offset, updated_at)
        VALUES ($botId, $next, $now)
        ON CONFLICT(bot_id) DO UPDATE SET
          next_offset=MAX(next_offset, excluded.next_offset), updated_at=excluded.updated_at
      `).run({ botId: input.botId, next: input.updateId + 1, now: now() });
      return inboxId;
    })();
  }

  recoverInbox(): { received: InboxRow[]; interrupted: number } {
    return this.db.transaction(() => {
      // Delivery is the terminal proof for a turn. A process can die after the
      // outbox commit but before the adjacent inbox/prompt cleanup; reconcile
      // that tiny window instead of asking the user to rerun delivered work.
      this.db.query(`
        UPDATE routes SET last_prompt_json=NULL,updated_at=$now
        WHERE route_key IN (
          SELECT telegram_inbox.route_key FROM telegram_inbox
          JOIN telegram_outbox ON telegram_outbox.inbox_id=telegram_inbox.id
          WHERE telegram_inbox.status IN ('dispatching','running')
            AND telegram_outbox.status='sent'
        )
      `).run({ now: now() });
      this.db.query(`
        UPDATE telegram_inbox SET status='done',payload_json=NULL,error=NULL,updated_at=$now
        WHERE status IN ('dispatching','running')
          AND EXISTS (
            SELECT 1 FROM telegram_outbox
            WHERE telegram_outbox.inbox_id=telegram_inbox.id
              AND telegram_outbox.status='sent'
          )
      `).run({ now: now() });
      const interrupted = this.db.query(`
        UPDATE telegram_inbox SET status='interrupted', error='process stopped during an accepted turn', updated_at=$now
        WHERE status IN ('dispatching', 'running')
      `).run({ now: now() });
      return {
        received: this.db.query<InboxRow, []>(`
          SELECT * FROM telegram_inbox WHERE status='received' ORDER BY id
        `).all(),
        interrupted: interrupted.changes,
      };
    })();
  }

  coalesceInbox(primaryId: number, payload: unknown, extraIds: number[]): void {
    this.db.transaction(() => {
      this.db.query(`
        UPDATE telegram_inbox SET payload_json=$payload,updated_at=$now
        WHERE id=$id AND status='received'
      `).run({ id: primaryId, payload: JSON.stringify(payload), now: now() });
      for (const id of extraIds) {
        this.db.query(`
          UPDATE telegram_inbox SET status='done',payload_json=NULL,updated_at=?
          WHERE id=? AND status='received'
        `).run(now(), id);
      }
    })();
  }

  inbox(id: number): InboxRow | undefined {
    return this.db.query<InboxRow, [number]>("SELECT * FROM telegram_inbox WHERE id=?").get(id) ?? undefined;
  }

  claimInbox(id: number): boolean {
    const result = this.db.query(`
      UPDATE telegram_inbox SET status='dispatching', attempts=attempts+1, updated_at=$now
      WHERE id=$id AND status='received'
    `).run({ id, now: now() });
    return result.changes === 1;
  }

  markInbox(id: number, status: InboxStatus, error?: string): void {
    const removePayload = status === "done" || status === "discarded";
    this.db.query(`
      UPDATE telegram_inbox SET status=$status, error=$error,
        payload_json=CASE WHEN $removePayload THEN NULL ELSE payload_json END,
        updated_at=$now WHERE id=$id
    `).run({ id, status, error: error ?? null, removePayload: removePayload ? 1 : 0, now: now() });
  }

  discardQueued(routeKey: string, exceptId?: number): number {
    const result = this.db.query(`
      UPDATE telegram_inbox SET status='discarded', payload_json=NULL, updated_at=$now
      WHERE route_key=$routeKey AND status IN ('received','interrupted','failed')
        AND ($exceptId IS NULL OR id<>$exceptId)
    `).run({ routeKey, exceptId: exceptId ?? null, now: now() });
    return result.changes;
  }

  discardInterrupted(routeKey: string): number {
    return this.db.query(`
      UPDATE telegram_inbox SET status='discarded',payload_json=NULL,updated_at=$now
      WHERE route_key=$routeKey AND status IN ('interrupted','failed')
    `).run({ routeKey, now: now() }).changes;
  }

  ensureRoute(route: Route): RouteRow {
    this.db.query(`
      INSERT INTO routes(route_key, bot_id, chat_id, topic_id, chat_kind, updated_at)
      VALUES ($key, $botId, $chatId, $topicId, $kind, $now)
      ON CONFLICT(route_key) DO UPDATE SET chat_kind=excluded.chat_kind, updated_at=excluded.updated_at
    `).run({
      key: route.key, botId: route.botId, chatId: route.chatId,
      topicId: route.topicId, kind: route.chatKind, now: now(),
    });
    return this.route(route.key)!;
  }

  route(key: string): RouteRow | undefined {
    return this.db.query<RouteRow, [string]>("SELECT * FROM routes WHERE route_key=?").get(key) ?? undefined;
  }

  routes(): RouteRow[] {
    return this.db.query<RouteRow, []>("SELECT * FROM routes ORDER BY updated_at DESC").all();
  }

  migrateChat(botId: string, oldChatId: string, newChatId: string): Array<{ oldKey: string; newKey: string }> {
    if (oldChatId === newChatId) return [];
    return this.db.transaction(() => {
      const routes = this.db.query<RouteRow, [string, string]>(
        "SELECT * FROM routes WHERE bot_id=? AND chat_id=? ORDER BY route_key",
      ).all(botId, oldChatId);
      const migrated: Array<{ oldKey: string; newKey: string }> = [];
      for (const route of routes) {
        const newKey = `${botId}:${newChatId}:${route.topic_id}`;
        const collision = this.route(newKey);
        if (collision) {
          throw new Error(`Cannot migrate Telegram route ${route.route_key}: ${newKey} already exists.`);
        }
        this.db.query(`
          INSERT INTO routes(
            route_key,bot_id,chat_id,topic_id,chat_kind,session_id,generation,
            dynamic_commands_json,last_prompt_json,updated_at
          ) VALUES ($newKey,$bot,$chat,$topic,'supergroup',$session,$generation,$commands,$prompt,$now)
        `).run({
          newKey, bot: botId, chat: newChatId, topic: route.topic_id,
          session: route.session_id, generation: route.generation,
          commands: route.dynamic_commands_json, prompt: route.last_prompt_json, now: now(),
        });
        for (const table of [
          "telegram_principals", "telegram_inbox", "telegram_outbox",
          "telegram_interactions", "managed_pins", "effect_ledger",
        ]) {
          this.db.query(`UPDATE ${table} SET route_key=? WHERE route_key=?`).run(newKey, route.route_key);
        }
        this.db.query("UPDATE telegram_messages SET route_key=?,chat_id=? WHERE route_key=?")
          .run(newKey, newChatId, route.route_key);
        this.db.query("UPDATE context_capabilities SET route_key=?,chat_id=? WHERE route_key=?")
          .run(newKey, newChatId, route.route_key);
        this.db.query("DELETE FROM routes WHERE route_key=?").run(route.route_key);
        migrated.push({ oldKey: route.route_key, newKey });
      }
      return migrated;
    })();
  }

  setRouteSession(key: string, sessionId: string, replacedPrevious = false): void {
    this.db.transaction(() => {
      this.db.query(`
        UPDATE routes SET session_id=$session,
          generation=generation+CASE WHEN $replaced THEN 1 ELSE 0 END,
          last_prompt_json=CASE WHEN $replaced THEN NULL ELSE last_prompt_json END,
          updated_at=$now WHERE route_key=$key
      `).run({ session: sessionId, replaced: replacedPrevious ? 1 : 0, now: now(), key });
      if (replacedPrevious) this.expireRouteCapabilities(key);
    })();
  }

  resetRoute(key: string): void {
    this.db.transaction(() => {
      this.db.query(`
        UPDATE routes SET session_id=NULL, generation=generation+1,
          dynamic_commands_json='[]', last_prompt_json=NULL, updated_at=$now WHERE route_key=$key
      `).run({ key, now: now() });
      this.expireRouteCapabilities(key);
    })();
  }

  private expireRouteCapabilities(routeKey: string): void {
    const timestamp = now();
    this.db.query("UPDATE context_capabilities SET active=0,expires_at=? WHERE route_key=?")
      .run(timestamp, routeKey);
    this.db.query("UPDATE telegram_messages SET expires_at=? WHERE route_key=?")
      .run(timestamp, routeKey);
    this.db.query("UPDATE telegram_principals SET expires_at=? WHERE route_key=?")
      .run(timestamp, routeKey);
    this.db.query("UPDATE telegram_interactions SET state='expired',updated_at=? WHERE route_key=? AND state='pending'")
      .run(timestamp, routeKey);
  }

  setCommands(key: string, commands: unknown[]): void {
    this.db.query("UPDATE routes SET dynamic_commands_json=?, updated_at=? WHERE route_key=?")
      .run(JSON.stringify(commands), now(), key);
  }

  setLastPrompt(key: string, prompt: unknown): void {
    this.db.query("UPDATE routes SET last_prompt_json=?, updated_at=? WHERE route_key=?")
      .run(JSON.stringify(prompt), now(), key);
  }

  clearLastPrompt(key: string): void {
    this.db.query("UPDATE routes SET last_prompt_json=NULL, updated_at=? WHERE route_key=?")
      .run(now(), key);
  }

  registerInbound(message: InboundMessage): void {
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const senderTelegramId = "id" in message.sender ? message.sender.id : "unknown";
    const existingPrincipal = this.db.query<{ ref: string }, [string, string, string, string, string]>(`
      SELECT ref FROM telegram_principals
      WHERE bot_id=? AND route_key=? AND principal_kind=? AND telegram_id=? AND expires_at>?
    `).get(message.route.botId, message.route.key, message.sender.kind, senderTelegramId, now());
    if (existingPrincipal) message.sender.ref = existingPrincipal.ref;
    this.db.transaction(() => {
      this.db.query(`
        INSERT INTO telegram_principals(
          ref, bot_id, route_key, principal_kind, telegram_id, display_name, expires_at
        ) VALUES ($ref, $bot, $route, $kind, $id, $name, $expires)
        ON CONFLICT(bot_id, route_key, principal_kind, telegram_id) DO UPDATE SET
          ref=CASE WHEN telegram_principals.expires_at<=$now THEN excluded.ref ELSE telegram_principals.ref END,
          display_name=excluded.display_name, expires_at=excluded.expires_at
      `).run({
        ref: message.sender.ref, bot: message.route.botId, route: message.route.key,
        kind: message.sender.kind, id: senderTelegramId,
        name: "displayName" in message.sender ? message.sender.displayName : null,
        expires, now: now(),
      });
      this.db.query(`
        INSERT INTO telegram_messages(
          ref, bot_id, route_key, chat_id, topic_id, message_id, sender_ref,
          owned_by_bot, excerpt, created_at, expires_at
        ) VALUES ($ref, $bot, $route, $chat, $topic, $message, $sender, 0, $excerpt, $now, $expires)
        ON CONFLICT(bot_id, chat_id, message_id) DO UPDATE SET
          ref=excluded.ref, sender_ref=excluded.sender_ref,
          excerpt=COALESCE(excluded.excerpt, telegram_messages.excerpt),
          expires_at=excluded.expires_at
      `).run({
        ref: message.messageRef, bot: message.route.botId, route: message.route.key,
        chat: message.route.chatId, topic: message.route.topicId,
        message: message.messageId, sender: message.sender.ref,
        excerpt: messageExcerpt(message.text), now: now(), expires,
      });
      const rawMessage = message.raw.message ?? message.raw.edited_message
        ?? message.raw.channel_post ?? message.raw.edited_channel_post;
      if (message.reply && rawMessage?.reply_to_message) {
        this.db.query(`
          INSERT INTO telegram_messages(
            ref, bot_id, route_key, chat_id, topic_id, message_id, sender_ref,
            owned_by_bot, excerpt, created_at, expires_at
          ) VALUES ($ref,$bot,$route,$chat,$topic,$message,NULL,$owned,$excerpt,$now,$expires)
          ON CONFLICT(bot_id, chat_id, message_id) DO UPDATE SET
            excerpt=COALESCE(excluded.excerpt, telegram_messages.excerpt),
            expires_at=excluded.expires_at
        `).run({
          ref: message.reply.message_ref, bot: message.route.botId, route: message.route.key,
          chat: message.route.chatId, topic: message.route.topicId,
          message: String(rawMessage.reply_to_message.message_id),
          owned: rawMessage.reply_to_message.from?.id === Number(message.route.botId) ? 1 : 0,
          excerpt: messageExcerpt(message.reply.text_excerpt), now: now(), expires,
        });
      }
      this.db.query("UPDATE context_capabilities SET active=0 WHERE route_key=?").run(message.route.key);
      this.db.query(`
        INSERT INTO context_capabilities(
          context_ref, bot_id, route_key, chat_id, topic_id, message_ref, message_id,
          sender_ref, attachments_json, active, expires_at, created_at
        ) VALUES ($context, $bot, $route, $chat, $topic, $messageRef, $messageId,
          $sender, $attachments, 1, $expires, $now)
      `).run({
        context: message.contextRef, bot: message.route.botId, route: message.route.key,
        chat: message.route.chatId, topic: message.route.topicId,
        messageRef: message.messageRef, messageId: message.messageId,
        sender: message.sender.ref, attachments: JSON.stringify(message.attachments),
        expires, now: now(),
      });
    })();
  }

  activeContext(routeKey: string): ContextCapability | undefined {
    return this.db.query<ContextCapability, [string, string]>(`
      SELECT context_ref, bot_id, route_key, chat_id, topic_id, message_ref,
        message_id, sender_ref, attachments_json, expires_at
      FROM context_capabilities
      WHERE route_key=? AND active=1 AND expires_at>?
      ORDER BY created_at DESC LIMIT 1
    `).get(routeKey, now()) ?? undefined;
  }

  activateContext(routeKey: string, contextRef: string): boolean {
    return this.db.transaction(() => {
      const target = this.db.query<{ context_ref: string }, [string, string, string]>(`
        SELECT context_ref FROM context_capabilities
        WHERE route_key=? AND context_ref=? AND expires_at>?
      `).get(routeKey, contextRef, now());
      if (!target) return false;
      this.db.query("UPDATE context_capabilities SET active=0 WHERE route_key=?").run(routeKey);
      this.db.query("UPDATE context_capabilities SET active=1 WHERE route_key=? AND context_ref=?")
        .run(routeKey, contextRef);
      return true;
    })();
  }

  deactivateContext(routeKey: string, contextRef: string): void {
    this.db.query("UPDATE context_capabilities SET active=0 WHERE route_key=? AND context_ref=?")
      .run(routeKey, contextRef);
  }

  messageReference(ref: string, routeKey: string): MessageReference | undefined {
    return this.db.query<MessageReference, [string, string, string]>(`
      SELECT ref, bot_id, route_key, chat_id, topic_id, message_id, sender_ref, owned_by_bot
      FROM telegram_messages WHERE ref=? AND route_key=? AND expires_at>?
    `).get(ref, routeKey, now()) ?? undefined;
  }

  managedMessageReference(ref: string, routeKey: string): MessageReference | undefined {
    return this.db.query<MessageReference, [string, string]>(`
      SELECT ref, bot_id, route_key, chat_id, topic_id, message_id, sender_ref, owned_by_bot
      FROM telegram_messages WHERE ref=? AND route_key=? AND owned_by_bot=1
    `).get(ref, routeKey) ?? undefined;
  }

  messageReferenceByTelegramId(botId: string, chatId: string, messageId: string): MessageReference | undefined {
    return this.db.query<MessageReference, [string, string, string, string]>(`
      SELECT ref, bot_id, route_key, chat_id, topic_id, message_id, sender_ref, owned_by_bot
      FROM telegram_messages WHERE bot_id=? AND chat_id=? AND message_id=? AND expires_at>?
    `).get(botId, chatId, messageId, now()) ?? undefined;
  }

  principal(ref: string, routeKey: string): { telegram_id: string; principal_kind: string } | undefined {
    return this.db.query<{ telegram_id: string; principal_kind: string }, [string, string, string]>(`
      SELECT telegram_id, principal_kind FROM telegram_principals
      WHERE ref=? AND route_key=? AND expires_at>?
    `).get(ref, routeKey, now()) ?? undefined;
  }

  registerPrincipal(input: {
    ref: string; botId: string; routeKey: string; kind: "user" | "chat";
    telegramId: string; displayName?: string; expiresAt: string;
  }): string {
    const existing = this.db.query<{ ref: string }, [string, string, string, string, string]>(`
      SELECT ref FROM telegram_principals
      WHERE bot_id=? AND route_key=? AND principal_kind=? AND telegram_id=? AND expires_at>?
    `).get(input.botId, input.routeKey, input.kind, input.telegramId, now());
    if (existing) {
      this.db.query("UPDATE telegram_principals SET display_name=?,expires_at=? WHERE ref=?")
        .run(input.displayName ?? null, input.expiresAt, existing.ref);
      return existing.ref;
    }
    this.db.query(`
      INSERT INTO telegram_principals(
        ref,bot_id,route_key,principal_kind,telegram_id,display_name,expires_at
      ) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(bot_id,route_key,principal_kind,telegram_id) DO UPDATE SET
        ref=excluded.ref,display_name=excluded.display_name,expires_at=excluded.expires_at
    `).run(
      input.ref, input.botId, input.routeKey, input.kind, input.telegramId,
      input.displayName ?? null, input.expiresAt,
    );
    return input.ref;
  }

  pendingJoinRequests(routeKey: string): Array<{
    request_ref: string; member_ref: string; display_name?: string; bio?: string;
  }> {
    return this.db.query<{ interaction_id: string; payload_json: string }, [string, string]>(`
      SELECT interaction_id,payload_json FROM telegram_interactions
      WHERE route_key=? AND kind='join_request' AND state='pending' AND expires_at>?
      ORDER BY updated_at DESC LIMIT 20
    `).all(routeKey, now()).map((row) => {
      const payload = JSON.parse(row.payload_json) as { memberRef: string; displayName?: string; bio?: string };
      return {
        request_ref: `join_${row.interaction_id}`,
        member_ref: payload.memberRef,
        ...(payload.displayName ? { display_name: payload.displayName } : {}),
        ...(payload.bio ? { bio: payload.bio } : {}),
      };
    });
  }

  registerBotMessage(input: {
    ref: string; botId: string; routeKey: string; chatId: string;
    topicId: string; messageId: string; excerpt?: string;
  }): void {
    const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    this.db.query(`
      INSERT INTO telegram_messages(
        ref, bot_id, route_key, chat_id, topic_id, message_id, owned_by_bot, excerpt, created_at, expires_at
      ) VALUES ($ref,$bot,$route,$chat,$topic,$message,1,$excerpt,$now,$expires)
      ON CONFLICT(bot_id, chat_id, message_id) DO UPDATE SET ref=excluded.ref,
        excerpt=COALESCE(excluded.excerpt, telegram_messages.excerpt),
        expires_at=excluded.expires_at
    `).run({
      ref: input.ref, bot: input.botId, route: input.routeKey,
      chat: input.chatId, topic: input.topicId, message: input.messageId,
      excerpt: messageExcerpt(input.excerpt), now: now(), expires,
    });
  }

  updateMessageExcerpt(ref: string, routeKey: string, text: string): void {
    this.db.query("UPDATE telegram_messages SET excerpt=? WHERE ref=? AND route_key=?")
      .run(messageExcerpt(text), ref, routeKey);
  }

  /** Newest observed messages for one route, returned oldest first. */
  recentMessages(routeKey: string, limit: number): RecentMessage[] {
    return this.db.query<RecentMessage, [string, string, number]>(`
      SELECT m.ref, m.sender_ref, p.display_name AS sender_display_name,
        m.owned_by_bot, m.created_at, m.excerpt
      FROM telegram_messages m
      LEFT JOIN telegram_principals p ON p.ref = m.sender_ref AND p.route_key = m.route_key
      WHERE m.route_key=? AND m.expires_at>?
      ORDER BY CAST(m.message_id AS INTEGER) DESC LIMIT ?
    `).all(routeKey, now(), limit).reverse();
  }

  createOutbox(input: {
    effectKey: string; botId: string; routeKey: string; inboxId?: number;
    kind: string; payload: unknown;
  }): number {
    this.db.query(`
      INSERT INTO telegram_outbox(
        effect_key, bot_id, route_key, inbox_id, kind, payload_json, status, created_at, updated_at
      ) VALUES ($effect,$bot,$route,$inbox,$kind,$payload,'pending',$now,$now)
      ON CONFLICT(effect_key) DO NOTHING
    `).run({
      effect: input.effectKey, bot: input.botId, route: input.routeKey,
      inbox: input.inboxId ?? null, kind: input.kind,
      payload: JSON.stringify(input.payload), now: now(),
    });
    return this.db.query<{ id: number }, [string]>(
      "SELECT id FROM telegram_outbox WHERE effect_key=?",
    ).get(input.effectKey)!.id;
  }

  recoverableOutbox(options: { routeKey?: string; includeFailed?: boolean } = {}): Array<{
    id: number; effect_key: string; bot_id: string; route_key: string;
    inbox_id: number | null; kind: string; payload_json: string; status: OutboxStatus; attempts: number;
  }> {
    return this.db.query<any, { route: string | null; failed: number }>(`
      SELECT * FROM telegram_outbox
      WHERE (status IN ('pending','sending') OR ($failed=1 AND status='failed'))
        AND ($route IS NULL OR route_key=$route)
      ORDER BY id
    `).all({ route: options.routeKey ?? null, failed: options.includeFailed ? 1 : 0 });
  }

  abandonOutbox(routeKey: string, reason: string): number {
    return this.db.query(`
      UPDATE telegram_outbox SET status='abandoned',payload_json='{}',error=$reason,updated_at=$now
      WHERE route_key=$route AND status IN ('pending','sending','failed')
    `).run({ route: routeKey, reason, now: now() }).changes;
  }

  markOutbox(id: number, status: OutboxStatus, messageId?: string, error?: string): void {
    this.db.query(`
      UPDATE telegram_outbox SET status=$status,
        attempts=CASE WHEN $status='sending' THEN attempts+1 ELSE attempts END,
        payload_json=CASE WHEN $status IN ('sent','abandoned') THEN '{}' ELSE payload_json END,
        telegram_message_id=COALESCE($message,telegram_message_id), error=$error, updated_at=$now
      WHERE id=$id
    `).run({ id, status, message: messageId ?? null, error: error ?? null, now: now() });
  }

  beginEffect(input: { effectKey: string; botId: string; routeKey: string; toolName: string }): "new" | "complete" | "unknown" {
    const existing = this.db.query<{ state: string }, [string]>(
      "SELECT state FROM effect_ledger WHERE effect_key=?",
    ).get(input.effectKey);
    if (existing) return existing.state === "complete" ? "complete" : "unknown";
    this.db.query(`
      INSERT INTO effect_ledger(effect_key,bot_id,route_key,tool_name,state,created_at,updated_at)
      VALUES ($effect,$bot,$route,$tool,'running',$now,$now)
    `).run({ effect: input.effectKey, bot: input.botId, route: input.routeKey, tool: input.toolName, now: now() });
    return "new";
  }

  completeEffect(effectKey: string, result: unknown): void {
    this.db.query("UPDATE effect_ledger SET state='complete',result_json=?,updated_at=? WHERE effect_key=?")
      .run(JSON.stringify(result), now(), effectKey);
  }

  effectResult(effectKey: string): unknown {
    const row = this.db.query<{ result_json: string | null }, [string]>(
      "SELECT result_json FROM effect_ledger WHERE effect_key=?",
    ).get(effectKey);
    return row?.result_json ? JSON.parse(row.result_json) : undefined;
  }

  createInteraction(input: {
    id: string; botId: string; routeKey: string; kind: string; payload: unknown; expiresAt: string;
  }): void {
    this.db.query(`
      INSERT INTO telegram_interactions(
        interaction_id,bot_id,route_key,kind,payload_json,state,expires_at,updated_at
      ) VALUES ($id,$bot,$route,$kind,$payload,'pending',$expires,$now)
    `).run({
      id: input.id, bot: input.botId, route: input.routeKey, kind: input.kind,
      payload: JSON.stringify(input.payload), expires: input.expiresAt, now: now(),
    });
  }

  interaction(id: string): {
    interaction_id: string; route_key: string; kind: string; payload_json: string;
    state: string; result_json: string | null; expires_at: string;
  } | undefined {
    return this.db.query<any, [string]>(
      "SELECT * FROM telegram_interactions WHERE interaction_id=?",
    ).get(id) ?? undefined;
  }

  pollInteraction(pollId: string): ReturnType<StateStore["interaction"]> {
    return this.db.query<any, [string]>(`
      SELECT * FROM telegram_interactions
      WHERE kind='poll' AND json_extract(payload_json, '$.pollId')=?
      ORDER BY updated_at DESC LIMIT 1
    `).get(pollId) ?? undefined;
  }

  resolveInteraction(id: string, result: unknown): boolean {
    return this.db.query(`
      UPDATE telegram_interactions SET state='resolved',result_json=$result,updated_at=$now
      WHERE interaction_id=$id AND state='pending' AND expires_at>$now
    `).run({ id, result: JSON.stringify(result), now: now() }).changes === 1;
  }

  failEffect(effectKey: string, error: string, unknown = false): void {
    this.db.query("UPDATE effect_ledger SET state=?,error=?,updated_at=? WHERE effect_key=?")
      .run(unknown ? "unknown" : "failed", error, now(), effectKey);
  }

  expireInteraction(id: string): boolean {
    return this.db.query(`
      UPDATE telegram_interactions SET state='expired',updated_at=$now
      WHERE interaction_id=$id AND state='pending'
    `).run({ id, now: now() }).changes === 1;
  }

  expireInteractions(routeKey: string, kind: string): number {
    return this.db.query(`
      UPDATE telegram_interactions SET state='expired',updated_at=$now
      WHERE route_key=$route AND kind=$kind AND state='pending'
    `).run({ route: routeKey, kind, now: now() }).changes;
  }

  /** Remembers which Telegram message carries an interaction's buttons. */
  attachInteractionCard(id: string, card: InteractionCard): void {
    this.db.query(`
      UPDATE telegram_interactions SET payload_json=json_set(payload_json,'$.card',json($card)),updated_at=$now
      WHERE interaction_id=$id
    `).run({ id, card: JSON.stringify(card), now: now() });
  }

  /** Approval cards still waiting for an answer, oldest first. */
  pendingApprovals(botId: string): Array<{ id: string; kind: string; card?: InteractionCard }> {
    const rows = this.db.query<{ interaction_id: string; kind: string; payload_json: string }, [string]>(`
      SELECT interaction_id, kind, payload_json FROM telegram_interactions
      WHERE bot_id=? AND state='pending' AND (kind='fx_permission' OR kind LIKE 'telegram_admin:%')
      ORDER BY updated_at
    `).all(botId);
    return rows.map((row) => {
      const card = (JSON.parse(row.payload_json) as { card?: InteractionCard }).card;
      return { id: row.interaction_id, kind: row.kind, ...(card ? { card } : {}) };
    });
  }

  prune(): void {
    const retention = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.transaction(() => {
      this.db.query("DELETE FROM telegram_inbox WHERE status IN ('done','discarded') AND updated_at<?").run(retention);
      this.db.query("DELETE FROM telegram_outbox WHERE status IN ('sent','abandoned') AND updated_at<?").run(retention);
      this.db.query("DELETE FROM context_capabilities WHERE expires_at<?").run(now());
      this.db.query(`
        DELETE FROM telegram_messages WHERE expires_at<?
          AND ref NOT IN (SELECT message_ref FROM managed_pins)
      `).run(now());
      this.db.query("DELETE FROM telegram_principals WHERE expires_at<?").run(now());
      this.db.query("DELETE FROM telegram_interactions WHERE expires_at<?").run(now());
      this.db.query("DELETE FROM effect_ledger WHERE state IN ('complete','failed','abandoned') AND updated_at<?").run(retention);
    })();
  }
}
