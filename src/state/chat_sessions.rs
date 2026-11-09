use super::*;

impl State {
    /// Keep the main conversation and import old thread histories without replaying turns.
    pub(super) fn migrate_chat_sessions(&self) -> Result<()> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        if one(
            &tx,
            "SELECT 1 FROM runtime_meta WHERE key='chat_sessions_v1'",
            [],
        )?
        .is_some()
        {
            return Ok(());
        }
        let legacy = rows(&tx, "SELECT * FROM routes WHERE topic_id<>'0'", [])?;
        for row in legacy {
            let old: RouteRow = serde_json::from_value(row.clone())?;
            // Private whisper routes, if present in an older database, remain private.
            if old.route_key != format!("{}:{}:{}", old.bot_id, old.chat_id, old.topic_id) {
                continue;
            }
            let route = Route::new(&old.bot_id, &old.chat_id, "0", &old.chat_kind);
            tx.execute("INSERT OR IGNORE INTO routes(route_key,bot_id,chat_id,topic_id,chat_kind,updated_at) VALUES (?,?,?,'0',?,?)", params![route.key,old.bot_id,old.chat_id,old.chat_kind,now()])?;
            tx.execute(
                "INSERT OR REPLACE INTO runtime_meta VALUES (?,?)",
                params![format!("legacy_route:{}", old.route_key), row.to_string()],
            )?;

            // Preserve each message's original thread, and leave cleared history archived.
            tx.execute("UPDATE chat_history SET data=json_set(data,'$.thread_id',?) WHERE route=? AND json_extract(data,'$.thread_id') IS NULL", params![old.topic_id,old.route_key])?;
            tx.execute("UPDATE OR IGNORE chat_history SET route=? WHERE route=? AND seq>coalesce((SELECT cleared FROM history_routes WHERE workspace=chat_history.workspace AND route=?),0)", params![route.key,old.route_key,old.route_key])?;
            tx.execute(
                "UPDATE history_turns SET route=? WHERE route=?",
                params![route.key, old.route_key],
            )?;
            tx.execute(
                "DELETE FROM history_cursors WHERE route=?",
                [&old.route_key],
            )?;

            // Consolidate duplicate people while retaining references used by saved messages.
            let people = rows(
                &tx,
                "SELECT * FROM telegram_principals WHERE route_key=?",
                [&old.route_key],
            )?;
            for person in people {
                if let Some(existing) = one(
                    &tx,
                    "SELECT ref FROM telegram_principals WHERE bot_id=? AND route_key=? AND principal_kind=? AND telegram_id=?",
                    params![
                        old.bot_id,
                        route.key,
                        person["principal_kind"].as_str(),
                        person["telegram_id"].as_str()
                    ],
                )? {
                    for table in ["telegram_messages", "context_capabilities"] {
                        tx.execute(
                            &format!("UPDATE {table} SET sender_ref=? WHERE sender_ref=?"),
                            params![existing["ref"].as_str(), person["ref"].as_str()],
                        )?;
                    }
                    tx.execute(
                        "DELETE FROM telegram_principals WHERE ref=?",
                        [person["ref"].as_str()],
                    )?;
                } else {
                    tx.execute(
                        "UPDATE telegram_principals SET route_key=? WHERE ref=?",
                        params![route.key, person["ref"].as_str()],
                    )?;
                }
            }
            // Pin every pending delivery to its original Telegram destination before merging.
            tx.execute("UPDATE telegram_outbox SET payload_json=json_set(payload_json,'$.route',json(?)) WHERE route_key=? AND json_type(payload_json,'$.route') IS NULL",params![serde_json::to_string(&old.as_route())?,old.route_key])?;
            for table in [
                "telegram_messages",
                "context_capabilities",
                "telegram_inbox",
                "telegram_outbox",
                "telegram_interactions",
                "effect_ledger",
            ] {
                tx.execute(
                    &format!("UPDATE {table} SET route_key=? WHERE route_key=?"),
                    params![route.key, old.route_key],
                )?;
            }
            // A chat has one managed bulletin; retain other old pin records as archives.
            tx.execute(
                "UPDATE OR IGNORE managed_pins SET route_key=? WHERE route_key=?",
                params![route.key, old.route_key],
            )?;
            tx.execute(
                "UPDATE context_capabilities SET active=0 WHERE route_key=?",
                [&route.key],
            )?;
            tx.execute("DELETE FROM routes WHERE route_key=?", [&old.route_key])?;
        }
        let pending = rows(
            &tx,
            "SELECT id,payload_json FROM telegram_inbox WHERE payload_json IS NOT NULL",
            [],
        )?;
        for row in pending {
            let mut payload: Value = serde_json::from_str(row["payload_json"].as_str().unwrap())?;
            canonicalize_routes(&mut payload);
            tx.execute(
                "UPDATE telegram_inbox SET payload_json=? WHERE id=?",
                params![payload.to_string(), row["id"].as_i64()],
            )?;
        }
        if one(
            &tx,
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='external_events'",
            [],
        )?
        .is_some()
        {
            tx.execute("UPDATE external_events SET destination=bot||':'||json_extract(payload,'$.chatId')||':0' WHERE json_extract(payload,'$.chatId') IS NOT NULL",[])?;
        }
        tx.execute(
            "INSERT INTO runtime_meta VALUES ('chat_sessions_v1','1')",
            [],
        )?;
        tx.commit()?;
        Ok(())
    }
}

fn canonicalize_routes(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if let (Some(bot), Some(chat), Some(topic), Some(key)) = (
                map.get("botId").and_then(Value::as_str),
                map.get("chatId").and_then(Value::as_str),
                map.get("topicId").and_then(Value::as_str),
                map.get("key").and_then(Value::as_str),
            ) && key == format!("{bot}:{chat}:{topic}")
            {
                map.insert("key".into(), json!(format!("{bot}:{chat}:0")));
            }
            for child in map.values_mut() {
                canonicalize_routes(child);
            }
        }
        Value::Array(values) => {
            for child in values {
                canonicalize_routes(child);
            }
        }
        _ => {}
    }
}
