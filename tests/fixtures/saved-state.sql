-- Saved database format before the native rewrite. Values are synthetic.
CREATE TABLE chat_history (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL, route TEXT NOT NULL, message_id TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT '',
        event_key TEXT NOT NULL, ref TEXT NOT NULL, at TEXT NOT NULL,
        observed_at TEXT NOT NULL, text TEXT, data TEXT NOT NULL,
        invoked INTEGER NOT NULL DEFAULT 0, owned INTEGER NOT NULL DEFAULT 0,
        UNIQUE(workspace, route, event_key)
      );
CREATE TABLE context_capabilities (
  context_ref TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  message_ref TEXT,
  message_id TEXT,
  sender_ref TEXT,
  attachments_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE effect_ledger (
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
CREATE TABLE external_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, bot TEXT NOT NULL,
      id TEXT NOT NULL, destination TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
      result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(workspace,bot,id));
INSERT INTO "external_events" ("seq","workspace","bot","id","destination","payload","status","result","error","created_at","updated_at") VALUES (1,'__WORKSPACE__','100','saved-event','100:background','{"id":"saved-event","name":"email.received","payload":{"message_id":"one","mixed":{"_":4,"a":3,"A":2,"ä":1},"thread_id":"two"},"steer":false}','queued',NULL,NULL,'2026-10-29T19:12:08.048Z','2026-10-29T19:12:08.048Z');
CREATE TABLE external_sessions (
        workspace TEXT NOT NULL, bot TEXT NOT NULL, session_id TEXT NOT NULL,
        PRIMARY KEY(workspace,bot));
CREATE TABLE history_cursors (
        token TEXT PRIMARY KEY, workspace TEXT NOT NULL, route TEXT NOT NULL, window TEXT NOT NULL
      );
CREATE TABLE history_routes (
        workspace TEXT NOT NULL, route TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
        cleared INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace, route)
      );
CREATE TABLE history_turns (
        workspace TEXT NOT NULL, route TEXT NOT NULL, context_ref TEXT PRIMARY KEY,
        through_seq INTEGER NOT NULL, inbox_id INTEGER NOT NULL
      );
CREATE TABLE managed_pins (
  bot_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  message_ref TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(bot_id, route_key)
);
CREATE TABLE routes (
  route_key TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  chat_kind TEXT NOT NULL,
  session_id TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
INSERT INTO "routes" ("route_key","bot_id","chat_id","topic_id","chat_kind","session_id","generation","updated_at") VALUES ('100:-9:0','100','-9','0','supergroup','saved-session',1,'2026-10-29T19:12:08.034Z');
CREATE TABLE runtime_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE telegram_inbox (
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
INSERT INTO "telegram_inbox" ("id","bot_id","update_id","route_key","status","payload_json","attempts","error","created_at","updated_at") VALUES (1,'100',7,'100:-9:0','received','{"kind":"message","saved":true}',0,NULL,'2026-10-29T19:12:08.034Z','2026-10-29T19:12:08.034Z');
CREATE TABLE telegram_interactions (
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
INSERT INTO "telegram_interactions" ("interaction_id","bot_id","route_key","kind","payload_json","state","result_json","expires_at","updated_at") VALUES ('saved-choice','100','100:-9:0','choice','{"question":"Pick","options":["A","B"]}','pending',NULL,'2999-01-01T00:00:00.000Z','2026-10-29T19:12:08.035Z');
CREATE TABLE telegram_messages (
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
CREATE TABLE telegram_outbox (
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
CREATE TABLE telegram_poll_state (
  bot_id TEXT PRIMARY KEY,
  next_offset INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
INSERT INTO "telegram_poll_state" ("bot_id","next_offset","updated_at") VALUES ('100',8,'2026-10-29T19:12:08.034Z');
CREATE TABLE telegram_principals (
  ref TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  route_key TEXT NOT NULL,
  principal_kind TEXT NOT NULL,
  telegram_id TEXT NOT NULL,
  display_name TEXT,
  expires_at TEXT NOT NULL,
  UNIQUE(bot_id, route_key, principal_kind, telegram_id)
);
CREATE INDEX context_route_active
  ON context_capabilities(route_key, active, created_at DESC);
CREATE INDEX history_route ON chat_history(workspace, route, message_id, seq);
CREATE INDEX telegram_inbox_route_status
  ON telegram_inbox(route_key, status, id);
CREATE INDEX telegram_messages_route_recent
  ON telegram_messages(route_key, CAST(message_id AS INTEGER) DESC);
CREATE INDEX telegram_outbox_status ON telegram_outbox(status, id);
