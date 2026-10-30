
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
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS context_usage (
  route_key TEXT PRIMARY KEY REFERENCES routes(route_key) ON UPDATE CASCADE ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  model TEXT NOT NULL,
  used INTEGER NOT NULL CHECK (used >= 0),
  size INTEGER NOT NULL CHECK (size > 0)
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

CREATE INDEX IF NOT EXISTS telegram_messages_route_recent
  ON telegram_messages(route_key, CAST(message_id AS INTEGER) DESC);

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
  message_ref TEXT,
  message_id TEXT,
  sender_ref TEXT,
  attachments_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS context_route_active
  ON context_capabilities(route_key, active, created_at DESC);
