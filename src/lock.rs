use crate::state::private_mode;
use anyhow::{Context, Result, bail};
use rusqlite::Connection;
use serde_json::json;
use std::path::{Path, PathBuf};
pub struct RuntimeLock {
    db: Option<Connection>,
    info: PathBuf,
}
impl RuntimeLock {
    pub fn acquire(bot: &str, workspace: &Path) -> Result<Self> {
        let paths = crate::config::workspace_paths(bot, workspace)?;
        Self::acquire_paths(bot, workspace, &paths.lock, &paths.lock_info)
    }
    pub fn acquire_paths(bot: &str, workspace: &Path, lock: &Path, info: &Path) -> Result<Self> {
        let parent = lock.parent().context("Lock parent missing")?;
        std::fs::create_dir_all(parent)?;
        private_mode(parent, 0o700)?;
        let db = Connection::open(lock)?;
        let result=db.execute_batch(&format!("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS holder(id INTEGER PRIMARY KEY,pid INTEGER); INSERT OR REPLACE INTO holder VALUES(1,{});",std::process::id()));
        if let Err(e) = result {
            let busy = matches!(&e,rusqlite::Error::SqliteFailure(error,_)if matches!(error.code,rusqlite::ErrorCode::DatabaseBusy|rusqlite::ErrorCode::DatabaseLocked));
            if !busy {
                return Err(e.into());
            }
            let hint = std::fs::read(info)
                .ok()
                .and_then(|s| serde_json::from_slice::<serde_json::Value>(&s).ok());
            bail!(
                "tgfx is already running for bot {bot}{}",
                hint.map(|v| format!(
                    " (pid {} · {})",
                    v["pid"],
                    v["workspace"].as_str().unwrap_or("")
                ))
                .unwrap_or_default()
            );
        }
        private_mode(lock, 0o600)?;
        let events_socket = crate::config::absolute(&crate::event_socket::events_socket_path(
            &lock.with_extension("db"),
        ))?;
        let data = json!({"pid":std::process::id(),"botId":bot,"workspace":workspace,"startedAt":crate::types::now(),"eventsSocket":events_socket});
        std::fs::write(info, format!("{data}\n"))?;
        private_mode(info, 0o600)?;
        Ok(Self {
            db: Some(db),
            info: info.into(),
        })
    }
    pub fn release(&mut self) {
        if self.db.is_some() {
            // Remove diagnostics while still holding the kernel lock. A later
            // holder may write its sidecar immediately after this connection drops.
            let _ = std::fs::remove_file(&self.info);
            self.db.take();
        }
    }
}
impl Drop for RuntimeLock {
    fn drop(&mut self) {
        self.release();
    }
}
