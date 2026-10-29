use crate::state::private_mode;
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
pub const MAX_EVENT_REQUEST: usize = 300 * 1024;
pub fn events_socket_path(database: &Path) -> PathBuf {
    if let Some(p) = std::env::var_os("TGFX_EVENTS_SOCKET") {
        return PathBuf::from(p);
    }
    database.with_extension("events.sock")
}
pub struct EventSocket {
    path: PathBuf,
    stop: CancellationToken,
    task: JoinHandle<()>,
}
impl EventSocket {
    pub async fn close(self) -> Result<()> {
        self.stop.cancel();
        self.task.await?;
        let _ = std::fs::remove_file(self.path);
        Ok(())
    }
}
pub async fn listen_events<F, Fut>(path: &Path, handle: F) -> Result<EventSocket>
where
    F: Fn(Value) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Value>> + Send + 'static,
{
    use std::os::unix::fs::FileTypeExt;
    let parent = path.parent().context("Socket parent missing")?;
    if !parent.exists() {
        std::fs::create_dir_all(parent)?;
        private_mode(parent, 0o700)?;
    }
    ensure!(
        std::fs::symlink_metadata(parent)?.is_dir(),
        "Event socket parent is not a directory"
    );
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        ensure!(
            meta.file_type().is_socket(),
            "Event socket path is not a socket"
        );
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    private_mode(
        path,
        if std::env::var_os("TGFX_EVENTS_SOCKET").is_some() {
            0o660
        } else {
            0o600
        },
    )?;
    let stop = CancellationToken::new();
    let stop_task = stop.clone();
    let handle = Arc::new(handle);
    let task = tokio::spawn(async move {
        let mut clients = tokio::task::JoinSet::new();
        loop {
            tokio::select! {_=stop_task.cancelled()=>break,accepted=listener.accept()=>{match accepted{Ok((socket,_))=>{let handle=handle.clone();clients.spawn(async move{let _=tokio::time::timeout(std::time::Duration::from_secs(30),async{let(read,mut write)=socket.into_split();let mut reader=BufReader::new(read);let mut data=Vec::new();loop{let available=reader.fill_buf().await?;if available.is_empty(){return Ok::<(),anyhow::Error>(());}let len=available.iter().position(|b|*b==b'\n').map(|n|n+1).unwrap_or(available.len());if data.len()+len>MAX_EVENT_REQUEST{return Ok(());}let complete=available[len-1]==b'\n';data.extend_from_slice(&available[..len]);reader.consume(len);if complete{break;}}let response=match serde_json::from_slice(&data){Ok(v)=>match handle(v).await{Ok(v)=>json!({"ok":true,"value":v}),Err(e)=>json!({"ok":false,"error":e.to_string()})},Err(e)=>json!({"ok":false,"error":e.to_string()})};write.write_all(format!("{response}\n").as_bytes()).await?;write.shutdown().await?;Ok(())}).await;});},Err(_)=>break}},Some(_)=clients.join_next(),if !clients.is_empty()=>{}}
        }
        clients.abort_all();
        while clients.join_next().await.is_some() {}
    });
    Ok(EventSocket {
        path: path.into(),
        stop,
        task,
    })
}
pub async fn event_request(path: &Path, request: &Value) -> Result<Value> {
    let bytes = format!("{request}\n");
    ensure!(
        bytes.len() <= MAX_EVENT_REQUEST,
        "Event request exceeds 300 KiB"
    );
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let mut stream = UnixStream::connect(path).await?;
        stream.write_all(bytes.as_bytes()).await?;
        let mut reader = BufReader::new(stream);
        let mut response = String::new();
        loop {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                break;
            }
            ensure!(
                response.len() + available.len() <= 2 * 1024 * 1024,
                "Event response is too large"
            );
            let len = available.len();
            response.push_str(std::str::from_utf8(available)?);
            reader.consume(len);
        }
        let v: Value = serde_json::from_str(&response)?;
        if v["ok"] != true {
            bail!("{}", v["error"].as_str().unwrap_or("Event failed"));
        }
        Ok(v["value"].clone())
    })
    .await
    .context("TGFX event request timed out")?
}
pub fn discover_events_socket(workspace: &Path) -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("TGFX_EVENTS_SOCKET") {
        return Ok(p.into());
    }
    let config =
        crate::config::load(workspace)?.context("No TGFX configuration for this folder")?;
    let paths = crate::config::workspace_paths(&config.active_bot_id, workspace)?;
    let info: Value = serde_json::from_slice(&std::fs::read(&paths.lock_info)?)?;
    ensure!(
        info["workspace"].as_str() == Some(paths.workspace.to_string_lossy().as_ref()),
        "TGFX is running in a different workspace"
    );
    Ok(events_socket_path(&paths.database))
}
