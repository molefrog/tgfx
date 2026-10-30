use axum::{
    Json, Router,
    extract::{Path as AxumPath, State as AxumState},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::{Mutex as AsyncMutex, Notify, mpsc},
};
#[derive(Clone)]
struct Mock {
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    updates: Arc<AsyncMutex<mpsc::UnboundedReceiver<Value>>>,
    changed: Arc<Notify>,
    next: Arc<std::sync::atomic::AtomicI64>,
    hang_sends: Arc<std::sync::atomic::AtomicBool>,
    hold_callbacks: Arc<std::sync::atomic::AtomicBool>,
    reject_ephemeral: Arc<std::sync::atomic::AtomicBool>,
    release_callbacks: Arc<Notify>,
}
async fn api(
    AxumState(mock): AxumState<Mock>,
    AxumPath(method): AxumPath<String>,
    Json(body): Json<Value>,
) -> Json<Value> {
    mock.calls
        .lock()
        .unwrap()
        .push((method.clone(), body.clone()));
    mock.changed.notify_waiters();
    if method == "sendRichMessage" && mock.hang_sends.load(std::sync::atomic::Ordering::Acquire) {
        futures::future::pending::<()>().await;
    }
    if method == "answerCallbackQuery"
        && mock
            .hold_callbacks
            .load(std::sync::atomic::Ordering::Acquire)
    {
        mock.release_callbacks.notified().await;
    }
    if body.get("ephemeral_message_parameters").is_some()
        && mock
            .reject_ephemeral
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return Json(
            json!({"ok":false,"error_code":403,"description":"Private message unavailable"}),
        );
    }
    let result = match method.as_str() {
        "getMe" => json!({"id":100,"is_bot":true,"first_name":"Bot","username":"fixture_bot"}),
        "getWebhookInfo" => json!({"url":""}),
        "getUpdates" => {
            let mut rx = mock.updates.lock().await;
            match tokio::time::timeout(Duration::from_millis(250), rx.recv()).await {
                Ok(Some(update)) => json!([update]),
                _ => json!([]),
            }
        }
        "getStickerSet" => json!({"stickers":[]}),
        "getFile" => json!({"file_path":"stickers/fixture.webp"}),
        "getChatMember" => json!({"status":"member"}),
        "sendMessage" | "sendRichMessage" if body.get("ephemeral_message_parameters").is_some() => {
            json!({"ephemeral_message_id":mock.next.fetch_add(1,std::sync::atomic::Ordering::AcqRel),
                "receiver_user":{"id":body["ephemeral_message_parameters"]["receiver_user_id"]}})
        }
        s if s.starts_with("send") && s != "sendChatAction" && s != "sendRichMessageDraft" => {
            json!({"message_id":mock.next.fetch_add(1,std::sync::atomic::Ordering::AcqRel),"date":1,"chat":{"id":body["chat_id"].as_str().unwrap_or("42").parse::<i64>().unwrap_or(42),"type":"private"}})
        }
        _ => json!(true),
    };
    Json(json!({"ok":true,"result":result}))
}
fn fixture_image() -> Vec<u8> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(4, 3)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}
struct Running {
    root: tempfile::TempDir,
    child: tokio::process::Child,
    updates: mpsc::UnboundedSender<Value>,
    mock: Mock,
    server: tokio::task::JoinHandle<()>,
    events: Arc<Mutex<Vec<Value>>>,
    event_changed: Arc<Notify>,
    command: Command,
}
impl Running {
    async fn start(output: &str) -> Self {
        Self::start_with_env(output, &[]).await
    }
    async fn start_with_env(output: &str, extra_env: &[(&str, &str)]) -> Self {
        Self::start_with_defaults(output, extra_env, json!({})).await
    }
    async fn start_with_defaults(
        output: &str,
        extra_env: &[(&str, &str)],
        defaults: Value,
    ) -> Self {
        let root = tempfile::Builder::new()
            .prefix("tgfx-runtime-")
            .tempdir_in("/tmp")
            .unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        let mock = Mock {
            calls: Arc::default(),
            updates: Arc::new(AsyncMutex::new(rx)),
            changed: Arc::new(Notify::new()),
            next: Arc::new(std::sync::atomic::AtomicI64::new(1000)),
            hang_sends: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            hold_callbacks: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reject_ephemeral: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            release_callbacks: Arc::new(Notify::new()),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/bot100:fake/{method}", post(api))
            .route(
                "/file/bot100:fake/stickers/fixture.webp",
                get(|| async { fixture_image() }),
            )
            .with_state(mock.clone());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let runtime = root.path().join("runtime");
        std::fs::create_dir(&runtime).unwrap();
        let policy = runtime.join("policy.json");
        std::fs::write(&policy,json!({"version":1,"activeBotId":"100","access":{"userIds":["42","43"],"chatIds":["-9"]},"approvals":{"chatId":"42","topicId":"0"}}).to_string()).unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::create_dir(root.path().join("home")).unwrap();
        std::fs::write(
            root.path().join("home/config.json"),
            json!({"version":1,"defaults":defaults}).to_string(),
        )
        .unwrap();
        let wrapper = root.path().join("fx-fixture");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nexec python3 '{}' \"$@\"\n",
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/support/runtime_fx.py")
                    .display()
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let recovery = extra_env
            .iter()
            .any(|(key, value)| *key == "RUNTIME_SEED_RECOVERY" && *value == "1");
        if recovery {
            let state =
                tgfx::state::State::open(&root.path().join("home/state/100.db"), &workspace)
                    .unwrap();
            let route = tgfx::types::Route::new("100", "42", "0", "private");
            state.ensure_route(&route).unwrap();
            state.create_outbox("pending-recovery",&route,None,"rich_final",&json!({"chatId":"42","topicId":"0","rich":{"blocks":[{"type":"paragraph","text":"RECOVERY"}]},"plain":"RECOVERY"})).unwrap();
            mock.hang_sends
                .store(true, std::sync::atomic::Ordering::Release);
        }
        let mut command = Command::new(env!("CARGO_BIN_EXE_tgfx"));
        command
            .args([
                "--json",
                "--no-tui",
                "--no-icons",
                "--output",
                output,
                "--cwd",
            ])
            .arg(&workspace)
            .env("TELEGRAM_BOT_TOKEN", "100:fake")
            .env("TGFX_RUNTIME_DIR", &runtime)
            .env("TGFX_HOME", root.path().join("home"))
            .env("TGFX_API_ROOT", format!("http://{addr}"))
            .env("FX_BINARY", &wrapper)
            .env("RUNTIME_FX_LOG", root.path().join("fx.jsonl"))
            .env(
                "RUNTIME_FX_READY_URL",
                format!("http://{addr}/bot100:fake/fixtureInitializeHung"),
            )
            .envs(extra_env.iter().copied())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let events = Arc::new(Mutex::new(vec![]));
        let changed = Arc::new(Notify::new());
        let child = Self::spawn(&mut command, &events, &changed);
        let running = Self {
            root,
            child,
            updates: tx,
            mock,
            server,
            events,
            event_changed: changed,
            command,
        };
        if !recovery {
            running
                .event(|v| v["type"] == "boot" && v["step"] == "polling")
                .await;
        }
        running
    }
    fn spawn(
        command: &mut Command,
        events: &Arc<Mutex<Vec<Value>>>,
        changed: &Arc<Notify>,
    ) -> tokio::process::Child {
        let mut child = command.spawn().unwrap();
        let es = events.clone();
        let ec = changed.clone();
        let out = child.stdout.take().unwrap();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(event) = serde_json::from_str(&line) {
                    es.lock().unwrap().push(event);
                    ec.notify_waiters();
                }
            }
        });
        let err = child.stderr.take().unwrap();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("runtime: {line}");
            }
        });
        child
    }
    fn message(&self, id: i64, chat: i64, text: &str) {
        self.updates.send(json!({"update_id":id,"message":{"message_id":id,"date":id,"chat":{"id":chat,"type":if chat<0{"supergroup"}else{"private"}},"from":{"id":if chat>0{chat}else{42},"is_bot":false,"first_name":"Ada"},"text":text}})).unwrap();
    }
    fn callback(&self, id: i64, data: &str, card: i64) {
        self.callback_in(id, data, card, 42);
    }
    fn callback_in(&self, id: i64, data: &str, card: i64, chat: i64) {
        self.updates.send(json!({
            "update_id":id,
            "callback_query":{
                "id":format!("cb{id}"),
                "from":{"id":42,"is_bot":false,"first_name":"Ada"},
                "data":data,
                "message":{"message_id":card,"date":1,"chat":{"id":chat,"type":if chat<0{"supergroup"}else{"private"}}}
            }
        })).unwrap();
    }
    async fn event(&self, predicate: impl Fn(&Value) -> bool) -> Value {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let notified = self.event_changed.notified();
                if let Some(v) = self
                    .events
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|v| predicate(v))
                    .cloned()
                {
                    return v;
                }
                notified.await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "Expected status event; got {:?}",
                self.events.lock().unwrap()
            )
        })
    }
    async fn call(&self, predicate: impl Fn(&str, &Value) -> bool) -> (String, Value) {
        self.call_after(0, predicate).await
    }
    async fn call_after(
        &self,
        after: usize,
        predicate: impl Fn(&str, &Value) -> bool,
    ) -> (String, Value) {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let notified = self.mock.changed.notified();
                if let Some(v) = self
                    .mock
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .skip(after)
                    .find(|(m, p)| predicate(m, p))
                    .cloned()
                {
                    return v;
                }
                notified.await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "Expected Telegram request; got {:?}",
                self.mock.calls.lock().unwrap()
            )
        })
    }
    fn fx(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.path().join("fx.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter_map(|s| serde_json::from_str(s).ok())
            .collect()
    }
    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.root.path().join("home/state/100.db")).unwrap()
    }
    async fn stop_process(&mut self) {
        unsafe {
            libc::kill(self.child.id().unwrap() as i32, libc::SIGTERM);
        }
        let status = tokio::time::timeout(Duration::from_secs(10), self.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success(), "runtime exited {status}");
    }
    async fn restart(&mut self) {
        self.stop_process().await;
        self.events.lock().unwrap().clear();
        self.mock.calls.lock().unwrap().clear();
        self.child = Self::spawn(&mut self.command, &self.events, &self.event_changed);
        self.event(|v| v["type"] == "boot" && v["step"] == "polling")
            .await;
    }
    async fn stop(mut self) {
        self.stop_process().await;
        self.server.abort();
    }
}
fn text(value: &Value) -> String {
    value.to_string()
}
fn callback_data(value: &Value, prefix: &str) -> Option<String> {
    value["reply_markup"]["inline_keyboard"]
        .as_array()?
        .iter()
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|button| button["callback_data"].as_str())
        .find(|data| data.starts_with(prefix))
        .map(str::to_owned)
}
async fn model_menu(r: &Running) -> String {
    model_menu_at(r, 1).await
}
async fn model_menu_at(r: &Running, update: i64) -> String {
    let before = r.mock.calls.lock().unwrap().len();
    r.message(update, 42, "/model");
    let (_, menu) = r
        .call_after(before, |m, p| {
            m == "sendMessage" && callback_data(p, "model:").is_some()
        })
        .await;
    callback_data(&menu, "model:")
        .unwrap()
        .split(':')
        .take(2)
        .collect::<Vec<_>>()
        .join(":")
}
async fn model_click(r: &Running, id: &mut i64, prefix: &str, action: &str) -> Value {
    *id += 1;
    let before = r.mock.calls.lock().unwrap().len();
    r.callback(*id, &format!("{prefix}:{action}"), 1000);
    r.call_after(before, |m, _| m == "editMessageText").await.1
}
#[tokio::test]
async fn model_settings_apply_through_acp_and_close_the_menu() {
    let r = Running::start_with_env("live", &[("RUNTIME_MODEL_SETTINGS", "1")]).await;
    let prefix = model_menu(&r).await;
    let mut id = 1;
    model_click(&r, &mut id, &prefix, "v.2.1").await;
    let settings = model_click(&r, &mut id, &prefix, "c.settings").await;
    assert!(callback_data(&settings, &format!("{prefix}:a.e.")).is_some());
    assert!(callback_data(&settings, &format!("{prefix}:a.f.")).is_some());
    let effort = model_click(&r, &mut id, &prefix, "a.e.1").await;
    assert!(callback_data(&effort, &prefix).is_none());
    assert!(text(&effort).contains("High Effort"));
    id += 1;
    r.callback(id, &format!("{prefix}:a.e.2"), 1000);
    let (_, expired) = r
        .call(|m, p| m == "answerCallbackQuery" && p["callback_query_id"] == format!("cb{id}"))
        .await;
    assert!(text(&expired).contains("expired"));
    for (index, label) in [(1, "Fast"), (2, "Ultrafast"), (0, "Regular")] {
        id += 1;
        let prefix = model_menu_at(&r, id).await;
        model_click(&r, &mut id, &prefix, "c.settings").await;
        let view = model_click(&r, &mut id, &prefix, &format!("a.f.{index}")).await;
        assert!(text(&view).contains(label));
        assert!(callback_data(&view, &prefix).is_none());
    }
    let writes: Vec<_> = r
        .fx()
        .into_iter()
        .filter(|v| v["method"] == "session/set_config_option" && v["params"]["configId"] != "mode")
        .map(|v| json!([v["params"]["configId"], v["params"]["value"]]))
        .collect();
    assert_eq!(
        writes,
        vec![
            json!(["effort", "high"]),
            json!(["fast", true]),
            json!(["ultrafast", true]),
            json!(["fast", false]),
            json!(["ultrafast", false])
        ]
    );
    r.stop().await;
}
#[tokio::test]
async fn closing_or_selecting_unchanged_values_deletes_the_picker_without_writing_settings() {
    let r = Running::start_with_env("live", &[("RUNTIME_MODEL_SETTINGS", "1")]).await;
    let mut id = 0;
    for action in ["x", "s.0", "a.e.0", "a.f.0"] {
        id += 1;
        let prefix = model_menu_at(&r, id).await;
        if action != "s.0" {
            model_click(&r, &mut id, &prefix, "c.settings").await;
        }
        let before = r.mock.calls.lock().unwrap().len();
        id += 1;
        r.callback(id, &format!("{prefix}:{action}"), 1000);
        let (_, deleted) = r
            .call_after(before, |method, _| method == "deleteMessage")
            .await;
        assert_eq!(deleted["chat_id"], "42");
        assert_eq!(deleted["message_id"], 1000);
    }
    assert!(
        r.fx().iter().all(
            |v| v["method"] != "session/set_config_option" || v["params"]["configId"] == "mode"
        )
    );
    r.stop().await;
}
#[tokio::test]
async fn completed_model_picker_actions_do_not_become_interrupted_after_restart() {
    let mut r = Running::start_with_env("live", &[("RUNTIME_MODEL_SETTINGS", "1")]).await;
    let mut id = 0;
    let mut completed = vec![];
    for action in ["x", "s.0", "a.e.0", "a.f.0"] {
        id += 1;
        let prefix = model_menu_at(&r, id).await;
        if action.starts_with("a.") {
            model_click(&r, &mut id, &prefix, "c.settings").await;
        }
        let before = r.mock.calls.lock().unwrap().len();
        id += 1;
        r.callback(id, &format!("{prefix}:{action}"), 1000);
        r.call_after(before, |method, _| method == "deleteMessage")
            .await;
        completed.push(id);
    }
    // Telegram records the delete request before its response reaches the bot.
    // Wait for dispatch to finish before restarting, rather than racing that response.
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let pending: i64 = r
                .db()
                .query_row(
                    "SELECT count(*) FROM telegram_inbox WHERE status IN ('dispatching','running')",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            if pending == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("completed picker actions must finish dispatch");
    r.restart().await;
    for update in completed {
        let status: String = r
            .db()
            .query_row(
                "SELECT status FROM telegram_inbox WHERE update_id=?",
                [update],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "done");
    }
    assert!(
        !r.mock.calls.lock().unwrap().iter().any(|(method, params)| {
            method == "sendMessage" && text(params).contains("interrupted")
        })
    );
    r.stop().await;
}
#[tokio::test]
async fn choosing_a_model_closes_the_menu_and_reopening_refreshes_supported_controls() {
    let r = Running::start_with_env("live", &[("RUNTIME_MODEL_SETTINGS", "1")]).await;
    let prefix = model_menu(&r).await;
    let view = model_click(&r, &mut 1, &prefix, "s.1").await;
    assert!(text(&view).contains("claude-opus"));
    assert!(
        view["text"]
            .as_str()
            .unwrap()
            .starts_with("Changed model to ")
    );
    assert!(callback_data(&view, &prefix).is_none());
    let prefix = model_menu_at(&r, 3).await;
    let view = model_click(&r, &mut 3, &prefix, "p.0").await;
    assert!(callback_data(&view, &format!("{prefix}:c.")).is_none());
    assert!(callback_data(&view, &format!("{prefix}:x")).is_some());
    r.stop().await;
}
#[tokio::test]
async fn rejected_setting_keeps_the_menu_usable_and_does_not_claim_success() {
    let r = Running::start_with_env(
        "live",
        &[
            ("RUNTIME_MODEL_SETTINGS", "1"),
            ("RUNTIME_REJECT_SETTINGS", "1"),
        ],
    )
    .await;
    let prefix = model_menu(&r).await;
    let mut id = 1;
    model_click(&r, &mut id, &prefix, "c.settings").await;
    r.callback(3, &format!("{prefix}:a.e.1"), 1000);
    let (_, answer) = r
        .call(|m, p| m == "answerCallbackQuery" && p["callback_query_id"] == "cb3")
        .await;
    assert!(text(&answer).contains("could not apply"));
    id = 3;
    let view = model_click(&r, &mut id, &prefix, "b").await;
    assert!(text(&view).contains("Auto Effort"));
    r.stop().await;
}
#[tokio::test]
async fn effort_stays_unchanged_while_a_turn_is_running() {
    let r = Running::start_with_env("live", &[("RUNTIME_MODEL_SETTINGS", "1")]).await;
    let prefix = model_menu(&r).await;
    r.message(2, 42, "WAIT");
    r.call(|m, p| m == "sendRichMessageDraft" && text(p).contains("WAIT_READY"))
        .await;
    r.callback(3, &format!("{prefix}:a.e.1"), 1000);
    let (_, answer) = r
        .call(|m, p| m == "answerCallbackQuery" && p["callback_query_id"] == "cb3")
        .await;
    assert!(text(&answer).contains("current turn"));
    assert!(
        !r.fx().iter().any(
            |v| v["method"] == "session/set_config_option" && v["params"]["configId"] != "mode"
        )
    );
    r.callback(4, &format!("{prefix}:a.e.0"), 1000);
    r.call(|method, _| method == "deleteMessage").await;
    r.message(5, 42, "/stop");
    r.stop().await;
}
#[tokio::test]
async fn saved_chat_format_survives_restart_without_affecting_other_chats() {
    let mut r = Running::start("live").await;
    r.callback(1, "fmt:final", 1000);
    r.call(|m, p| m == "answerCallbackQuery" && p["callback_query_id"] == "cb1")
        .await;
    r.restart().await;
    r.message(2, 42, "SAVED_FORMAT");
    r.call(|m, p| m == "sendRichMessage" && text(p).contains("SAVED_FORMAT"))
        .await;
    assert!(
        !r.mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(m, p)| m == "sendRichMessageDraft" && p["chat_id"].as_str() == Some("42"))
    );
    r.message(3, 43, "WAIT");
    r.call(|m, p| m == "sendRichMessageDraft" && p["chat_id"].as_str() == Some("43"))
        .await;
    r.message(4, 43, "/stop");
    r.stop().await;
}
#[tokio::test]
async fn groups_reject_format_changes_including_old_buttons() {
    let r = Running::start("detailed").await;
    r.message(1, -9, "/format@fixture_bot");
    let (_, menu) = r
        .call(|m, p| m == "sendMessage" && p["chat_id"].as_str() == Some("-9"))
        .await;
    assert!(text(&menu).contains("Final"));
    assert!(callback_data(&menu, "fmt:").is_none());
    r.callback_in(2, "fmt:live", 1000, -9);
    let (_, answer) = r
        .call(|m, p| m == "answerCallbackQuery" && p["callback_query_id"] == "cb2")
        .await;
    assert!(text(&answer).contains("Final"));
    r.message(3, 42, "UNCHANGED_DM_FORMAT");
    let (_, reply) = r
        .call(|m, p| m == "sendRichMessage" && text(p).contains("UNCHANGED_DM_FORMAT"))
        .await;
    assert!(text(&reply).contains("details"));
    r.stop().await;
}
#[tokio::test]
async fn groups_send_only_the_final_answer_even_with_a_detailed_default() {
    let r = Running::start_with_defaults("detailed", &[], json!({"groupReply":"all"})).await;
    r.message(1, -9, "GROUP_ANSWER");
    let (_, reply) = r
        .call(|m, p| m == "sendRichMessage" && text(p).contains("GROUP_ANSWER"))
        .await;
    assert!(!text(&reply).contains("details"));
    assert!(
        !r.mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(m, _)| m == "sendRichMessageDraft")
    );
    r.stop().await;
}
#[tokio::test]
async fn external_events_use_the_destination_chat_format() {
    let r = Running::start("detailed").await;
    r.callback(1, "fmt:final", 1000);
    r.call(|m, p| m == "answerCallbackQuery" && p["callback_query_id"] == "cb1")
        .await;
    let socket = r.root.path().join("runtime/events.sock");
    for chat in ["42", "43", "-9"] {
        let id = format!("format-{chat}");
        tgfx::event_socket::event_request(
            &socket,
            &json!({"op":"emit","event":{"id":id,"name":"format.test","chatId":chat}}),
        )
        .await
        .unwrap();
        r.event(|v| v["event"] == "external.done" && v["id"] == id)
            .await;
        let (_, reply) = r
            .call(|m, p| m == "sendRichMessage" && p["chat_id"].as_str() == Some(chat))
            .await;
        assert_eq!(text(&reply).contains("details"), chat == "43");
    }
    r.stop().await;
}
#[tokio::test]
async fn unauthorized_messages_are_discarded_and_authorized_delivery_is_journaled() {
    let mut r = Running::start("final").await;
    r.message(1, 999, "MUST_NOT_STORE");
    r.message(2, 42, "AUTHORIZED_ANSWER");
    r.call(|m, p| m == "sendRichMessage" && text(p).contains("AUTHORIZED_ANSWER"))
        .await;
    r.event(|v| v["type"] == "turn" && v["state"] == "finished")
        .await;
    assert!(!text(&json!(r.fx())).contains("MUST_NOT_STORE"));
    r.stop_process().await;
    let database = r.db();
    let inbox: Vec<(String, Option<String>)> = database
        .prepare("SELECT status, payload_json FROM telegram_inbox")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(inbox.iter().all(|(_, payload)| {
        !payload
            .as_deref()
            .unwrap_or_default()
            .contains("MUST_NOT_STORE")
    }));
    assert!(inbox.iter().any(|(status, _)| status == "done"));
    assert_eq!(
        database
            .query_row(
                "SELECT status FROM telegram_outbox ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "sent"
    );
    r.server.abort();
}
#[tokio::test]
async fn shared_memory_tracks_chat_topics_and_background_sessions_independently() {
    let r = Running::start_with_defaults("final", &[], json!({"memory":{"file":"notes.md"}})).await;
    let path = r.root.path().join("workspace/notes.md");
    let socket = r.root.path().join("runtime/events.sock");
    for (step, contents, expected) in [
        (0, Some("# Facts\nShared fact.\n"), "<memory "),
        (
            1,
            Some("# Facts\nShared fact.\n\n# Added\nNew fact.\n"),
            "action=\"append\"",
        ),
        (2, Some("# Facts\nChanged fact.\n"), "action=\"reread\""),
        (3, Some("# Facts\nChanged fact.\n"), ""),
        (4, None, "action=\"clear\""),
    ] {
        if let Some(contents) = contents {
            std::fs::write(&path, contents).unwrap();
        } else {
            std::fs::remove_file(&path).unwrap();
        }
        for (name, destination) in [
            ("dm", json!({"chatId":"42"})),
            ("topic", json!({"chatId":"-9","topicId":"17"})),
            ("background", json!({})),
        ] {
            let id = format!("memory-{step}-{name}");
            let mut event = destination;
            event["id"] = json!(id);
            event["name"] = json!("memory.test");
            tgfx::event_socket::event_request(&socket, &json!({"op":"emit","event":event}))
                .await
                .unwrap();
            r.event(|v| v["event"] == "external.done" && v["id"] == id)
                .await;
            let requests = r.fx();
            let prompt = &requests
                .iter()
                .rev()
                .find(|v| v["method"] == "session/prompt")
                .unwrap()["params"]["prompt"];
            let first = prompt[0]["text"].as_str().unwrap();
            if expected.is_empty() {
                assert!(!first.starts_with("<memory"));
            } else {
                assert!(first.contains(expected), "{id}: {first}");
                assert!(first.contains("source=\"notes.md\""));
            }
            if step == 1 {
                assert!(first.contains("New fact."));
                assert!(!first.contains("Shared fact."));
            }
            if step == 2 {
                assert!(!first.contains("Changed fact."));
            }
        }
    }
    assert_eq!(
        r.fx()
            .iter()
            .filter(|v| v["method"] == "session/new")
            .count(),
        3
    );
    r.stop().await;
}
#[tokio::test]
async fn route_queues_controls_stop_and_format_remain_independent() {
    let r = Running::start("live").await;
    r.message(1, 42, "WAIT");
    r.call(|m, p| m == "sendRichMessageDraft" && text(p).contains("WAIT_READY"))
        .await;
    r.message(2, 42, "DISCARDED");
    r.event(|v| v["type"] == "queue" && v["waiting"].as_u64().is_some_and(|n| n > 0))
        .await;
    r.callback(3, "fmt:final", 1000);
    r.call(|m, p| m == "answerCallbackQuery" && p["callback_query_id"] == "cb3")
        .await;
    assert_eq!(
        r.db()
            .query_row(
                "SELECT status FROM telegram_inbox WHERE update_id=1",
                [],
                |v| v.get::<_, String>(0)
            )
            .unwrap(),
        "running"
    );
    r.message(4, 43, "OTHER_ROUTE");
    r.call(|m, p| m == "sendRichMessage" && text(p).contains("OTHER_ROUTE"))
        .await;
    r.message(5, 42, "/stop");
    r.message(6, 42, "AFTER_STOP");
    r.call(|m, p| m == "sendRichMessage" && text(p).contains("AFTER_STOP"))
        .await;
    let prompts: Vec<_> = r
        .fx()
        .into_iter()
        .filter(|v| v["method"] == "session/prompt")
        .collect();
    assert!(!prompts.iter().any(|p| {
        p["params"]["prompt"]
            .as_array()
            .and_then(|a| a.last())
            .is_some_and(|b| b["text"] == "DISCARDED")
    }));
    assert!(prompts.iter().any(|p| text(p).contains("AFTER_STOP")));
    assert_eq!(
        r.db()
            .query_row(
                "SELECT status FROM telegram_inbox WHERE update_id=2",
                [],
                |v| v.get::<_, String>(0)
            )
            .unwrap(),
        "discarded"
    );
    let finals = r
        .mock
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, p)| m == "sendRichMessage" && text(p).contains("AFTER_STOP"))
        .cloned()
        .collect::<Vec<_>>();
    assert!(!text(&finals[0].1).contains("details"));
    assert!(
        !r.mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(m, p)| m == "sendMessage" && text(p).contains("queued"))
    );
    r.stop().await;
}
#[tokio::test]
async fn native_stop_matches_active_draft_without_discarding_queued_work() {
    let r = Running::start("live").await;
    r.message(1, 42, "WAIT");
    let (_, draft) = r
        .call(|m, p| m == "sendRichMessageDraft" && text(p).contains("WAIT_READY"))
        .await;
    r.message(2, 42, "QUEUED_AFTER_NATIVE_STOP");
    r.updates.send(json!({"update_id":3,"stopped_message_generation":{"chat":{"id":42},"draft_id":"999999999"}})).unwrap();
    r.callback(4, "fmt:live", 1000);
    r.call(|m, p| m == "answerCallbackQuery" && p["callback_query_id"] == "cb4")
        .await;
    assert_eq!(
        r.db()
            .query_row(
                "SELECT status FROM telegram_inbox WHERE update_id=1",
                [],
                |v| v.get::<_, String>(0)
            )
            .unwrap(),
        "running"
    );
    r.updates.send(json!({"update_id":5,"stopped_message_generation":{"chat":{"id":42},"draft_id":draft["draft_id"].to_string()}})).unwrap();
    r.call(|m, p| m == "sendRichMessage" && text(p).contains("QUEUED_AFTER_NATIVE_STOP"))
        .await;
    r.stop().await;
}
#[tokio::test]
async fn background_events_are_durable_and_do_not_receive_telegram_capabilities() {
    let r = Running::start("final").await;
    let socket = r.root.path().join("runtime/events.sock");
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_tgfx"))
        .args([
            "emit",
            "email.received",
            "--id",
            "event-one",
            "--payload",
            r#"{"message_id":"separate-fetch"}"#,
        ])
        .current_dir(r.root.path())
        .env("TGFX_RUNTIME_DIR", r.root.path().join("runtime"))
        .env("TGFX_HOME", r.root.path().join("unrelated-home"))
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let job: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(job["destination"], "100:background");
    r.event(|v| v["event"] == "external.done" && v["id"] == "event-one")
        .await;
    let duplicate=tgfx::event_socket::event_request(&socket,&json!({"op":"emit","event":{"id":"event-one","name":"email.received","payload":{"message_id":"separate-fetch"}}})).await.unwrap();
    assert_eq!(duplicate["status"], "done");
    let discovered = tokio::process::Command::new(env!("CARGO_BIN_EXE_tgfx"))
        .args(["emit", "--status", "event-one"])
        .current_dir(r.root.path().join("workspace"))
        .env("TGFX_HOME", r.root.path().join("home"))
        .env_remove("TGFX_RUNTIME_DIR")
        .output()
        .await
        .unwrap();
    assert!(
        discovered.status.success(),
        "{}",
        String::from_utf8_lossy(&discovered.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&discovered.stdout).unwrap()["status"],
        "done"
    );
    assert!(
        !r.mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(m, _)| m == "sendRichMessage")
    );
    let fx = r.fx();
    let new = fx.iter().find(|v| v["method"] == "session/new").unwrap();
    assert_eq!(new["params"]["mcpServers"], json!([]));
    assert!(new["params"].get("_meta").is_none());
    let prompt = fx.iter().find(|v| v["method"] == "session/prompt").unwrap();
    assert!(text(prompt).contains("external_event"));
    assert!(!text(prompt).contains("telegram_message"));
    assert!(
        tgfx::event_socket::event_request(
            &socket,
            &json!({"op":"emit","event":{"name":"test","chatId":"999"}})
        )
        .await
        .is_err()
    );
    r.stop().await;
}
#[tokio::test]
async fn active_permission_can_be_answered_without_blocking_polling() {
    let r = Running::start("final").await;
    r.message(1, 42, "PERMISSION");
    let (_, card) = r
        .call(|m, p| m == "sendMessage" && text(p).contains("fx permission"))
        .await;
    let callback = card["reply_markup"]["inline_keyboard"][1][0]["callback_data"]
        .as_str()
        .unwrap();
    r.callback(2, callback, 1000);
    r.call(|m, p| m == "sendRichMessage" && text(p).contains("selected"))
        .await;
    let interaction = r
        .db()
        .query_row(
            "SELECT state FROM telegram_interactions WHERE kind='fx_permission'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap();
    assert_eq!(interaction, "resolved");
    r.stop().await;
}

#[tokio::test]
async fn forwarded_stickers_keep_prepared_local_image_paths_in_each_envelope() {
    let r = Running::start("final").await;
    r.updates.send(json!({"update_id":1,"message":{"message_id":1,"date":1,"chat":{"id":42,"type":"private"},"from":{"id":42,"is_bot":false,"first_name":"Ada"},"forward_origin":{"type":"user","date":1,"sender_user":{"id":99,"is_bot":false,"first_name":"Source"}},"sticker":{"file_id":"sticker-file","file_unique_id":"unique","width":512,"height":512,"is_animated":false,"is_video":false,"emoji":"🦀"}}})).unwrap();
    r.updates.send(json!({"update_id":2,"message":{"message_id":2,"date":2,"chat":{"id":42,"type":"private"},"from":{"id":42,"is_bot":false,"first_name":"Ada"},"forward_origin":{"type":"user","date":1,"sender_user":{"id":99,"is_bot":false,"first_name":"Source"}},"text":"FORWARDED_CAPTION"}})).unwrap();
    r.message(3, 42, "FLUSH_BATCH");
    r.call(|method, params| {
        method == "sendRichMessage" && text(params).contains("FORWARDED_CAPTION")
    })
    .await;
    assert!(
        r.fx()
            .iter()
            .filter(|v| v["method"] == "session/prompt")
            .any(|v| v["params"]["prompt"]
                .as_array()
                .unwrap()
                .iter()
                .any(|b| b["type"] == "image"))
    );
    let mut sticker = None;
    for request in r
        .fx()
        .into_iter()
        .filter(|v| v["method"] == "session/prompt")
    {
        for block in request["params"]["prompt"].as_array().into_iter().flatten() {
            if let Some(envelope) = block["text"]
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
            {
                for attachment in envelope["telegram_message"]["attachments"]
                    .as_array()
                    .into_iter()
                    .flatten()
                {
                    if attachment["kind"] == "sticker" {
                        sticker = Some(attachment.clone());
                    }
                }
            }
        }
    }
    let sticker = sticker.expect("forwarded sticker envelope");
    assert_eq!(sticker["state"], "local");
    assert_eq!(sticker["sticker"]["image"]["state"], "local");
    let path = sticker["sticker"]["image"]["path"].as_str().unwrap();
    assert!(Path::new(path).is_file());
    assert_eq!(std::fs::read(path).unwrap(), fixture_image());
    r.stop().await;
}
#[tokio::test]
async fn pausing_during_long_poll_preserves_the_returned_batch_until_resume() {
    use tgfx::{
        config::WorkspacePaths,
        runtime::{Runtime, RuntimeControl, RuntimeOptions},
        state::State,
        telegram::TelegramApi,
        types::{BotIdentity, Config},
    };
    use tokio_util::sync::CancellationToken;
    let root = tempfile::Builder::new()
        .prefix("tgfx-pause-")
        .tempdir_in("/tmp")
        .unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let (tx, rx) = mpsc::unbounded_channel();
    let mock = Mock {
        calls: Arc::default(),
        updates: Arc::new(AsyncMutex::new(rx)),
        changed: Arc::new(Notify::new()),
        next: Arc::new(std::sync::atomic::AtomicI64::new(1)),
        hang_sends: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        hold_callbacks: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        reject_ephemeral: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        release_callbacks: Arc::new(Notify::new()),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/bot100:fake/{method}", post(api))
        .with_state(mock.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let binary = root.path().join("fx");
    std::fs::write(
        &binary,
        format!(
            "#!/bin/sh\nexec python3 '{}' \"$@\"\n",
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/support/fx_fixture.py")
                .display()
        ),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let config:Config=serde_json::from_value(json!({"version":1,"activeBotId":"100","access":{"userIds":["42"],"chatIds":[]},"approvals":{"chatId":"42","topicId":"0"},"output":"final","customIcons":false})).unwrap();
    let database = root.path().join("state/100.db");
    let paths = WorkspacePaths {
        workspace: workspace.clone(),
        config: root.path().join("config.json"),
        database: database.clone(),
        lock: root.path().join("100.lock"),
        lock_info: root.path().join("100.info.json"),
        files: root.path().join("files"),
    };
    let runtime = Runtime::new(RuntimeOptions {
        config,
        workspace: workspace.clone(),
        paths,
        token: "100:fake".into(),
        bot: BotIdentity {
            id: "100".into(),
            username: Some("fixture_bot".into()),
            display_name: "Bot".into(),
        },
        telegram: TelegramApi::new("100:fake", Some(&format!("http://{address}"))).unwrap(),
        fx_binary: binary.to_string_lossy().into_owned(),
        model: None,
        yolo: false,
        json: false,
    })
    .unwrap();
    let control = runtime.control();
    let mut status = runtime.subscribe();
    let stop = CancellationToken::new();
    let running = tokio::spawn(runtime.run(stop.clone()));
    async fn until(
        status: &mut tokio::sync::broadcast::Receiver<Value>,
        predicate: impl Fn(&Value) -> bool,
    ) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let event = status.recv().await.unwrap();
                if predicate(&event) {
                    return;
                }
            }
        })
        .await
        .unwrap();
    }
    until(&mut status, |v| {
        v["type"] == "boot" && v["step"] == "polling"
    })
    .await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let notified = mock.changed.notified();
            if mock
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|(m, _)| m == "getUpdates")
            {
                break;
            }
            notified.await;
        }
    })
    .await
    .unwrap();
    control.send(RuntimeControl::Pause(true)).unwrap();
    until(&mut status, |v| {
        v["type"] == "settings" && v["settings"]["paused"] == true
    })
    .await;
    tx.send(json!({"update_id":1,"message":{"message_id":1,"date":1,"chat":{"id":42,"type":"private"},"from":{"id":42,"is_bot":false,"first_name":"Ada"},"text":"AFTER_RESUME"}})).unwrap();
    until(&mut status, |v| {
        v["type"] == "poll" && v["state"] == "paused"
    })
    .await;
    let state = State::open(&database, &workspace).unwrap();
    assert_eq!(state.next_offset("100").unwrap(), 0);
    assert!(
        state
            .query("SELECT * FROM telegram_inbox", [])
            .unwrap()
            .is_empty()
    );
    control.send(RuntimeControl::Pause(false)).unwrap();
    until(&mut status, |v| {
        v["type"] == "turn" && v["state"] == "finished" && v["outcome"] == "delivered"
    })
    .await;
    assert_eq!(state.next_offset("100").unwrap(), 2);
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    server.abort();
}
#[tokio::test]
async fn cancelling_an_external_event_during_acp_startup_frees_the_route() {
    let r = Running::start_with_env("final", &[("RUNTIME_HANG_INITIALIZE_ONCE", "1")]).await;
    let socket = r.root.path().join("runtime/events.sock");
    tgfx::event_socket::event_request(
        &socket,
        &json!({"op":"emit","event":{"id":"startup","name":"test","chatId":"42"}}),
    )
    .await
    .unwrap();
    r.call(|method, _| method == "fixtureInitializeHung").await;
    r.message(1, 42, "/stop");
    r.message(2, 42, "AFTER_EVENT_START_CANCEL");
    r.call(|method, params| {
        method == "sendRichMessage" && text(params).contains("AFTER_EVENT_START_CANCEL")
    })
    .await;
    let job = tgfx::event_socket::event_request(&socket, &json!({"op":"get","id":"startup"}))
        .await
        .unwrap();
    assert_eq!(job["status"], "failed");
    r.stop().await;
}
#[tokio::test]
async fn cancelling_an_external_event_during_delivery_preserves_an_uncertain_outbox() {
    let r = Running::start("final").await;
    r.mock
        .hang_sends
        .store(true, std::sync::atomic::Ordering::Release);
    let socket = r.root.path().join("runtime/events.sock");
    tgfx::event_socket::event_request(
        &socket,
        &json!({"op":"emit","event":{"id":"delivery","name":"test","chatId":"42"}}),
    )
    .await
    .unwrap();
    r.call(|method, _| method == "sendRichMessage").await;
    r.message(1, 42, "/stop");
    r.call(|method, params| method == "sendMessage" && text(params).contains("Stopping"))
        .await;
    r.mock
        .hang_sends
        .store(false, std::sync::atomic::Ordering::Release);
    r.message(2, 42, "AFTER_EVENT_DELIVERY_CANCEL");
    r.call(|method, params| {
        method == "sendRichMessage" && text(params).contains("AFTER_EVENT_DELIVERY_CANCEL")
    })
    .await;
    assert_eq!(
        r.db()
            .query_row(
                "SELECT status FROM telegram_outbox WHERE effect_key LIKE 'external:%'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "failed"
    );
    r.stop().await;
}

#[tokio::test]
async fn shutdown_interrupts_startup_recovery_without_replaying_fx() {
    let mut r = Running::start_with_env("final", &[("RUNTIME_SEED_RECOVERY", "1")]).await;
    r.call(|method, params| method == "sendRichMessage" && text(params).contains("RECOVERY"))
        .await;
    unsafe {
        libc::kill(r.child.id().unwrap() as i32, libc::SIGTERM);
    }
    let status = tokio::time::timeout(Duration::from_secs(5), r.child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
    assert!(!r.fx().iter().any(|v| v["method"] == "session/prompt"));
    assert_eq!(
        r.db()
            .query_row(
                "SELECT status FROM telegram_outbox WHERE effect_key='pending-recovery'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "sending"
    );
    r.server.abort();
}

#[tokio::test]
async fn session_controls_reserve_order_before_delayed_telegram_ui_calls() {
    for action in ["clear", "compact"] {
        let r = Running::start("live").await;
        r.message(1, 42, "WAIT");
        let (_, draft) = r
            .call(|method, params| {
                method == "sendRichMessageDraft" && text(params).contains("WAIT_READY")
            })
            .await;
        r.message(2, 42, &format!("/{action}"));
        let confirmation = r
            .event(|event| event["event"] == "session.confirmation" && event["action"] == action)
            .await;
        r.mock
            .hold_callbacks
            .store(true, std::sync::atomic::Ordering::Release);
        r.callback(
            3,
            &format!("session:{}:confirm", confirmation["id"].as_str().unwrap()),
            confirmation["message_id"].as_i64().unwrap(),
        );
        r.call(|method, params| method == "answerCallbackQuery" && params["text"] == "Confirmed")
            .await;
        r.message(4, 42, "AFTER_HELD_CONFIRMATION");
        r.call(|method, params| {
            method == "getUpdates" && params["offset"].as_i64().is_some_and(|n| n >= 5)
        })
        .await;
        assert_ne!(
            r.db()
                .query_row(
                    "SELECT status FROM telegram_inbox WHERE update_id=4",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "discarded"
        );
        r.mock
            .hold_callbacks
            .store(false, std::sync::atomic::Ordering::Release);
        r.mock.release_callbacks.notify_one();
        if action == "compact" {
            r.updates.send(json!({"update_id":5,"stopped_message_generation":{"chat":{"id":42},"draft_id":draft["draft_id"].to_string()}})).unwrap();
        }
        r.call(|method, params| {
            method == "sendRichMessage" && text(params).contains("AFTER_HELD_CONFIRMATION")
        })
        .await;
        let prompts = r
            .fx()
            .into_iter()
            .filter(|v| v["method"] == "session/prompt")
            .filter_map(|v| {
                v["params"]["prompt"]
                    .as_array()
                    .and_then(|a| a.last())
                    .and_then(|b| b["text"].as_str())
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>();
        if action == "compact" {
            assert_eq!(prompts, vec!["WAIT", "/compact", "AFTER_HELD_CONFIRMATION"]);
        } else {
            assert_eq!(prompts, vec!["WAIT", "AFTER_HELD_CONFIRMATION"]);
        }
        r.stop().await;
    }
}
#[tokio::test]
async fn session_actions_replace_one_confirmation_in_every_output_mode() {
    for mode in ["live", "final"] {
        for (action, completed) in [("compact", "compacted"), ("clear", "cleared")] {
            let r = Running::start(mode).await;
            r.message(1, 42, &format!("/{action}"));
            let confirmation = r.event(|e| e["event"] == "session.confirmation").await;
            let card = confirmation["message_id"].as_i64().unwrap();
            r.callback(
                2,
                &format!("session:{}:confirm", confirmation["id"].as_str().unwrap()),
                card,
            );
            let (_, result) = r
                .call(|m, p| m == "editMessageText" && text(p).contains(completed))
                .await;
            assert_eq!(result["message_id"], card);
            let calls = r.mock.calls.lock().unwrap().clone();
            let sends: Vec<_> = calls
                .iter()
                .filter(|(m, _)| {
                    ["sendMessage", "sendRichMessage", "sendRichMessageDraft"].contains(&m.as_str())
                })
                .collect();
            assert_eq!(sends.len(), 1, "one card for {action} in {mode}: {sends:?}");
            let blocks = sends[0].1["rich_message"]["blocks"].as_array().unwrap();
            assert_eq!(blocks.iter().filter(|b| b["type"] == "buttons").count(), 2);
            assert!(
                blocks
                    .iter()
                    .filter(|b| b["type"] == "buttons")
                    .all(|b| b["buttons"].as_array().unwrap().len() == 1)
            );
            assert!(calls.iter().any(|(m, p)| m == "editMessageText"
                && p["message_id"] == card
                && text(p).contains(tgfx::fx::projector::LIVE_STATUS_EMOJI_ID)));
            if action == "compact" {
                assert_eq!(
                    r.fx()
                        .iter()
                        .filter(|v| v["method"] == "session/prompt")
                        .count(),
                    1
                );
            }
            r.stop().await;
        }
    }
}

fn private_session_callback(
    r: &Running,
    id: i64,
    interaction: &str,
    choice: &str,
    card: i64,
    user: i64,
) {
    r.updates.send(json!({"update_id":id,"callback_query":{
        "id":format!("cb{id}"), "from":{"id":user,"is_bot":false},
        "data":format!("session:{interaction}:{choice}"),
        "message":{"ephemeral_message_id":card,"receiver_user":{"id":42},"chat":{"id":-9,"type":"supergroup"},"message_thread_id":7}
    }})).unwrap();
}

#[tokio::test]
async fn rejected_private_model_picker_never_falls_back_to_public_message() {
    let r = Running::start("live").await;
    r.mock
        .reject_ephemeral
        .store(true, std::sync::atomic::Ordering::Release);
    r.updates
        .send(json!({"update_id":1,"message":{
            "message_id":91,"date":1,"chat":{"id":-9,"type":"supergroup"},
            "from":{"id":42,"is_bot":false},"text":"/model@fixture_bot"
        }}))
        .unwrap();
    r.event(|e| e["event"] == "update.failed").await;
    assert!(
        r.mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, p)| m.starts_with("send") && p["chat_id"] == "-9")
            .all(|(_, p)| p["ephemeral_message_parameters"]["receiver_user_id"] == 42)
    );
    r.stop().await;
}

#[tokio::test]
async fn group_model_picker_keeps_navigation_results_and_close_private() {
    for (action, expected_method) in [
        ("a.e.1", "editEphemeralMessageText"),
        ("x", "deleteEphemeralMessage"),
        ("s.0", "deleteEphemeralMessage"),
    ] {
        let r = Running::start_with_env("live", &[("RUNTIME_MODEL_SETTINGS", "1")]).await;
        let (_, commands) = r
            .call(|m, p| m == "setMyCommands" && p["scope"]["chat_id"] == "-9")
            .await;
        assert_eq!(
            commands["commands"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["command"] == "model")
                .unwrap()["is_ephemeral"],
            true
        );
        r.updates.send(json!({"update_id":1,"message":{
            "ephemeral_message_id":91,"date":1,"chat":{"id":-9,"type":"supergroup"},"message_thread_id":7,
            "from":{"id":42,"is_bot":false},"text":"/model@fixture_bot"
        }})).unwrap();
        let (_, menu) = r
            .call(|m, p| m == "sendMessage" && callback_data(p, "model:").is_some())
            .await;
        assert_eq!(menu["ephemeral_message_parameters"]["receiver_user_id"], 42);
        assert_eq!(menu["reply_parameters"]["ephemeral_message_id"], 91);
        let prefix = callback_data(&menu, "model:")
            .unwrap()
            .split(':')
            .take(2)
            .collect::<Vec<_>>()
            .join(":");
        let click = |id, user, choice: &str| {
            r.updates.send(json!({"update_id":id,"callback_query":{
            "id":format!("cb{id}"),"from":{"id":user,"is_bot":false},"data":format!("{prefix}:{choice}"),
            "message":{"ephemeral_message_id":1000,"chat":{"id":-9,"type":"supergroup"},"message_thread_id":7}
        }})).unwrap()
        };
        click(2, 43, "c.settings");
        let (_, rejected) = r
            .call(|m, p| m == "answerCallbackQuery" && p["callback_query_id"] == "cb2")
            .await;
        assert!(text(&rejected).contains("another request"));
        click(3, 42, "c.settings");
        let (_, navigation) = r.call(|m, _| m == "editEphemeralMessageText").await;
        assert_eq!(navigation["ephemeral_message_id"], 1000);
        assert_eq!(navigation["receiver_user_id"], 42);
        let before = r.mock.calls.lock().unwrap().len();
        click(4, 42, action);
        let (_, result) = r.call_after(before, |m, _| m == expected_method).await;
        assert_eq!(result["ephemeral_message_id"], 1000);
        assert_eq!(result["receiver_user_id"], 42);
        assert!(
            !r.mock
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|(m, p)| p["chat_id"] == "-9"
                    && (m == "editMessageText"
                        || m == "deleteMessage"
                        || (m == "sendMessage"
                            && p.get("ephemeral_message_parameters").is_none())))
        );
        assert_eq!(
            r.db()
                .query_row("SELECT count(*) FROM chat_history", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        r.stop().await;
    }
}

#[tokio::test]
async fn group_session_actions_stay_private_and_out_of_shared_history() {
    for (action, completed) in [("clear", "cleared"), ("compact", "compacted")] {
        let r = Running::start("live").await;
        r.updates.send(json!({"update_id":1,"message":{
            "ephemeral_message_id":91,"date":1,"chat":{"id":-9,"type":"supergroup"},"message_thread_id":7,
            "from":{"id":42,"is_bot":false},"text":format!("/{action}@fixture_bot")
        }})).unwrap();
        let c = r.event(|e| e["event"] == "session.confirmation").await;
        let card = c["message_id"].as_i64().unwrap();
        private_session_callback(&r, 2, c["id"].as_str().unwrap(), "confirm", card, 42);
        let (_, result) = r
            .call(|m, p| m == "editEphemeralMessageText" && text(p).contains(completed))
            .await;
        assert_eq!(result["ephemeral_message_id"], card);
        assert_eq!(result["receiver_user_id"], 42);
        let calls = r.mock.calls.lock().unwrap().clone();
        let sends: Vec<_> = calls
            .iter()
            .filter(|(m, p)| m.starts_with("send") && p["chat_id"] == "-9")
            .collect();
        assert_eq!(sends.len(), 1);
        assert_eq!(
            sends[0].1["ephemeral_message_parameters"]["receiver_user_id"],
            42
        );
        assert_eq!(sends[0].1["reply_parameters"]["ephemeral_message_id"], 91);
        assert!(
            !calls
                .iter()
                .any(|(m, p)| m == "editMessageText" && p["chat_id"] == "-9")
        );
        assert_eq!(
            r.db()
                .query_row("SELECT count(*) FROM chat_history", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        r.stop().await;
    }
}

#[tokio::test]
async fn only_the_requester_can_confirm_and_cancelling_deletes_the_card() {
    for chat in [42, -9] {
        let r = Running::start("live").await;
        r.message(1, chat, "/clear@fixture_bot");
        let c = r.event(|e| e["event"] == "session.confirmation").await;
        let card = c["message_id"].as_i64().unwrap();
        let route = format!("100:{chat}:0");
        let generation: i64 = r
            .db()
            .query_row(
                "SELECT generation FROM routes WHERE route_key=?",
                [&route],
                |row| row.get(0),
            )
            .unwrap();
        let before = r.mock.calls.lock().unwrap().len();
        for (id, user, choice) in [(2, 43, "confirm"), (3, 42, "cancel"), (4, 42, "confirm")] {
            let mut message =
                json!({"chat":{"id":chat,"type":if chat < 0 {"supergroup"} else {"private"}}});
            message[if chat < 0 {
                "ephemeral_message_id"
            } else {
                "message_id"
            }] = json!(card);
            r.updates.send(json!({"update_id":id,"callback_query":{
                "id":format!("cb{id}"),"from":{"id":user,"is_bot":false},
                "data":format!("session:{}:{choice}", c["id"].as_str().unwrap()),"message":message
            }})).unwrap();
            r.call(|m, p| {
                m == "answerCallbackQuery" && p["callback_query_id"] == format!("cb{id}")
            })
            .await;
        }
        let method = if chat < 0 {
            "deleteEphemeralMessage"
        } else {
            "deleteMessage"
        };
        let (_, deleted) = r.call(|m, _| m == method).await;
        assert_eq!(deleted["chat_id"], chat.to_string());
        if chat < 0 {
            assert_eq!(deleted["receiver_user_id"], 42);
            assert_eq!(deleted["ephemeral_message_id"], card);
        } else {
            assert_eq!(deleted["message_id"], card);
        }
        assert!(
            r.mock
                .calls
                .lock()
                .unwrap()
                .iter()
                .skip(before)
                .all(|(m, _)| ![
                    "sendMessage",
                    "sendRichMessage",
                    "editMessageText",
                    "editEphemeralMessageText"
                ]
                .contains(&m.as_str()))
        );
        assert!(r.fx().is_empty());
        assert_eq!(
            r.db()
                .query_row(
                    "SELECT generation FROM routes WHERE route_key=?",
                    [&route],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            generation
        );
        r.stop().await;
    }
}

#[tokio::test]
async fn rejected_private_confirmations_never_fall_back_to_public_messages() {
    let r = Running::start("live").await;
    r.mock
        .reject_ephemeral
        .store(true, std::sync::atomic::Ordering::Release);
    r.message(1, -9, "/clear@fixture_bot");
    r.event(|e| e["event"] == "update.failed").await;
    let calls = r.mock.calls.lock().unwrap().clone();
    assert!(
        calls
            .iter()
            .filter(|(m, _)| ["sendMessage", "sendRichMessage"].contains(&m.as_str()))
            .all(|(_, p)| p["ephemeral_message_parameters"]["receiver_user_id"] == 42)
    );
    assert!(r.fx().is_empty());
    r.stop().await;
}

#[tokio::test]
async fn compaction_failure_replaces_the_same_card_privately() {
    let r = Running::start_with_env("live", &[("RUNTIME_COMPACT_FAIL", "1")]).await;
    r.message(1, -9, "/compact@fixture_bot");
    let c = r.event(|e| e["event"] == "session.confirmation").await;
    r.updates.send(json!({"update_id":2,"callback_query":{
        "id":"cb2","from":{"id":42,"is_bot":false},"data":format!("session:{}:confirm", c["id"].as_str().unwrap()),
        "message":{"ephemeral_message_id":c["message_id"],"chat":{"id":-9,"type":"supergroup"}}
    }})).unwrap();
    let (_, failure) = r
        .call(|m, p| m == "editEphemeralMessageText" && text(p).contains("Could not compact"))
        .await;
    assert_eq!(failure["ephemeral_message_id"], c["message_id"]);
    r.event(|e| e["event"] == "update.failed").await;
    assert_eq!(
        r.mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| ["sendMessage", "sendRichMessage"].contains(&m.as_str()))
            .count(),
        1
    );
    r.stop().await;
}

#[tokio::test]
async fn telegram_guidance_is_a_new_session_system_prompt_without_a_resume_fallback() {
    let mut r = Running::start("final").await;
    r.message(1, 42, "FIRST_GUIDANCE_TURN");
    r.call(|m, p| m == "sendRichMessage" && text(p).contains("FIRST_GUIDANCE_TURN"))
        .await;
    let requests = r.fx();
    let initialize = requests
        .iter()
        .find(|v| v["method"] == "initialize")
        .unwrap();
    assert_eq!(initialize["params"]["_meta"]["fx"]["terminal"], false);
    let new = requests
        .iter()
        .find(|v| v["method"] == "session/new")
        .unwrap();
    assert_eq!(
        new["params"]["_meta"]["fx"]["systemPrompt"],
        json!([{"type":"text","text":tgfx::mcp::TELEGRAM_GUIDELINES}])
    );
    r.restart().await;
    r.message(2, 42, "RESUMED_GUIDANCE_TURN");
    r.call(|m, p| m == "sendRichMessage" && text(p).contains("RESUMED_GUIDANCE_TURN"))
        .await;
    let requests = r.fx();
    let load = requests
        .iter()
        .find(|v| v["method"] == "session/load")
        .unwrap();
    assert!(load["params"].get("_meta").is_none());
    assert_eq!(
        requests
            .iter()
            .filter(|v| v["method"] == "session/new")
            .count(),
        1
    );
    for p in requests.iter().filter(|v| v["method"] == "session/prompt") {
        let wire = p.to_string();
        assert!(!wire.contains("session_bootstrap"));
        assert!(!wire.contains("resource_read"));
        assert!(!wire.contains("# Telegram guidelines"));
    }
    r.stop().await;
}

#[tokio::test]
async fn usage_reports_current_context_and_survives_runtime_restart() {
    let mut r = Running::start_with_env("live", &[("RUNTIME_USAGE", "1")]).await;
    let (_, registered) = r.call(|method, _| method == "setMyCommands").await;
    let commands = registered["commands"].as_array().unwrap();
    assert!(commands.iter().any(|c| c["command"] == "usage"));
    assert!(!commands.iter().any(|c| c["command"] == "cost"));
    r.message(1, 42, "/usage");
    let (_, empty) = r
        .call(|m, p| {
            m == "sendMessage"
                && p["text"]
                    .as_str()
                    .is_some_and(|s| s.contains("not available yet"))
        })
        .await;
    assert!(empty["text"].as_str().unwrap().contains("$6.94"));
    assert!(!r.fx().iter().any(|v| v["method"] == "session/prompt"));
    r.message(2, 42, "hello");
    r.event(|v| v["event"] == "turn.delivered").await;
    let before = r.mock.calls.lock().unwrap().len();
    r.message(3, 42, "/usage");
    let (_, view) = r
        .call_after(before, |m, p| {
            m == "sendMessage" && p["text"].as_str().is_some_and(|s| s.contains("2.5%"))
        })
        .await;
    assert!(view["text"].as_str().unwrap().contains("6.4K / 256K"));
    r.restart().await;
    r.message(4, 42, "/usage");
    r.call(|m, p| m == "sendMessage" && p["text"].as_str().is_some_and(|s| s.contains("2.5%")))
        .await;
    r.stop().await;
}

#[tokio::test]
async fn usage_works_during_a_turn_even_without_billing_data() {
    for provider in ["grok", "broken"] {
        let r = Running::start_with_env(
            "live",
            &[("RUNTIME_USAGE", "1"), ("RUNTIME_USAGE_PROVIDER", provider)],
        )
        .await;
        r.message(1, 42, "WAIT");
        r.call(|m, p| m == "sendRichMessageDraft" && text(p).contains("WAIT_READY"))
            .await;
        let before = r.mock.calls.lock().unwrap().len();
        r.message(2, 42, "/usage");
        let (_, view) = r
            .call_after(before, |m, p| {
                m == "sendMessage" && p["text"].as_str().is_some_and(|s| s.contains("2.5%"))
            })
            .await;
        assert!(!view["text"].as_str().unwrap().contains("Gateway"));
        r.message(3, 42, "/stop");
        r.stop().await;
    }
}

#[tokio::test]
async fn slow_usage_replaces_its_progress_message_and_fast_usage_skips_it() {
    for (delay, provider) in [
        ("0", "ai_gateway"),
        ("800", "ai_gateway"),
        ("800", "broken"),
    ] {
        let r = Running::start_with_env(
            "live",
            &[
                ("RUNTIME_USAGE_DELAY_MS", delay),
                ("RUNTIME_USAGE_PROVIDER", provider),
            ],
        )
        .await;
        // Warm the ACP connection so only the requested calculation delay matters.
        model_menu(&r).await;
        let before = r.mock.calls.lock().unwrap().len();
        let card = r.mock.next.load(std::sync::atomic::Ordering::Acquire);
        r.message(2, 42, "/usage");
        let (method, result) = r
            .call_after(before, |m, p| {
                ["sendMessage", "editMessageText"].contains(&m)
                    && p["text"]
                        .as_str()
                        .is_some_and(|s| s.contains("Context usage"))
            })
            .await;
        let progress: Vec<_> = r
            .mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .skip(before)
            .filter(|(m, p)| {
                m == "sendMessage"
                    && p["text"]
                        .as_str()
                        .is_some_and(|s| s.contains("Calculating..."))
            })
            .cloned()
            .collect();
        if delay == "0" {
            assert!(progress.is_empty());
            assert_eq!(method, "sendMessage");
        } else {
            assert_eq!(progress.len(), 1);
            assert!(
                progress[0].1["text"]
                    .as_str()
                    .unwrap()
                    .contains(tgfx::fx::projector::LIVE_STATUS_EMOJI_ID)
            );
            assert_eq!(method, "editMessageText");
            assert_eq!(result["message_id"], card);
        }
        if provider == "broken" {
            assert!(!result["text"].as_str().unwrap().contains("Gateway"));
        }
        r.stop().await;
    }
}

#[tokio::test]
async fn group_usage_is_private_to_each_requester_and_excluded_from_shared_history() {
    let r = Running::start_with_env("live", &[("RUNTIME_USAGE_DELAY_MS", "800")]).await;
    let (_, menu) = r
        .call(|method, p| method == "setMyCommands" && p["scope"]["chat_id"] == "-9")
        .await;
    assert_eq!(
        menu["commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["command"] == "usage")
            .unwrap()["is_ephemeral"],
        true
    );
    let (_, dm_menu) = r
        .call(|method, p| method == "setMyCommands" && p["scope"]["chat_id"] == "42")
        .await;
    assert_eq!(
        dm_menu["commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["command"] == "usage")
            .unwrap()["is_ephemeral"],
        false
    );
    for (id, user, ephemeral) in [(1, 42, None), (2, 43, Some(91))] {
        let before = r.mock.calls.lock().unwrap().len();
        let mut message = json!({"date":1,"chat":{"id":-9,"type":"supergroup"},
            "message_thread_id":7,"from":{"id":user,"is_bot":false,"first_name":"Ada"},"text":"/usage@fixture_bot"});
        if let Some(ephemeral) = ephemeral {
            message["ephemeral_message_id"] = json!(ephemeral);
        } else {
            message["message_id"] = json!(id);
        }
        r.updates
            .send(json!({"update_id":id,"message":message}))
            .unwrap();
        let (_, result) = r
            .call_after(before, |method, p| {
                method == "editEphemeralMessageText"
                    && p["receiver_user_id"] == user
                    && p["text"].as_str().is_some_and(|s| s.contains("this month"))
            })
            .await;
        assert!(result.get("message_id").is_none());
        let calls = r.mock.calls.lock().unwrap();
        let progress = &calls
            .iter()
            .skip(before)
            .find(|(m, p)| m == "sendMessage" && p["chat_id"] == "-9")
            .unwrap()
            .1;
        assert_eq!(
            progress["ephemeral_message_parameters"]["receiver_user_id"],
            user
        );
        assert_eq!(progress["message_thread_id"], 7);
        assert_eq!(
            progress["reply_parameters"]["ephemeral_message_id"].as_i64(),
            ephemeral
        );
        assert!(progress["text"].as_str().unwrap().contains("Calculating"));
        assert!(
            calls
                .iter()
                .skip(before)
                .filter(|(m, p)| m.starts_with("send") && p["chat_id"] == "-9")
                .all(|(_, p)| p["ephemeral_message_parameters"]["receiver_user_id"] == user)
        );
    }
    let shared: i64 = r
        .db()
        .query_row(
            "SELECT count(*) FROM chat_history WHERE route='100:-9:7'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(shared, 0);
    assert!(!r.fx().iter().any(|v| v["method"] == "session/prompt"));
    r.stop().await;
}

#[tokio::test]
async fn private_commands_never_leak_into_group_history_or_other_command_handlers() {
    let r = Running::start("live").await;
    for (id, text, sender) in [
        (1, "/model", json!({"id":42,"is_bot":false})),
        (2, "/usage", json!({"id":42,"is_bot":true})),
    ] {
        r.updates
            .send(
                json!({"update_id":id,"message":{"ephemeral_message_id":id,"date":1,
            "chat":{"id":-9,"type":"supergroup"},"from":sender,"text":text}}),
            )
            .unwrap();
    }
    r.updates
        .send(
            json!({"update_id":3,"message":{"ephemeral_message_id":3,"date":1,
        "chat":{"id":-10,"type":"supergroup"},"from":{"id":999,"is_bot":false},"text":"/usage"}}),
        )
        .unwrap();
    r.message(4, -9, "/usage@fixture_bot extra");
    r.call(|m, p| m == "sendMessage" && p["text"] == "Usage: /usage")
        .await;
    let calls = r.mock.calls.lock().unwrap().clone();
    assert!(
        calls
            .iter()
            .filter(|(m, p)| m == "sendMessage" && p["chat_id"] == "-9")
            .all(|(_, p)| p["ephemeral_message_parameters"]["receiver_user_id"] == 42)
    );
    assert!(
        !calls
            .iter()
            .any(|(m, p)| m == "sendMessage" && p["chat_id"] == "-10")
    );
    assert_eq!(
        r.db()
            .query_row("SELECT count(*) FROM chat_history", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(r.fx().is_empty());
    r.stop().await;
}

#[tokio::test]
async fn rejected_private_usage_does_not_fall_back_to_a_public_group_reply() {
    let r = Running::start_with_env("live", &[("RUNTIME_USAGE_DELAY_MS", "800")]).await;
    r.mock
        .reject_ephemeral
        .store(true, std::sync::atomic::Ordering::Release);
    r.message(1, -9, "/usage@fixture_bot");
    r.event(|event| event["event"] == "update.failed").await;
    let calls = r.mock.calls.lock().unwrap().clone();
    let group: Vec<_> = calls
        .iter()
        .filter(|(m, p)| m.starts_with("send") && p["chat_id"] == "-9")
        .collect();
    assert!(!group.is_empty());
    assert!(
        group.iter().all(|(m, p)| m == "sendMessage"
            && p["ephemeral_message_parameters"]["receiver_user_id"] == 42)
    );
    assert!(!calls.iter().any(|(m, _)| m == "editMessageText"));
    r.stop().await;
}

fn image_message(id: i64, album: bool, kind: &str) -> Value {
    let mut message = json!({"message_id":id,"date":1,"chat":{"id":42,"type":"private"},"from":{"id":42,"first_name":"Ada"},"caption":"IMAGE_CHECK"});
    if album {
        message["media_group_id"] = json!("images");
    }
    let file = json!({"file_id":format!("image-{id}"),"file_unique_id":format!("unique-{id}"),"width":4,"height":3,"file_size":100,"mime_type":"image/png","file_name":"original.png"});
    message[kind] = if kind == "photo" { json!([file]) } else { file };
    json!({"update_id":id,"message":message})
}
fn image_prompt(r: &Running) -> Vec<Value> {
    r.fx()
        .into_iter()
        .find(|v| v["method"] == "session/prompt")
        .unwrap()["params"]["prompt"]
        .as_array()
        .unwrap()
        .clone()
}
#[tokio::test]
async fn album_previews_share_one_limit_and_keep_all_original_refs() {
    let r = Running::start("final").await;
    for id in 1..=5 {
        r.updates.send(image_message(id, true, "photo")).unwrap();
    }
    r.call(|m, _| m == "sendRichMessage").await;
    let blocks = image_prompt(&r);
    assert_eq!(
        blocks.iter().filter(|b| b["type"] == "image").count(),
        tgfx::images::MAX_INCLUDED_IMAGES
    );
    let envelope: Value = serde_json::from_str(
        blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .find(|s| s.contains("telegram_message"))
            .unwrap(),
    )
    .unwrap();
    let attachments = envelope["telegram_message"]["attachments"]
        .as_array()
        .unwrap();
    assert_eq!(attachments.len(), 5);
    assert_eq!(
        attachments
            .iter()
            .filter(|a| a["preview"]["included"] == true)
            .count(),
        tgfx::images::MAX_INCLUDED_IMAGES
    );
    assert!(attachments.iter().all(|a| a["ref"].as_str().is_some()));
    assert_eq!(
        r.mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == "getFile")
            .count(),
        tgfx::images::MAX_INCLUDED_IMAGES
    );
    r.stop().await;
}
#[tokio::test]
async fn image_preview_setting_disables_downloads_and_image_blocks() {
    let r = Running::start_with_defaults("final", &[], json!({"imagePreviews":false})).await;
    r.updates.send(image_message(1, false, "document")).unwrap();
    r.call(|m, _| m == "sendRichMessage").await;
    let blocks = image_prompt(&r);
    assert!(!blocks.iter().any(|b| b["type"] == "image"));
    assert!(
        !r.mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(m, _)| m == "getFile")
    );
    assert!(
        blocks
            .iter()
            .any(|b| b["text"].as_str().is_some_and(|s| s.contains("disabled")))
    );
    r.stop().await;
}
#[tokio::test]
async fn image_documents_include_exact_bytes_and_retain_original_files() {
    use base64::Engine;
    let r = Running::start("final").await;
    r.updates.send(image_message(1, false, "document")).unwrap();
    r.call(|m, _| m == "sendRichMessage").await;
    let blocks = image_prompt(&r);
    let image = blocks.iter().find(|b| b["type"] == "image").unwrap();
    assert_eq!(image["mimeType"], "image/png");
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(image["data"].as_str().unwrap())
            .unwrap(),
        fixture_image()
    );
    let files = r.root.path().join("home/files/100");
    let context = std::fs::read_dir(files)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let path = std::fs::read_dir(context)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(std::fs::read(path).unwrap(), fixture_image());
    r.stop().await;
}
#[tokio::test]
async fn agents_without_image_support_receive_attachment_refs_without_downloads() {
    let r = Running::start_with_env("final", &[("FX_NO_IMAGES", "1")]).await;
    r.updates.send(image_message(1, false, "photo")).unwrap();
    r.call(|m, _| m == "sendRichMessage").await;
    assert!(!image_prompt(&r).iter().any(|b| b["type"] == "image"));
    assert!(
        !r.mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(m, _)| m == "getFile")
    );
    r.stop().await;
}

#[tokio::test]
async fn clear_during_model_loading_does_not_restore_the_old_session() {
    let r = Running::start_with_env("final", &[("RUNTIME_HOLD_LOAD", "1")]).await;
    r.db().execute("INSERT INTO routes(route_key,bot_id,chat_id,topic_id,chat_kind,session_id,generation,updated_at) VALUES('100:42:0','100','42','0','private','pre-clear-session',1,'2026-01-01')", []).unwrap();
    r.message(1, 42, "/model");
    tokio::time::timeout(Duration::from_secs(10), async {
        while !r.root.path().join("fx.jsonl.loading").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    r.message(2, 42, "/clear");
    let confirmation = r.event(|e| e["event"] == "session.confirmation").await;
    let choice = format!("session:{}:confirm", confirmation["id"].as_str().unwrap());
    r.callback(3, &choice, confirmation["message_id"].as_i64().unwrap());
    r.call(|m, p| m == "editMessageText" && p.to_string().contains("Conversation cleared"))
        .await;
    let cleared: Option<String> = r
        .db()
        .query_row(
            "SELECT session_id FROM routes WHERE route_key='100:42:0'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(cleared.is_none());
    std::fs::write(r.root.path().join("fx.jsonl.resume"), "").unwrap();
    r.event(|e| e["event"] == "update.failed" || (e["type"] == "session" && e["state"] == "ready"))
        .await;
    let after: Option<String> = r
        .db()
        .query_row(
            "SELECT session_id FROM routes WHERE route_key='100:42:0'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        after.is_none(),
        "Session was resurrected after clear: {after:?}"
    );
    r.message(4, 42, "AFTER_CLEAR");
    r.call(|method, params| method == "sendRichMessage" && text(params).contains("AFTER_CLEAR"))
        .await;
    assert!(
        r.fx()
            .iter()
            .any(|request| request["method"] == "session/new")
    );
    r.stop().await;
}

#[tokio::test]
async fn editing_a_queued_album_keeps_other_photos() {
    check_queued_album_edit(2).await;
}

#[tokio::test]
async fn editing_a_secondary_album_photo_does_not_repeat_the_request() {
    check_queued_album_edit(3).await;
}

async fn check_queued_album_edit(edited_id: i64) {
    let r = Running::start("live").await;
    r.message(1, 42, "WAIT");
    r.call(|m, p| m == "sendRichMessageDraft" && p.to_string().contains("WAIT_READY"))
        .await;
    for id in [2, 3] {
        let mut photo = image_message(id, true, "photo");
        if id != edited_id {
            photo["message"].as_object_mut().unwrap().remove("caption");
        }
        r.updates.send(photo).unwrap();
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let count: i64 = r
                .db()
                .query_row(
                    "SELECT count(*) FROM telegram_inbox WHERE update_id=3 AND status='done'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            if count == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let mut edit = image_message(edited_id, true, "photo");
    edit["update_id"] = json!(4);
    let mut message = edit["message"].take();
    message["caption"] = json!("REVISED_CAPTION");
    message["edit_date"] = json!(4);
    edit.as_object_mut().unwrap().remove("message");
    edit["edited_message"] = message;
    r.updates.send(edit).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let finished = r
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e["type"] == "turn" && e["state"] == "finished")
                .count();
            if finished >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let prompts: Vec<_> = r
        .fx()
        .into_iter()
        .filter(|v| v["method"] == "session/prompt")
        .collect();
    let photo_counts: Vec<_> = prompts
        .iter()
        .filter_map(|request| {
            request["params"]["prompt"]
                .as_array()?
                .iter()
                .filter_map(|b| b["text"].as_str())
                .filter_map(|s| serde_json::from_str::<Value>(s).ok())
                .find(|v| {
                    v["telegram_message"]["attachments"]
                        .as_array()
                        .is_some_and(|a| !a.is_empty())
                })
                .map(|v| {
                    v["telegram_message"]["attachments"]
                        .as_array()
                        .unwrap()
                        .len()
                })
        })
        .collect();
    r.stop().await;
    assert_eq!(
        photo_counts,
        vec![2],
        "Editing a queued caption dropped album attachments"
    );
    assert!(prompts.iter().any(|request| {
        request["params"]["prompt"]
            .as_array()
            .unwrap()
            .iter()
            .any(|block| block["text"] == "REVISED_CAPTION")
    }));
}
