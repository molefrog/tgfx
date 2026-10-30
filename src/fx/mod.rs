//! FX's official ACP client with one process and memory cursor per Telegram route.
pub mod preflight;
pub mod projector;
pub mod tools;
pub mod usage;
use crate::memory::{MemoryOptions, SessionMemory};
use agent_client_protocol::schema::{ProtocolVersion, v1::*};
use agent_client_protocol::{self as acp, Agent, ConnectionTo};
use anyhow::{Context, Result, bail};
pub use projector::Projector;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex, RwLock, Weak,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
#[derive(Clone, Debug)]
pub struct FxOptions {
    pub binary: String,
    pub cwd: PathBuf,
    pub saved_session: Option<String>,
    pub model: Option<String>,
    pub permission_mode: String,
    pub mcp_servers: Vec<Value>,
    pub system_prompt: Option<String>,
    pub memory: MemoryOptions,
}
#[derive(Debug)]
pub enum FxEvent {
    Update(Value),
    Permission {
        request: Value,
        respond: oneshot::Sender<Value>,
    },
}
#[derive(Clone)]
pub struct FxSession {
    inner: Arc<Inner>,
}
struct Inner {
    id: RwLock<String>,
    config: RwLock<Vec<Value>>,
    usage: RwLock<Option<usage::ContextUsage>>,
    agent: RwLock<Value>,
    replaced: AtomicBool,
    connection: RwLock<Option<ConnectionTo<Agent>>>,
    error: RwLock<Option<String>>,
    events: Mutex<Option<mpsc::UnboundedSender<FxEvent>>>,
    memory: Mutex<SessionMemory>,
    active: AtomicBool,
    generation: AtomicU64,
    steering: AtomicUsize,
    steering_done: tokio::sync::Notify,
    prompt: tokio::sync::Mutex<()>,
    shutdown: CancellationToken,
    permission_cancel: Mutex<CancellationToken>,
    task: Mutex<Option<JoinHandle<()>>>,
    pid: Mutex<Option<u32>>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.shutdown.cancel();
        if let Some(task) = self.task.get_mut().unwrap().take() {
            task.abort();
        }
        kill_group(*self.pid.get_mut().unwrap(), libc::SIGKILL);
    }
}
fn kill_group(pid: Option<u32>, signal: i32) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as i32), signal);
        }
    }
    #[cfg(not(unix))]
    let _ = (pid, signal);
}
pub fn decode<T: DeserializeOwned>(v: Value) -> acp::Result<T> {
    serde_json::from_value(v).map_err(|e| acp::Error::invalid_params().data(e.to_string()))
}
fn wire<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).expect("ACP values are serializable")
}
pub fn rejected_permission(request: &Value) -> Value {
    let option = request["options"].as_array().and_then(|options| {
        options
            .iter()
            .find(|o| o["kind"] == "reject_once")
            .or_else(|| options.iter().find(|o| o["kind"] == "reject_always"))
    });
    match option {
        Some(o) => json!({"outcome":{"outcome":"selected","optionId":o["optionId"]}}),
        None => json!({"outcome":{"outcome":"cancelled"}}),
    }
}
fn valid_permission(request: &Value, response: Value) -> Value {
    let outcome = &response["outcome"];
    if outcome["outcome"] == "cancelled" {
        return response;
    }
    if outcome["outcome"] == "selected"
        && request["options"]
            .as_array()
            .is_some_and(|a| a.iter().any(|o| o["optionId"] == outcome["optionId"]))
    {
        response
    } else {
        rejected_permission(request)
    }
}
fn model_id(options: &[Value]) -> Option<&str> {
    options.iter().find(|v| v["id"] == "model")?["currentValue"].as_str()
}
fn capture_update(inner: &Weak<Inner>, notification: Value) {
    if let Some(i) = inner.upgrade() {
        let update = notification.get("update").unwrap_or(&notification);
        if let Some(usage) = usage::ContextUsage::from_update(update) {
            *i.usage.write().unwrap() = Some(usage);
        }
        if update["sessionUpdate"] == "config_option_update"
            && let Some(a) = update["configOptions"].as_array()
        {
            if model_id(&i.config.read().unwrap()) != model_id(a) {
                *i.usage.write().unwrap() = None;
            }
            *i.config.write().unwrap() = a.clone();
        }
        if let Some(tx) = i.events.lock().unwrap().as_ref() {
            let _ = tx.send(FxEvent::Update(notification));
        }
    }
}
impl FxSession {
    pub async fn start(options: FxOptions) -> Result<Self> {
        if !matches!(options.permission_mode.as_str(), "auto" | "yolo" | "ask") {
            bail!("Unknown FX permission mode")
        }
        let inner = Arc::new(Inner {
            id: RwLock::new(String::new()),
            config: RwLock::new(vec![]),
            usage: RwLock::new(None),
            agent: RwLock::new(Value::Null),
            replaced: AtomicBool::new(false),
            connection: RwLock::new(None),
            error: RwLock::new(None),
            events: Mutex::new(None),
            memory: Mutex::new(SessionMemory::new(&options.cwd, options.memory.clone())?),
            active: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            steering: AtomicUsize::new(0),
            steering_done: tokio::sync::Notify::new(),
            prompt: tokio::sync::Mutex::new(()),
            shutdown: CancellationToken::new(),
            permission_cancel: Mutex::new(CancellationToken::new()),
            task: Mutex::new(None),
            pid: Mutex::new(None),
        });
        let (ready_tx, ready_rx) = oneshot::channel::<std::result::Result<(), String>>();
        let weak = Arc::downgrade(&inner);
        let shutdown = inner.shutdown.clone();
        let task = tokio::spawn(async move {
            let mut ready = Some(ready_tx);
            let result = Self::connect(weak.clone(), options, shutdown, &mut ready).await;
            if let Err(error) = result {
                let error = crate::secrets::redact(&format!("{error:#}"));
                if let Some(i) = weak.upgrade() {
                    *i.error.write().unwrap() = Some(error.clone());
                    i.permission_cancel.lock().unwrap().cancel();
                }
                if let Some(tx) = ready.take() {
                    let _ = tx.send(Err(error));
                }
            }
        });
        *inner.task.lock().unwrap() = Some(task);
        let session = Self { inner };
        match tokio::time::timeout(Duration::from_secs(30), ready_rx).await {
            Ok(Ok(Ok(()))) => Ok(session),
            Ok(Ok(Err(e))) => {
                session.close().await?;
                bail!("{e}")
            }
            Ok(Err(_)) => {
                session.close().await?;
                bail!("FX connection closed during initialization")
            }
            Err(_) => {
                session.close().await?;
                bail!("FX ACP did not initialize within 30 seconds")
            }
        }
    }
    async fn connect(
        weak: Weak<Inner>,
        options: FxOptions,
        shutdown: CancellationToken,
        ready: &mut Option<oneshot::Sender<std::result::Result<(), String>>>,
    ) -> Result<()> {
        let mut command = tokio::process::Command::new(&options.binary);
        command.arg("acp");
        if let Some(model) = &options.model {
            command.args(["--model", model]);
        }
        command
            .current_dir(&options.cwd)
            .env_clear()
            .envs(preflight::sanitize_environment())
            .env("FX_PERMISSION_MODE", &options.permission_mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .with_context(|| format!("Cannot start FX {}", options.binary))?;
        let pid = child.id();
        if let Some(i) = weak.upgrade() {
            *i.pid.lock().unwrap() = pid;
        }
        struct Group(Option<u32>);
        impl Drop for Group {
            fn drop(&mut self) {
                kill_group(self.0, libc::SIGKILL)
            }
        }
        let _group = Group(pid);
        let stdout = child.stdout.take().context("FX stdout missing")?;
        let stdin = child.stdin.take().context("FX stdin missing")?;
        let stderr = child.stderr.take().context("FX stderr missing")?;
        let tail = Arc::new(Mutex::new(String::new()));
        let captured = tail.clone();
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut s = captured.lock().unwrap();
                s.push_str(&line);
                s.push('\n');
                if s.len() > 16384 {
                    let at = s
                        .char_indices()
                        .find(|(at, _)| *at >= s.len() - 16384)
                        .map(|x| x.0)
                        .unwrap_or(0);
                    s.drain(..at);
                }
            }
        });
        struct TaskGuard(JoinHandle<()>);
        impl Drop for TaskGuard {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let _stderr = TaskGuard(stderr_task);
        let outgoing = futures::sink::unfold(stdin, |mut stdin, line: String| async move {
            stdin.write_all(line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await?;
            Ok::<_, std::io::Error>(stdin)
        });
        let capture = weak.clone();
        let incoming = futures::stream::unfold(BufReader::new(stdout).lines(), move |mut lines| {
            let capture = capture.clone();
            async move {
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            // Capture the original envelope before typed deserialization to retain future FX metadata.
                            if let Ok(value) = serde_json::from_str::<Value>(&line)
                                && value["method"] == "session/update"
                            {
                                capture_update(&capture, value["params"].clone());
                                if decode::<SessionNotification>(value["params"].clone()).is_err() {
                                    continue;
                                }
                            }
                            return Some((Ok(line), lines));
                        }
                        Ok(None) => return None,
                        Err(e) => return Some((Err(e), lines)),
                    }
                }
            }
        });
        let permissions = weak.clone();
        let permission_shutdown = shutdown.clone();
        let connect_weak = weak.clone();
        let close_gate = shutdown.clone();
        let protocol=acp::Client.builder()
   .on_receive_notification(async |_:SessionNotification,_|Ok(()),acp::on_receive_notification!())
   .on_receive_request(async move|request:RequestPermissionRequest,responder,cx|{
    let permissions=permissions.clone();let shutdown=permission_shutdown.clone();
    // Never wait inside ordered dispatch: permission UI, cancel and steering must keep flowing.
    cx.spawn(async move{let request=wire(&request);let rejected=rejected_permission(&request);let (tx,rx)=oneshot::channel();let pending=permissions.upgrade().and_then(|i|{let cancellation=i.permission_cancel.lock().unwrap().clone();let sent=i.events.lock().unwrap().as_ref().is_some_and(|events|events.send(FxEvent::Permission{request:request.clone(),respond:tx}).is_ok());sent.then_some(cancellation)});let answer=if let Some(cancel)=pending{
      let answer=tokio::select!{value=rx=>valid_permission(&request,value.unwrap_or(rejected.clone())),_=cancel.cancelled()=>rejected.clone(),_=shutdown.cancelled()=>rejected.clone()};
      if cancel.is_cancelled()||shutdown.is_cancelled(){rejected}else{answer}
    }else{rejected};responder.respond(decode::<RequestPermissionResponse>(answer)?)})?;Ok(())
   },acp::on_receive_request!())
   .connect_with(acp::Lines::new(Box::pin(outgoing),Box::pin(incoming)),move|cx:ConnectionTo<Agent>|async move{
    let init=cx.send_request(decode::<InitializeRequest>(json!({"protocolVersion":ProtocolVersion::V1,"clientCapabilities":{"session":{"configOptions":{"boolean":{}}}},"clientInfo":{"name":"tgfx","title":"𝒕𝒈(𝒇x)","version":env!("CARGO_PKG_VERSION")},"_meta":{"fx":{"terminal":false}}}))?).block_task().await?;
    let initialized=wire(&init);let mut replaced=options.saved_session.is_some();
    let loaded=if initialized["agentCapabilities"]["loadSession"]==true{if let Some(saved)=&options.saved_session{cx.send_request(decode::<LoadSessionRequest>(json!({"sessionId":saved,"cwd":options.cwd,"mcpServers":options.mcp_servers}))?).block_task().await.ok().map(|r|(saved.clone(),wire(&r)))}else{None}}else{None};
    let (sid,response)=if let Some(loaded)=loaded{replaced=false;loaded}else{
     let mut params=json!({"cwd":options.cwd,"mcpServers":options.mcp_servers});
     if let Some(prompt)=&options.system_prompt {
      if !initialized["agentCapabilities"]["sessionCapabilities"]["systemPrompt"].is_object() {
       return Err(acp::Error::internal_error().data("FX does not support the Telegram system prompt; update FX"));
      }
      // FX accepts this text-block extension independently of the evolving RFD wire shape.
      params["_meta"]=json!({"fx":{"systemPrompt":[{"type":"text","text":prompt}]}});
     }
     let created=cx.send_request(decode::<NewSessionRequest>(params)?).block_task().await?;(created.session_id.to_string(),wire(&created))};
    let mut config=response["configOptions"].as_array().cloned().unwrap_or_default();
    if options.permission_mode=="auto"{
     let modes=response["modes"]["availableModes"].as_array();
     if modes.is_some_and(|m|m.iter().any(|x|x["id"]=="code")){cx.send_request(decode::<SetSessionModeRequest>(json!({"sessionId":sid,"modeId":"code"}))?).block_task().await?;}else{
      let mode=config.iter().find(|o|o["id"]=="mode");let values=mode.map(option_values).unwrap_or_default();let value=if values.iter().any(|v|v=="auto"){Some("auto")}else if values.iter().any(|v|v=="code"){Some("code")}else{None};
      if let Some(value)=value{let r=cx.send_request(decode::<SetSessionConfigOptionRequest>(json!({"sessionId":sid,"configId":"mode","value":value}))?).block_task().await?;config=wire(&r)["configOptions"].as_array().cloned().unwrap_or_default();}else{return Err(acp::Error::internal_error().data("FX ACP does not expose the required auto/code mode"));}
     }
    }
    if let Some(i)=connect_weak.upgrade(){*i.id.write().unwrap()=sid;*i.config.write().unwrap()=config;*i.agent.write().unwrap()=initialized;i.replaced.store(replaced,Ordering::Release);*i.connection.write().unwrap()=Some(cx.clone());}
    if let Some(tx)=ready.take(){let _=tx.send(Ok(()));}
    close_gate.cancelled().await;
    Ok(())
   });
        tokio::pin!(protocol);
        let result = tokio::select! {r=&mut protocol=>r.map_err(anyhow::Error::from),status=child.wait()=>{let status=status?;tokio::task::yield_now().await;bail!("FX exited with {status}: {}",tail.lock().unwrap().trim())}};
        if !shutdown.is_cancelled() {
            result?;
            bail!("FX ACP connection closed: {}", tail.lock().unwrap().trim())
        }
        Ok(())
    }
    pub fn session_id(&self) -> String {
        self.inner.id.read().unwrap().clone()
    }
    pub fn config_options(&self) -> Vec<Value> {
        self.inner.config.read().unwrap().clone()
    }
    pub fn context_usage(&self) -> Option<usage::ContextUsage> {
        *self.inner.usage.read().unwrap()
    }
    pub fn clear_context_usage(&self) {
        *self.inner.usage.write().unwrap() = None;
    }
    pub fn model_id(&self) -> String {
        model_id(&self.inner.config.read().unwrap())
            .unwrap_or("Model")
            .to_owned()
    }
    pub fn replaced_previous(&self) -> bool {
        self.inner.replaced.load(Ordering::Acquire)
    }
    pub fn agent_info(&self) -> Value {
        self.inner.agent.read().unwrap().clone()
    }
    pub fn usable(&self) -> bool {
        !self.inner.shutdown.is_cancelled() && self.inner.error.read().unwrap().is_none()
    }
    pub fn can_steer(&self) -> bool {
        self.usable() && self.inner.active.load(Ordering::Acquire)
    }
    fn cx(&self) -> Result<ConnectionTo<Agent>> {
        if let Some(e) = self.inner.error.read().unwrap().as_ref() {
            bail!("{e}")
        }
        if self.inner.shutdown.is_cancelled() {
            bail!("FX session is closed")
        };
        self.inner
            .connection
            .read()
            .unwrap()
            .clone()
            .context("FX session not ready")
    }
    pub async fn prompt(
        &self,
        blocks: Vec<Value>,
        events: mpsc::UnboundedSender<FxEvent>,
    ) -> Result<Value> {
        let _guard = self
            .inner
            .prompt
            .try_lock()
            .context("FX already has an active prompt; queue or steer instead")?;
        let cx = self.cx()?;
        let compact = blocks.len() == 1
            && blocks[0]["type"] == "text"
            && blocks[0]["text"]
                .as_str()
                .is_some_and(|s| s.trim() == "/compact");
        let prepared = if compact {
            None
        } else {
            Some(self.inner.memory.lock().unwrap().prepare()?)
        };
        let mut prompt = vec![];
        if let Some(p) = prepared.as_ref().and_then(|p| p.block.clone()) {
            prompt.push(p);
        }
        prompt.extend(blocks);
        if serde_json::to_vec(&prompt)?.len() > 8 * 1024 * 1024 {
            bail!("Telegram prompt exceeds ACP's 8 MiB input limit")
        }
        *self.inner.events.lock().unwrap() = Some(events);
        *self.inner.permission_cancel.lock().unwrap() = CancellationToken::new();
        self.inner.generation.fetch_add(1, Ordering::AcqRel);
        self.inner.active.store(true, Ordering::Release);
        struct PromptGuard<'a>(&'a Inner);
        impl Drop for PromptGuard<'_> {
            fn drop(&mut self) {
                self.0.active.store(false, Ordering::Release);
                self.0.permission_cancel.lock().unwrap().cancel();
                self.0.events.lock().unwrap().take();
            }
        }
        let _active = PromptGuard(&self.inner);
        let response = cx
            .send_request(decode::<PromptRequest>(
                json!({"sessionId":self.session_id(),"prompt":prompt}),
            )?)
            .block_task()
            .await?;
        // FX may keep a steering request alive as a follow-up. Keep listeners and
        // permission routing until every accepted steer has completed.
        loop {
            let notified = self.inner.steering_done.notified();
            if self.inner.steering.load(Ordering::Acquire) == 0 {
                break;
            }
            notified.await;
        }
        let response = wire(&response);
        match response["stopReason"].as_str() {
            Some("end_turn") => {
                if compact {
                    self.inner.memory.lock().unwrap().reset();
                } else if let Some(prepared) = prepared {
                    self.inner.memory.lock().unwrap().commit(prepared);
                }
            }
            Some("cancelled") => {}
            Some(reason) => {
                let detail = match reason {
                    "max_tokens" | "max_output_tokens" => "reached its response limit",
                    "max_turn_requests" | "max_model_turns" => "reached its turn limit",
                    "refusal" | "refused" => "could not complete the request",
                    _ => reason,
                };
                bail!("FX {detail}. The request may be unfinished.")
            }
            None => bail!("FX returned no stop reason"),
        }
        Ok(response)
    }
    pub async fn cancel(&self) -> Result<()> {
        self.inner.permission_cancel.lock().unwrap().cancel();
        if !self.can_steer() {
            return Ok(());
        }
        self.cx()?.send_notification(decode::<CancelNotification>(
            json!({"sessionId":self.session_id()}),
        )?)?;
        let generation = self.inner.generation.load(Ordering::Acquire);
        let weak = Arc::downgrade(&self.inner);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if let Some(i) = weak.upgrade()
                && i.active.load(Ordering::Acquire)
                && i.generation.load(Ordering::Acquire) == generation
            {
                i.shutdown.cancel();
                kill_group(*i.pid.lock().unwrap(), libc::SIGTERM);
            }
        });
        Ok(())
    }
    pub async fn steer(&self, blocks: Vec<Value>) -> Result<Value> {
        if !self.can_steer() {
            bail!("No active turn to steer")
        };
        if serde_json::to_vec(&blocks)?.len() > 60 * 1024 {
            bail!("Steering input exceeds 60 KiB")
        };
        self.inner.steering.fetch_add(1, Ordering::AcqRel);
        struct SteeringGuard<'a>(&'a Inner);
        impl Drop for SteeringGuard<'_> {
            fn drop(&mut self) {
                self.0.steering.fetch_sub(1, Ordering::AcqRel);
                self.0.steering_done.notify_waiters();
            }
        }
        let _steering = SteeringGuard(&self.inner);
        let response=self.cx()?.send_request(decode::<PromptRequest>(json!({"sessionId":self.session_id(),"prompt":blocks,"_meta":{"fx":{"steer":true}}}))?).block_task().await?;
        let v = wire(&response);
        if v["stopReason"] != "end_turn" {
            bail!("FX steering stopped: {}", v["stopReason"])
        }
        Ok(v)
    }
    pub async fn set_config_option(&self, id: &str, value: &str) -> Result<Vec<Value>> {
        let _guard = self
            .inner
            .prompt
            .try_lock()
            .context("Cannot change FX configuration during an active turn")?;
        let options = self.config_options();
        let option = options
            .iter()
            .find(|o| o["id"] == id)
            .context("FX does not expose this configuration option")?;
        if !option_values(option).contains(&value.to_owned()) && option["type"] != "boolean" {
            bail!("FX does not offer {value} for {id}")
        };
        let value: Value = if option["type"] == "boolean" {
            json!(value.parse::<bool>().context("Expected true or false")?)
        } else {
            json!(value)
        };
        let mut request = json!({"sessionId":self.session_id(),"configId":id,"value":value});
        if option["type"] == "boolean" {
            request["type"] = json!("boolean");
        }
        let response = self
            .cx()?
            .send_request(decode::<SetSessionConfigOptionRequest>(request)?)
            .block_task()
            .await?;
        let options = wire(&response)["configOptions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if !options
            .iter()
            .any(|o| o["id"] == id && o["currentValue"] == value)
        {
            bail!("FX did not apply requested {id} configuration")
        }
        if model_id(&self.inner.config.read().unwrap()) != model_id(&options) {
            *self.inner.usage.write().unwrap() = None;
        }
        *self.inner.config.write().unwrap() = options.clone();
        Ok(options)
    }
    pub async fn close(&self) -> Result<()> {
        if self.inner.shutdown.is_cancelled() {
            return Ok(());
        };
        if let Ok(cx) = self.cx() {
            let request = decode::<CloseSessionRequest>(json!({"sessionId":self.session_id()}))?;
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                cx.send_request(request).block_task(),
            )
            .await;
        }
        self.inner.shutdown.cancel();
        self.inner.permission_cancel.lock().unwrap().cancel();
        kill_group(*self.inner.pid.lock().unwrap(), libc::SIGTERM);
        let task = self.inner.task.lock().unwrap().take();
        if let Some(mut task) = task
            && tokio::time::timeout(Duration::from_secs(2), &mut task)
                .await
                .is_err()
        {
            kill_group(*self.inner.pid.lock().unwrap(), libc::SIGKILL);
            task.abort();
            let _ = task.await;
        }
        Ok(())
    }
}
pub fn option_values(option: &Value) -> Vec<String> {
    option["options"]
        .as_array()
        .map(|a| {
            a.iter()
                .flat_map(|x| {
                    if let Some(value) = x["value"].as_str() {
                        vec![value.to_owned()]
                    } else {
                        x["options"]
                            .as_array()
                            .map(|o| {
                                o.iter()
                                    .filter_map(|v| v["value"].as_str().map(str::to_owned))
                                    .collect()
                            })
                            .unwrap_or_default()
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}
