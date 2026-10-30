use crate::{
    history::History,
    types::{InboundMessage, Route, new_ref, now},
};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

#[derive(Clone)]
pub struct State {
    pub db: Arc<Mutex<Connection>>,
    pub history: History,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxRow {
    pub id: i64,
    pub bot_id: String,
    pub update_id: i64,
    pub route_key: String,
    pub status: String,
    pub payload_json: Option<String>,
    pub attempts: i64,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteRow {
    pub route_key: String,
    pub bot_id: String,
    pub chat_id: String,
    pub topic_id: String,
    pub chat_kind: String,
    pub session_id: Option<String>,
    pub generation: i64,
    pub updated_at: String,
}
impl RouteRow {
    pub fn as_route(&self) -> Route {
        Route {
            key: self.route_key.clone(),
            bot_id: self.bot_id.clone(),
            chat_id: self.chat_id.clone(),
            topic_id: self.topic_id.clone(),
            chat_kind: self.chat_kind.clone(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextCapability {
    pub context_ref: String,
    pub bot_id: String,
    pub route_key: String,
    pub chat_id: String,
    pub topic_id: String,
    pub message_ref: Option<String>,
    pub message_id: Option<String>,
    pub sender_ref: Option<String>,
    pub attachments_json: String,
    pub expires_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageReference {
    #[serde(rename = "ref")]
    pub reference: String,
    pub bot_id: String,
    pub route_key: String,
    pub chat_id: String,
    pub topic_id: String,
    pub message_id: String,
    pub sender_ref: Option<String>,
    pub owned_by_bot: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboxRow {
    pub id: i64,
    pub effect_key: String,
    pub bot_id: String,
    pub route_key: String,
    pub inbox_id: Option<i64>,
    pub kind: String,
    pub payload_json: String,
    pub status: String,
    pub attempts: i64,
}

pub fn rows(db: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Value>> {
    let mut stmt = db.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().map(|s| s.to_string()).collect();
    let mut query = stmt.query(p)?;
    let mut result = Vec::new();
    while let Some(row) = query.next()? {
        let mut obj = serde_json::Map::new();
        for (i, n) in names.iter().enumerate() {
            let v = match row.get_ref(i)? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(n) => json!(n),
                rusqlite::types::ValueRef::Real(n) => json!(n),
                rusqlite::types::ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                rusqlite::types::ValueRef::Blob(_) => Value::Null,
            };
            obj.insert(n.clone(), v);
        }
        result.push(Value::Object(obj));
    }
    Ok(result)
}
pub fn one(db: &Connection, sql: &str, p: impl rusqlite::Params) -> Result<Option<Value>> {
    Ok(rows(db, sql, p)?.into_iter().next())
}
pub fn expires(days: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::days(days))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn message_excerpt(s: Option<&str>) -> Option<String> {
    let s = s?.trim();
    if s.is_empty() {
        None
    } else {
        let mut text: String = s.chars().take(200).collect();
        if s.chars().count() > 200 {
            text.push('…');
        }
        Some(text)
    }
}
impl State {
    pub fn open(database: &Path, workspace: &Path) -> Result<Self> {
        if let Some(p) = database.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(p)?;
            private_mode(p, 0o700)?;
        }
        let db = Connection::open(database)?;
        db.execute_batch(include_str!("state_schema.sql"))?;
        private_mode(database, 0o600)?;
        if db.query_row("SELECT [notnull] FROM pragma_table_info('context_capabilities') WHERE name='message_ref'",[],|r|r.get::<_,i64>(0))?!=0{
            db.execute_batch("BEGIN; ALTER TABLE context_capabilities RENAME TO legacy_context_capabilities; DROP INDEX context_route_active;")?;
            let schema=include_str!("state_schema.sql");let section=&schema[schema.find("CREATE TABLE IF NOT EXISTS context_capabilities").unwrap()..];db.execute_batch(section)?;
            db.execute_batch("INSERT INTO context_capabilities SELECT * FROM legacy_context_capabilities; DROP TABLE legacy_context_capabilities; COMMIT;")?;
        }
        if db
            .query_row(
                "SELECT 1 FROM pragma_table_info('telegram_messages') WHERE name='excerpt'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_none()
        {
            db.execute_batch("ALTER TABLE telegram_messages ADD COLUMN excerpt TEXT")?;
        }
        for col in ["last_prompt_json", "dynamic_commands_json"] {
            if db
                .query_row(
                    "SELECT 1 FROM pragma_table_info('routes') WHERE name=?",
                    [col],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?
                .is_some()
            {
                db.execute_batch(&format!("ALTER TABLE routes DROP COLUMN {col}"))?;
            }
        }
        let db = Arc::new(Mutex::new(db));
        let history = History::new(db.clone(), workspace.to_string_lossy().into_owned())?;
        Ok(Self { db, history })
    }
    pub fn connection(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| anyhow::anyhow!("State database mutex poisoned"))
    }
    pub fn query(&self, sql: &str, p: impl rusqlite::Params) -> Result<Vec<Value>> {
        rows(&*self.connection()?, sql, p)
    }
    pub fn next_offset(&self, bot: &str) -> Result<i64> {
        Ok(self
            .connection()?
            .query_row(
                "SELECT next_offset FROM telegram_poll_state WHERE bot_id=?",
                [bot],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }
    pub fn advance_cursor(&self, bot: &str, offset: i64) -> Result<()> {
        self.connection()?.execute("INSERT INTO telegram_poll_state VALUES (?,?,?) ON CONFLICT(bot_id) DO UPDATE SET next_offset=max(next_offset,excluded.next_offset),updated_at=excluded.updated_at",params![bot,offset,now()])?;
        Ok(())
    }
    pub fn adopt_workspace(&self, workspace: &str) -> Result<Value> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT value FROM runtime_meta WHERE key='workspace'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        tx.execute("INSERT INTO runtime_meta VALUES ('workspace',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[workspace])?;
        let changed = previous.as_deref().is_some_and(|p| p != workspace);
        let mut discarded = 0;
        if changed {
            let t = now();
            tx.execute("DELETE FROM context_usage", [])?;
            tx.execute(
                "UPDATE routes SET session_id=NULL,generation=generation+1,updated_at=?",
                [&t],
            )?;
            discarded=tx.execute("UPDATE telegram_inbox SET status='discarded',payload_json=NULL,error='workspace changed',updated_at=? WHERE status IN ('received','dispatching','running','interrupted','failed')",[&t])?;
            for table in [
                "context_capabilities",
                "telegram_messages",
                "telegram_principals",
            ] {
                tx.execute(&format!("UPDATE {table} SET expires_at=?"), [&t])?;
            }
            tx.execute("UPDATE context_capabilities SET active=0", [])?;
            tx.execute("UPDATE telegram_interactions SET state='expired',updated_at=? WHERE state='pending'",[&t])?;
        }
        tx.commit()?;
        Ok(json!({"previous":previous,"changed":changed,"discarded":discarded}))
    }
    pub fn ingest_update(
        &self,
        bot: &str,
        update: i64,
        route: Option<&str>,
        payload: Option<&Value>,
        mut message: Option<&mut InboundMessage>,
        authorized: bool,
    ) -> Result<Option<i64>> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let mut id = None;
        if authorized && let (Some(route), Some(payload)) = (route, payload) {
            if let Some(m) = message.as_mut() {
                self.history.record_inbound_with(&tx, m)?;
            }
            let mut value = payload.clone();
            if let Some(m) = message {
                value["message"] = serde_json::to_value(m)?;
            }
            tx.execute("INSERT INTO telegram_inbox(bot_id,update_id,route_key,status,payload_json,created_at,updated_at) VALUES (?,?,?,'received',?,?,?) ON CONFLICT(bot_id,update_id) DO NOTHING",params![bot,update,route,value.to_string(),now(),now()])?;
            id = tx
                .query_row(
                    "SELECT id FROM telegram_inbox WHERE bot_id=? AND update_id=?",
                    params![bot, update],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(m) = value
                .get("message")
                .filter(|m| m["event"] == "message.edited")
                .cloned()
            {
                // A merged album is still one queued request. Keep its members
                // so an edit can replace one photo without dropping the rest.
                if let Some(album) = one(
                    &tx,
                    "SELECT id,payload_json FROM telegram_inbox WHERE bot_id=? AND route_key=? AND id<>? AND status='received' AND EXISTS(SELECT 1 FROM json_each(payload_json,'$.albumMessages') AS member WHERE json_extract(member.value,'$.messageId')=?) ORDER BY id DESC LIMIT 1",
                    params![bot, route, id, m["messageId"].as_str()],
                )? {
                    let payload: Value = serde_json::from_str(
                        album["payload_json"]
                            .as_str()
                            .context("Missing album payload")?,
                    )?;
                    let mut members: Vec<InboundMessage> =
                        serde_json::from_value(payload["albumMessages"].clone())?;
                    let edited: InboundMessage = serde_json::from_value(m.clone())?;
                    if let Some(member) = members
                        .iter_mut()
                        .find(|member| member.message_id == edited.message_id)
                    {
                        *member = edited;
                    }
                    value = json!({"kind":"message","message":InboundMessage::album(&members),"albumMessages":members});
                    tx.execute(
                        "UPDATE telegram_inbox SET payload_json=? WHERE id=?",
                        params![value.to_string(), id],
                    )?;
                    tx.execute("UPDATE telegram_inbox SET status='discarded',payload_json=NULL,updated_at=? WHERE id=?", params![now(),album["id"].as_i64()])?;
                }
                tx.execute("UPDATE telegram_inbox SET status='discarded',payload_json=NULL,updated_at=? WHERE bot_id=? AND id<>? AND status='received' AND json_extract(payload_json,'$.kind')='message' AND json_extract(payload_json,'$.message.route.chatId')=? AND json_extract(payload_json,'$.message.messageId')=?",params![now(),bot,id,m["route"]["chatId"].as_str(),m["messageId"].as_str()])?;
            }
        }
        tx.execute("INSERT INTO telegram_poll_state VALUES (?,?,?) ON CONFLICT(bot_id) DO UPDATE SET next_offset=max(next_offset,excluded.next_offset),updated_at=excluded.updated_at",params![bot,update+1,now()])?;
        tx.commit()?;
        Ok(id)
    }
    /// A new controller must never expose a capability left active by a killed process.
    pub fn revoke_active_contexts(&self, bot: &str) -> Result<usize> {
        Ok(self.connection()?.execute(
            "UPDATE context_capabilities SET active=0 WHERE bot_id=? AND active=1",
            [bot],
        )?)
    }
    pub fn recover_inbox(&self) -> Result<(Vec<InboxRow>, usize)> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        tx.execute("UPDATE telegram_inbox SET status='done',payload_json=NULL,error=NULL,updated_at=? WHERE status IN ('dispatching','running') AND EXISTS(SELECT 1 FROM telegram_outbox WHERE telegram_outbox.inbox_id=telegram_inbox.id AND status='sent')",[now()])?;
        let count=tx.execute("UPDATE telegram_inbox SET status='interrupted',error='process stopped during an accepted turn',updated_at=? WHERE status IN ('dispatching','running')",[now()])?;
        let result = rows(
            &tx,
            "SELECT * FROM telegram_inbox WHERE status='received' ORDER BY id",
            [],
        )?
        .into_iter()
        .map(serde_json::from_value)
        .collect::<std::result::Result<Vec<_>, _>>()?;
        tx.commit()?;
        Ok((result, count))
    }
    pub fn inbox(&self, id: i64) -> Result<Option<InboxRow>> {
        one(
            &*self.connection()?,
            "SELECT * FROM telegram_inbox WHERE id=?",
            [id],
        )?
        .map(serde_json::from_value)
        .transpose()
        .context("Read inbox")
    }
    pub fn claim_inbox(&self, id: i64) -> Result<bool> {
        Ok(self.connection()?.execute("UPDATE telegram_inbox SET status='dispatching',attempts=attempts+1,updated_at=? WHERE id=? AND status='received'",params![now(),id])?==1)
    }
    pub fn mark_inbox(&self, id: i64, status: &str, error: Option<&str>) -> Result<()> {
        self.connection()?.execute("UPDATE telegram_inbox SET status=?,error=?,payload_json=CASE WHEN ? IN ('done','discarded') THEN NULL ELSE payload_json END,updated_at=? WHERE id=?",params![status,error,status,now(),id])?;
        Ok(())
    }
    pub fn requeue_inbox(&self, id: i64, payload: &Value) -> Result<()> {
        if self.connection()?.execute("UPDATE telegram_inbox SET status='received',payload_json=?,updated_at=? WHERE id=? AND status='dispatching'",params![payload.to_string(),now(),id])?!=1{bail!("Could not queue the confirmed action");}
        Ok(())
    }
    pub fn coalesce_inbox(&self, id: i64, payload: &Value, extra: &[i64]) -> Result<()> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        tx.execute("UPDATE telegram_inbox SET payload_json=?,updated_at=? WHERE id=? AND status='received'",params![payload.to_string(),now(),id])?;
        for id in extra {
            tx.execute("UPDATE telegram_inbox SET status='done',payload_json=NULL,updated_at=? WHERE id=? AND status='received'",params![now(),id])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn discard_queued(&self, route: &str, except: Option<i64>) -> Result<usize> {
        Ok(self.connection()?.execute("UPDATE telegram_inbox SET status='discarded',payload_json=NULL,updated_at=? WHERE route_key=? AND status IN ('received','interrupted','failed') AND (? IS NULL OR id<>?)",params![now(),route,except,except])?)
    }
    pub fn ensure_route(&self, route: &Route) -> Result<RouteRow> {
        self.connection()?.execute("INSERT INTO routes(route_key,bot_id,chat_id,topic_id,chat_kind,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(route_key) DO UPDATE SET chat_kind=excluded.chat_kind,updated_at=excluded.updated_at",params![route.key,route.bot_id,route.chat_id,route.topic_id,route.chat_kind,now()])?;
        self.route(&route.key)?.context("Route missing")
    }
    pub fn route(&self, key: &str) -> Result<Option<RouteRow>> {
        one(
            &*self.connection()?,
            "SELECT * FROM routes WHERE route_key=?",
            [key],
        )?
        .map(serde_json::from_value)
        .transpose()
        .context("Read route")
    }
    pub fn routes(&self) -> Result<Vec<RouteRow>> {
        self.query("SELECT * FROM routes ORDER BY updated_at DESC", [])?
            .into_iter()
            .map(|v| serde_json::from_value(v).map_err(Into::into))
            .collect()
    }
    pub fn set_route_session(&self, key: &str, id: &str, replaced: bool) -> Result<()> {
        self.connection()?.execute(
            "DELETE FROM context_usage WHERE route_key=? AND (session_id<>? OR ?)",
            params![key, id, replaced],
        )?;
        self.connection()?.execute(
            "UPDATE routes SET session_id=?,generation=generation+?,updated_at=? WHERE route_key=?",
            params![id, i64::from(replaced), now(), key],
        )?;
        if replaced {
            self.expire_route_capabilities(key)?;
        }
        Ok(())
    }
    pub fn reset_route(&self, key: &str) -> Result<()> {
        self.clear_context_usage(key)?;
        self.connection()?.execute("UPDATE routes SET session_id=NULL,generation=generation+1,updated_at=? WHERE route_key=?",params![now(),key])?;
        self.expire_route_capabilities(key)
    }
    pub fn save_context_usage(
        &self,
        key: &str,
        session: &str,
        model: &str,
        usage: crate::fx::usage::ContextUsage,
    ) -> Result<()> {
        if usage.size == 0 {
            return Ok(());
        }
        let (Ok(used), Ok(size)) = (i64::try_from(usage.used), i64::try_from(usage.size)) else {
            return Ok(());
        };
        self.connection()?.execute(
            "INSERT INTO context_usage(route_key,session_id,model,used,size) SELECT route_key,?,?,?,? FROM routes WHERE route_key=? AND session_id=? ON CONFLICT(route_key) DO UPDATE SET session_id=excluded.session_id,model=excluded.model,used=excluded.used,size=excluded.size",
            params![session, model, used, size, key, session],
        )?;
        Ok(())
    }
    pub fn context_usage(
        &self,
        key: &str,
        session: &str,
        model: &str,
    ) -> Result<Option<crate::fx::usage::ContextUsage>> {
        Ok(self.connection()?.query_row(
            "SELECT used,size FROM context_usage WHERE route_key=? AND session_id=? AND model=?",
            params![key, session, model],
            |r| Ok(crate::fx::usage::ContextUsage { used: r.get::<_, i64>(0)? as u64, size: r.get::<_, i64>(1)? as u64 }),
        ).optional()?)
    }
    pub fn clear_context_usage(&self, key: &str) -> Result<()> {
        self.connection()?
            .execute("DELETE FROM context_usage WHERE route_key=?", [key])?;
        Ok(())
    }
    pub fn expire_route_capabilities(&self, key: &str) -> Result<()> {
        let db = self.connection()?;
        db.execute(
            "UPDATE context_capabilities SET active=0,expires_at=? WHERE route_key=?",
            params![now(), key],
        )?;
        for table in ["telegram_messages", "telegram_principals"] {
            db.execute(
                &format!("UPDATE {table} SET expires_at=? WHERE route_key=?"),
                params![now(), key],
            )?;
        }
        db.execute("UPDATE telegram_interactions SET state='expired',updated_at=? WHERE route_key=? AND state='pending'",params![now(),key])?;
        Ok(())
    }
    pub fn register_inbound(&self, message: &mut InboundMessage, activate: bool) -> Result<()> {
        let db = self.connection()?;
        let exp = expires(1);
        let id = message.sender.id.as_deref().unwrap_or("unknown");
        if let Some(v) = one(
            &db,
            "SELECT ref FROM telegram_principals WHERE bot_id=? AND route_key=? AND principal_kind=? AND telegram_id=? AND expires_at>?",
            params![
                message.route.bot_id,
                message.route.key,
                message.sender.kind,
                id,
                now()
            ],
        )? {
            message.sender.reference = v["ref"].as_str().unwrap().into();
        }
        db.execute("INSERT INTO telegram_principals VALUES (?,?,?,?,?,?,?) ON CONFLICT(bot_id,route_key,principal_kind,telegram_id) DO UPDATE SET ref=CASE WHEN telegram_principals.expires_at<=? THEN excluded.ref ELSE telegram_principals.ref END,display_name=excluded.display_name,expires_at=excluded.expires_at",params![message.sender.reference,message.route.bot_id,message.route.key,message.sender.kind,id,message.sender.display_name,exp,now()])?;
        db.execute("INSERT INTO telegram_messages(ref,bot_id,route_key,chat_id,topic_id,message_id,sender_ref,owned_by_bot,excerpt,created_at,expires_at) VALUES (?,?,?,?,?,?,?,0,?,?,?) ON CONFLICT(bot_id,chat_id,message_id) DO UPDATE SET ref=excluded.ref,sender_ref=excluded.sender_ref,excerpt=coalesce(excluded.excerpt,telegram_messages.excerpt),expires_at=excluded.expires_at",params![message.message_ref,message.route.bot_id,message.route.key,message.route.chat_id,message.route.topic_id,message.message_id,message.sender.reference,message_excerpt(message.text.as_deref()),now(),exp])?;
        let raw = message
            .raw
            .get("message")
            .or_else(|| message.raw.get("edited_message"));
        if let (Some(reply), Some(raw)) =
            (&message.reply, raw.and_then(|m| m.get("reply_to_message")))
        {
            db.execute("INSERT INTO telegram_messages(ref,bot_id,route_key,chat_id,topic_id,message_id,owned_by_bot,excerpt,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bot_id,chat_id,message_id) DO UPDATE SET excerpt=coalesce(excluded.excerpt,telegram_messages.excerpt),expires_at=excluded.expires_at",params![reply["message_ref"].as_str(),message.route.bot_id,message.route.key,message.route.chat_id,message.route.topic_id,crate::types::decimal(&raw["message_id"]),i64::from(crate::types::decimal(&raw["from"]["id"]).as_deref()==Some(&message.route.bot_id)),message_excerpt(reply["text_excerpt"].as_str()),now(),exp])?;
        }
        if activate {
            db.execute(
                "UPDATE context_capabilities SET active=0 WHERE route_key=?",
                [&message.route.key],
            )?;
            db.execute(
                "INSERT OR REPLACE INTO context_capabilities VALUES (?,?,?,?,?,?,?,?,?,1,?,?)",
                params![
                    message.context_ref,
                    message.route.bot_id,
                    message.route.key,
                    message.route.chat_id,
                    message.route.topic_id,
                    message.message_ref,
                    message.message_id,
                    message.sender.reference,
                    serde_json::to_string(&message.attachments)?,
                    exp,
                    now()
                ],
            )?;
        }
        Ok(())
    }
    pub fn register_event_context(&self, route: &Route, context: &str) -> Result<()> {
        let db = self.connection()?;
        db.execute(
            "UPDATE context_capabilities SET active=0 WHERE route_key=?",
            [&route.key],
        )?;
        db.execute("INSERT INTO context_capabilities(context_ref,bot_id,route_key,chat_id,topic_id,attachments_json,expires_at,created_at) VALUES (?,?,?,?,?,'[]',?,?)",params![context,route.bot_id,route.key,route.chat_id,route.topic_id,expires(1),now()])?;
        Ok(())
    }
    pub fn active_context(&self, key: &str) -> Result<Option<ContextCapability>> {
        one(&*self.connection()?,"SELECT * FROM context_capabilities WHERE route_key=? AND active=1 AND expires_at>? ORDER BY created_at DESC LIMIT 1",params![key,now()])?.map(serde_json::from_value).transpose().context("Read context")
    }
    pub fn activate_context(&self, key: &str, context: &str) -> Result<bool> {
        let db = self.connection()?;
        if one(&db,"SELECT 1 FROM context_capabilities WHERE route_key=? AND context_ref=? AND expires_at>?",params![key,context,now()])?.is_none(){return Ok(false);}
        db.execute(
            "UPDATE context_capabilities SET active=0 WHERE route_key=?",
            [key],
        )?;
        db.execute(
            "UPDATE context_capabilities SET active=1 WHERE route_key=? AND context_ref=?",
            params![key, context],
        )?;
        Ok(true)
    }
    pub fn deactivate_context(&self, key: &str, context: &str) -> Result<()> {
        self.connection()?.execute(
            "UPDATE context_capabilities SET active=0 WHERE route_key=? AND context_ref=?",
            params![key, context],
        )?;
        Ok(())
    }
    pub fn message_reference(
        &self,
        reference: &str,
        key: &str,
    ) -> Result<Option<MessageReference>> {
        one(
            &*self.connection()?,
            "SELECT * FROM telegram_messages WHERE ref=? AND route_key=? AND expires_at>?",
            params![reference, key, now()],
        )?
        .map(serde_json::from_value)
        .transpose()
        .context("Read reference")
    }
    pub fn managed_message_reference(
        &self,
        reference: &str,
        key: &str,
    ) -> Result<Option<MessageReference>> {
        one(
            &*self.connection()?,
            "SELECT * FROM telegram_messages WHERE ref=? AND route_key=? AND owned_by_bot=1",
            params![reference, key],
        )?
        .map(serde_json::from_value)
        .transpose()
        .context("Read reference")
    }
    pub fn message_reference_by_telegram_id(
        &self,
        bot: &str,
        chat: &str,
        id: &str,
    ) -> Result<Option<MessageReference>> {
        one(&*self.connection()?,"SELECT * FROM telegram_messages WHERE bot_id=? AND chat_id=? AND message_id=? AND expires_at>?",params![bot,chat,id,now()])?.map(serde_json::from_value).transpose().context("Read reference")
    }
    pub fn principal(&self, reference: &str, key: &str) -> Result<Option<Value>> {
        one(
            &*self.connection()?,
            "SELECT telegram_id,principal_kind FROM telegram_principals WHERE ref=? AND route_key=? AND expires_at>?",
            params![reference, key, now()],
        )
    }
    #[allow(clippy::too_many_arguments)]
    pub fn register_principal(
        &self,
        reference: &str,
        bot: &str,
        key: &str,
        kind: &str,
        id: &str,
        name: Option<&str>,
        expires: &str,
    ) -> Result<String> {
        let db = self.connection()?;
        let existing:Option<String>=db.query_row("SELECT ref FROM telegram_principals WHERE bot_id=? AND route_key=? AND principal_kind=? AND telegram_id=? AND expires_at>?",params![bot,key,kind,id,now()],|r|r.get(0)).optional()?;
        let reference = existing.as_deref().unwrap_or(reference);
        db.execute("INSERT INTO telegram_principals VALUES (?,?,?,?,?,?,?) ON CONFLICT(bot_id,route_key,principal_kind,telegram_id) DO UPDATE SET ref=excluded.ref,display_name=excluded.display_name,expires_at=excluded.expires_at",params![reference,bot,key,kind,id,name,expires])?;
        Ok(reference.into())
    }
    pub fn register_bot_message(
        &self,
        route: &Route,
        id: &str,
        text: Option<&str>,
    ) -> Result<String> {
        self.history.record_bot(&route.key, id, text)?;
        let reference = new_ref("msg");
        self.connection()?.execute("INSERT INTO telegram_messages(ref,bot_id,route_key,chat_id,topic_id,message_id,owned_by_bot,excerpt,created_at,expires_at) VALUES (?,?,?,?,?,?,1,?,?,?) ON CONFLICT(bot_id,chat_id,message_id) DO UPDATE SET ref=excluded.ref,excerpt=coalesce(excluded.excerpt,telegram_messages.excerpt),expires_at=excluded.expires_at",params![reference,route.bot_id,route.key,route.chat_id,route.topic_id,id,message_excerpt(text),now(),expires(30)])?;
        Ok(reference)
    }
    pub fn update_message_excerpt(&self, reference: &str, key: &str, text: &str) -> Result<()> {
        if let Some(m) = self.managed_message_reference(reference, key)? {
            self.history.record_bot(key, &m.message_id, Some(text))?;
        }
        self.connection()?.execute(
            "UPDATE telegram_messages SET excerpt=? WHERE ref=? AND route_key=?",
            params![message_excerpt(Some(text)), reference, key],
        )?;
        Ok(())
    }
    pub fn recent_messages(&self, key: &str, limit: i64) -> Result<Vec<Value>> {
        let mut r=self.query("SELECT m.ref,m.sender_ref,p.display_name AS sender_display_name,m.owned_by_bot,m.created_at,m.excerpt FROM telegram_messages m LEFT JOIN telegram_principals p ON p.ref=m.sender_ref AND p.route_key=m.route_key WHERE m.route_key=? AND m.expires_at>? ORDER BY CAST(m.message_id AS INTEGER) DESC LIMIT ?",params![key,now(),limit])?;
        r.reverse();
        Ok(r)
    }
    pub fn create_outbox(
        &self,
        effect: &str,
        route: &Route,
        inbox: Option<i64>,
        kind: &str,
        payload: &Value,
    ) -> Result<i64> {
        let db = self.connection()?;
        db.execute("INSERT INTO telegram_outbox(effect_key,bot_id,route_key,inbox_id,kind,payload_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,?) ON CONFLICT(effect_key) DO NOTHING",params![effect,route.bot_id,route.key,inbox,kind,payload.to_string(),now(),now()])?;
        Ok(db.query_row(
            "SELECT id FROM telegram_outbox WHERE effect_key=?",
            [effect],
            |r| r.get(0),
        )?)
    }
    pub fn recoverable_outbox(&self) -> Result<Vec<OutboxRow>> {
        self.query(
            "SELECT * FROM telegram_outbox WHERE status IN ('pending','sending') ORDER BY id",
            [],
        )?
        .into_iter()
        .map(|v| serde_json::from_value(v).map_err(Into::into))
        .collect()
    }
    pub fn mark_outbox(
        &self,
        id: i64,
        status: &str,
        message: Option<&str>,
        error: Option<&str>,
    ) -> Result<()> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        tx.execute("UPDATE telegram_outbox SET status=?,attempts=CASE WHEN ?='sending' THEN attempts+1 ELSE attempts END,payload_json=CASE WHEN ?='sent' THEN '{}' ELSE payload_json END,telegram_message_id=coalesce(?,telegram_message_id),error=?,updated_at=? WHERE id=?",params![status,status,status,message,error,now(),id])?;
        if status == "sent"
            && let Some(inbox) = tx.query_row(
                "SELECT inbox_id FROM telegram_outbox WHERE id=?",
                [id],
                |r| r.get::<_, Option<i64>>(0),
            )?
        {
            self.history.complete_with(&tx, inbox)?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn begin_effect(
        &self,
        effect: &str,
        bot: &str,
        key: &str,
        tool: &str,
    ) -> Result<&'static str> {
        let db = self.connection()?;
        if let Some(s) = db
            .query_row(
                "SELECT state FROM effect_ledger WHERE effect_key=?",
                [effect],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(if s == "complete" {
                "complete"
            } else {
                "unknown"
            });
        }
        db.execute("INSERT INTO effect_ledger(effect_key,bot_id,route_key,tool_name,state,created_at,updated_at) VALUES (?,?,?,?,'running',?,?)",params![effect,bot,key,tool,now(),now()])?;
        Ok("new")
    }
    pub fn complete_effect(&self, key: &str, result: &Value) -> Result<()> {
        self.connection()?.execute("UPDATE effect_ledger SET state='complete',result_json=?,updated_at=? WHERE effect_key=?",params![result.to_string(),now(),key])?;
        Ok(())
    }
    pub fn effect_result(&self, key: &str) -> Result<Option<Value>> {
        let s: Option<String> = self
            .connection()?
            .query_row(
                "SELECT result_json FROM effect_ledger WHERE effect_key=?",
                [key],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        s.map(|s| serde_json::from_str(&s))
            .transpose()
            .context("Read effect")
    }
    pub fn fail_effect(&self, key: &str, error: &str, unknown: bool) -> Result<()> {
        self.connection()?.execute(
            "UPDATE effect_ledger SET state=?,error=?,updated_at=? WHERE effect_key=?",
            params![
                if unknown { "unknown" } else { "failed" },
                error,
                now(),
                key
            ],
        )?;
        Ok(())
    }
    pub fn create_interaction(
        &self,
        id: &str,
        bot: &str,
        key: &str,
        kind: &str,
        payload: &Value,
        expires: &str,
    ) -> Result<()> {
        self.connection()?.execute("INSERT INTO telegram_interactions(interaction_id,bot_id,route_key,kind,payload_json,state,expires_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?)",params![id,bot,key,kind,payload.to_string(),expires,now()])?;
        Ok(())
    }
    pub fn interaction(&self, id: &str) -> Result<Option<Value>> {
        one(
            &*self.connection()?,
            "SELECT * FROM telegram_interactions WHERE interaction_id=?",
            [id],
        )
    }
    pub fn poll_interaction(&self, id: &str) -> Result<Option<Value>> {
        one(
            &*self.connection()?,
            "SELECT * FROM telegram_interactions WHERE kind='poll' AND json_extract(payload_json,'$.pollId')=? ORDER BY updated_at DESC LIMIT 1",
            [id],
        )
    }
    pub fn resolve_interaction(&self, id: &str, result: &Value) -> Result<bool> {
        Ok(self.connection()?.execute("UPDATE telegram_interactions SET state='resolved',result_json=?,updated_at=? WHERE interaction_id=? AND state='pending' AND expires_at>?",params![result.to_string(),now(),id,now()])?==1)
    }
    pub fn expire_interaction(&self, id: &str) -> Result<bool> {
        Ok(self.connection()?.execute("UPDATE telegram_interactions SET state='expired',updated_at=? WHERE interaction_id=? AND state='pending'",params![now(),id])?==1)
    }
    pub fn expire_interactions(&self, key: &str, kind: &str) -> Result<usize> {
        Ok(self.connection()?.execute("UPDATE telegram_interactions SET state='expired',updated_at=? WHERE route_key=? AND kind=? AND state='pending'",params![now(),key,kind])?)
    }
    pub fn attach_interaction_card(&self, id: &str, card: &Value) -> Result<()> {
        self.connection()?.execute("UPDATE telegram_interactions SET payload_json=json_set(payload_json,'$.card',json(?)),updated_at=? WHERE interaction_id=?",params![card.to_string(),now(),id])?;
        Ok(())
    }
    pub fn update_interaction_payload(&self, id: &str, payload: &Value) -> Result<()> {
        self.connection()?.execute("UPDATE telegram_interactions SET payload_json=?,updated_at=? WHERE interaction_id=? AND state='pending'",params![payload.to_string(),now(),id])?;
        Ok(())
    }
    pub fn pending_approvals(&self, bot: &str) -> Result<Vec<Value>> {
        self.query("SELECT * FROM telegram_interactions WHERE bot_id=? AND state='pending' AND (kind='fx_permission' OR kind LIKE 'telegram_admin:%') ORDER BY updated_at",[bot])
    }
    pub fn pending_join_requests(&self, key: &str) -> Result<Vec<Value>> {
        let list=self.query("SELECT interaction_id,payload_json FROM telegram_interactions WHERE route_key=? AND kind='join_request' AND state='pending' AND expires_at>? ORDER BY updated_at DESC LIMIT 20",params![key,now()])?;
        list.into_iter().map(|v|{let p:Value=serde_json::from_str(v["payload_json"].as_str().unwrap())?;Ok(json!({"request_ref":format!("join_{}",v["interaction_id"].as_str().unwrap()),"member_ref":p["memberRef"],"display_name":p["displayName"],"bio":p["bio"]}))}).collect()
    }
    pub fn migrate_chat(&self, bot: &str, old: &str, new: &str) -> Result<Vec<(String, String)>> {
        if old == new {
            return Ok(vec![]);
        }
        let routes: Vec<_> = self
            .routes()?
            .into_iter()
            .filter(|r| r.bot_id == bot && r.chat_id == old)
            .collect();
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let mut migrated = vec![];
        for r in routes {
            let route = r.as_route();
            let key = if let Some(user) = route.whisper_user() {
                Route::new(bot, new, &r.topic_id, "supergroup")
                    .whisper(user)
                    .key
            } else {
                format!("{bot}:{new}:{}", r.topic_id)
            };
            if one(&tx, "SELECT 1 FROM routes WHERE route_key=?", [&key])?.is_some() {
                bail!("Cannot migrate Telegram route: {key} already exists");
            }
            tx.execute("UPDATE routes SET route_key=?,chat_id=?,chat_kind=?,updated_at=? WHERE route_key=?",params![key,new,if route.whisper_user().is_some() { "whisper" } else { "supergroup" },now(),r.route_key])?;
            for table in [
                "telegram_principals",
                "telegram_inbox",
                "telegram_outbox",
                "telegram_interactions",
                "managed_pins",
                "effect_ledger",
            ] {
                tx.execute(
                    &format!("UPDATE {table} SET route_key=? WHERE route_key=?"),
                    params![key, r.route_key],
                )?;
            }
            for table in ["telegram_messages", "context_capabilities"] {
                tx.execute(
                    &format!("UPDATE {table} SET route_key=?,chat_id=? WHERE route_key=?"),
                    params![key, new, r.route_key],
                )?;
            }
            self.history.migrate_with(&tx, &r.route_key, &key)?;
            migrated.push((r.route_key, key));
        }
        tx.commit()?;
        Ok(migrated)
    }
    pub fn prune(&self) -> Result<()> {
        let db = self.connection()?;
        let retention = expires(-7);
        for (sql, date) in [
            (
                "DELETE FROM telegram_inbox WHERE status IN ('done','discarded') AND updated_at<?",
                &retention,
            ),
            (
                "DELETE FROM telegram_outbox WHERE status IN ('sent','abandoned') AND updated_at<?",
                &retention,
            ),
            (
                "DELETE FROM effect_ledger WHERE state IN ('complete','failed','abandoned') AND updated_at<?",
                &retention,
            ),
        ] {
            db.execute(sql, [date])?;
        }
        for sql in [
            "DELETE FROM context_capabilities WHERE expires_at<?",
            "DELETE FROM telegram_messages WHERE expires_at<? AND ref NOT IN(SELECT message_ref FROM managed_pins)",
            "DELETE FROM telegram_principals WHERE expires_at<?",
            "DELETE FROM telegram_interactions WHERE expires_at<?",
        ] {
            db.execute(sql, [now()])?;
        }
        Ok(())
    }
}
#[cfg(unix)]
pub fn private_mode(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
    Ok(())
}
#[cfg(not(unix))]
pub fn private_mode(_: &Path, _: u32) -> Result<()> {
    Ok(())
}
