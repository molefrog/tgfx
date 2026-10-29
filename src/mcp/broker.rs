use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    process::Command,
};
use tokio_util::sync::CancellationToken;
/// Optional bounded lifecycle trace. Never records capabilities, tokens or payloads.
pub(crate) fn trace(event: &str) {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let Ok(path) = std::env::var("TGFX_MCP_TRACE_FILE") else {
        return;
    };
    let Ok(mut file) = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    else {
        return;
    };
    if file.metadata().is_ok_and(|m| m.len() < 1024 * 1024) {
        let safe = crate::secrets::redact(event);
        let safe = regex::Regex::new(r"[A-Fa-f0-9]{64}")
            .unwrap()
            .replace_all(&safe, "[redacted capability]");
        let safe = regex::Regex::new(r#""[^"]*""#)
            .unwrap()
            .replace_all(&safe, "[quoted value]");
        let safe = safe.chars().take(512).collect::<String>();
        let _ = writeln!(
            file,
            "{} pid={} {}",
            crate::types::now(),
            std::process::id(),
            safe
        );
    }
}
#[derive(Clone)]
struct Lease {
    env: HashMap<String, String>,
    stop: CancellationToken,
}
#[derive(Clone)]
pub struct TelegramMcpBroker {
    pub path: PathBuf,
    launch: Vec<String>,
    leases: Arc<Mutex<HashMap<String, Lease>>>,
    stop: CancellationToken,
}
pub struct McpLease {
    pub launch: Value,
    capability: String,
    leases: Arc<Mutex<HashMap<String, Lease>>>,
}
impl McpLease {
    pub fn descriptor(&self) -> Value {
        self.launch.clone()
    }
    pub async fn revoke(&self) {
        if let Some(lease) = self.leases.lock().unwrap().remove(&self.capability) {
            lease.stop.cancel()
        }
    }
}
impl Drop for McpLease {
    fn drop(&mut self) {
        if let Some(lease) = self.leases.lock().unwrap().remove(&self.capability) {
            lease.stop.cancel()
        }
    }
}
impl TelegramMcpBroker {
    pub async fn listen(directory: &Path, launch: Vec<String>) -> Result<Self> {
        use std::os::unix::fs::PermissionsExt;
        if launch.is_empty() {
            bail!("MCP launch command is empty")
        }
        if !directory.exists() {
            std::fs::create_dir_all(directory)?;
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o750))?
        }
        if std::fs::symlink_metadata(directory)?
            .file_type()
            .is_symlink()
            || !directory.is_dir()
        {
            bail!("MCP socket directory must be a real directory")
        }
        let path = directory.join(format!("mcp-{}.sock", uuid::Uuid::new_v4().simple()));
        let listener = UnixListener::bind(&path)?;
        if let Err(error) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660))
        {
            drop(listener);
            let _ = std::fs::remove_file(&path);
            return Err(error.into());
        }
        trace("broker.listen");
        let broker = Self {
            path,
            launch,
            leases: Arc::new(Mutex::new(HashMap::new())),
            stop: CancellationToken::new(),
        };
        let serve = broker.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {_=serve.stop.cancelled()=>break,accepted=listener.accept()=>{match accepted{Ok((socket,_))=>{let server=serve.clone();tokio::spawn(async move{if let Err(e)=server.accept(socket).await{tracing::debug!(error=%e,"MCP broker connection closed")}});},Err(e)=>{tracing::warn!(error=%e,"MCP broker accept failed");break}}}}
            }
        });
        Ok(broker)
    }
    pub fn lease(&self, env: HashMap<String, String>) -> Result<McpLease> {
        if self.stop.is_cancelled() {
            bail!("MCP broker is closed")
        }
        let capability = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.leases.lock().unwrap().insert(
            capability.clone(),
            Lease {
                env,
                stop: CancellationToken::new(),
            },
        );
        let mut args = self.launch[1..].to_vec();
        if args.last().is_some_and(|s| s == "mcp") {
            args.pop();
        }
        args.push("mcp-proxy".into());
        let mut environment = vec![
            json!({"name":"TGFX_MCP_SOCKET","value":self.path}),
            json!({"name":"TGFX_MCP_CAPABILITY","value":capability}),
        ];
        if let Ok(path) = std::env::var("TGFX_MCP_TRACE_FILE") {
            environment.push(json!({"name":"TGFX_MCP_TRACE_FILE","value":path}))
        }
        trace("broker.lease.created");
        Ok(McpLease {
            launch: json!({"type":"stdio","name":"telegram","command":self.launch[0],"args":args,"env":environment}),
            capability,
            leases: self.leases.clone(),
        })
    }
    async fn accept(&self, socket: UnixStream) -> Result<()> {
        trace("broker.accept");
        let mut socket = BufReader::new(socket);
        let mut auth = vec![];
        let n = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            tokio::io::AsyncReadExt::take(&mut socket, 1025).read_until(b'\n', &mut auth),
        )
        .await??;
        if n > 1024 || n == 0 {
            bail!("Invalid MCP capability header")
        }
        let value: Value = serde_json::from_slice(&auth)?;
        if value.as_object().is_none_or(|o| o.len() != 1) {
            bail!("Invalid MCP capability header")
        }
        let lease = self
            .leases
            .lock()
            .unwrap()
            .get(value["capability"].as_str().unwrap_or(""))
            .cloned()
            .context("Unknown MCP capability")?;
        trace("broker.authenticated");
        let mut child = Command::new(&self.launch[0])
            .args(&self.launch[1..])
            .envs(&lease.env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()?;
        trace(&format!(
            "broker.child.spawned pid={}",
            child.id().unwrap_or(0)
        ));
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (socketread, mut socketwrite) = tokio::io::split(socket);
        tokio::pin!(socketread);
        tokio::select! {_=self.stop.cancelled()=>trace("broker.stop"),_=lease.stop.cancelled()=>trace("broker.lease.revoked"),result=tokio::io::copy(&mut socketread,&mut stdin)=>trace(&format!("broker.input.closed bytes={}",result.unwrap_or(0))),result=tokio::io::copy(&mut stdout,&mut socketwrite)=>trace(&format!("broker.output.closed bytes={}",result.unwrap_or(0))),result=child.wait()=>trace(&format!("broker.child.exit code={:?}",result.ok().and_then(|s|s.code()))) }
        drop(stdin);
        // Closing stdin lets the MCP handler drop its private temporary files.
        if tokio::time::timeout(std::time::Duration::from_secs(1), child.wait())
            .await
            .is_err()
        {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        Ok(())
    }
    pub async fn close(&self) -> Result<()> {
        self.stop.cancel();
        for (_, l) in self.leases.lock().unwrap().drain() {
            l.stop.cancel()
        }
        match tokio::fs::remove_file(&self.path).await {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}
pub async fn proxy() -> Result<()> {
    trace("proxy.start");
    let path = std::env::var("TGFX_MCP_SOCKET").context("Missing MCP socket")?;
    let capability = std::env::var("TGFX_MCP_CAPABILITY").context("Missing MCP capability")?;
    let mut socket = UnixStream::connect(path).await?;
    trace("proxy.connected");
    socket
        .write_all(format!("{}\n", json!({"capability":capability})).as_bytes())
        .await?;
    trace("proxy.auth.sent");
    let (mut read, mut write) = socket.into_split();
    // Tokio's stdin uses an uncancelable blocking-pool read. FX can keep stdin
    // open after revoking the socket; that read would prevent runtime shutdown.
    // A dedicated reader thread is not joined during process exit, and the
    // bounded channel applies backpressure while the MCP connection is alive.
    let (chunks, mut receiver) = tokio::sync::mpsc::channel::<std::io::Result<Vec<u8>>>(4);
    std::thread::spawn(move || {
        use std::io::Read;
        let input = std::io::stdin();
        let mut input = input.lock();
        loop {
            let mut bytes = vec![0u8; 16 * 1024];
            match input.read(&mut bytes) {
                Ok(0) => break,
                Ok(n) => {
                    bytes.truncate(n);
                    if chunks.blocking_send(Ok(bytes)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = chunks.blocking_send(Err(error));
                    break;
                }
            }
        }
    });
    let mut stdout = tokio::io::stdout();
    let input = async {
        while let Some(bytes) = receiver.recv().await {
            write.write_all(&bytes?).await?;
        }
        write.shutdown().await?;
        Ok::<(), std::io::Error>(())
    };
    tokio::select! {r=input=>{trace("proxy.input.closed");r?;},r=tokio::io::copy(&mut read,&mut stdout)=>{trace(&format!("proxy.output.closed bytes={}",r.as_ref().copied().unwrap_or(0)));r?;}}
    stdout.flush().await?;
    trace("proxy.return");
    Ok(())
}
