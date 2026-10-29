
      CREATE TABLE IF NOT EXISTS chat_history (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace TEXT NOT NULL, route TEXT NOT NULL, message_id TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT '',
        event_key TEXT NOT NULL, ref TEXT NOT NULL, at TEXT NOT NULL,
        observed_at TEXT NOT NULL, text TEXT, data TEXT NOT NULL,
        invoked INTEGER NOT NULL DEFAULT 0, owned INTEGER NOT NULL DEFAULT 0,
        UNIQUE(workspace, route, event_key)
      );
      CREATE INDEX IF NOT EXISTS history_route ON chat_history(workspace, route, message_id, seq);
      CREATE TABLE IF NOT EXISTS history_routes (
        workspace TEXT NOT NULL, route TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
        cleared INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace, route)
      );
      CREATE TABLE IF NOT EXISTS history_turns (
        workspace TEXT NOT NULL, route TEXT NOT NULL, context_ref TEXT PRIMARY KEY,
        through_seq INTEGER NOT NULL, inbox_id INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS history_cursors (
        token TEXT PRIMARY KEY, workspace TEXT NOT NULL, route TEXT NOT NULL, window TEXT NOT NULL
      );
    