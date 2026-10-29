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
        s if s.starts_with("send") && s != "sendChatAction" && s != "sendRichMessageDraft" => {
            json!({"message_id":mock.next.fetch_add(1,std::sync::atomic::Ordering::AcqRel),"date":1,"chat":{"id":body["chat_id"].as_str().unwrap_or("42").parse::<i64>().unwrap_or(42),"type":"private"}})
        }
        _ => json!(true),
    };
    Json(json!({"ok":true,"result":result}))
}
struct Running {
    root: tempfile::TempDir,
    child: tokio::process::Child,
    updates: mpsc::UnboundedSender<Value>,
    mock: Mock,
    server: tokio::task::JoinHandle<()>,
    events: Arc<Mutex<Vec<Value>>>,
    event_changed: Arc<Notify>,
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
            release_callbacks: Arc::new(Notify::new()),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/bot100:fake/{method}", post(api))
            .route(
                "/file/bot100:fake/stickers/fixture.webp",
                get(|| async { "synthetic-sticker-bytes" }),
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
        let mut child = Command::new(env!("CARGO_BIN_EXE_tgfx"))
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
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let events = Arc::new(Mutex::new(vec![]));
        let changed = Arc::new(Notify::new());
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
        let running = Self {
            root,
            child,
            updates: tx,
            mock,
            server,
            events,
            event_changed: changed,
        };
        if !recovery {
            running
                .event(|v| v["type"] == "boot" && v["step"] == "polling")
                .await;
        }
        running
    }
    fn message(&self, id: i64, chat: i64, text: &str) {
        self.updates.send(json!({"update_id":id,"message":{"message_id":id,"date":id,"chat":{"id":chat,"type":if chat<0{"supergroup"}else{"private"}},"from":{"id":if chat>0{chat}else{42},"is_bot":false,"first_name":"Ada"},"text":text}})).unwrap();
    }
    fn callback(&self, id: i64, data: &str, card: i64) {
        self.updates.send(json!({"update_id":id,"callback_query":{"id":format!("cb{id}"),"from":{"id":42,"is_bot":false,"first_name":"Ada"},"data":data,"message":{"message_id":card,"date":1,"chat":{"id":42,"type":"private"}}}})).unwrap();
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
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let notified = self.mock.changed.notified();
                if let Some(v) = self
                    .mock
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
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
    async fn stop(mut self) {
        unsafe {
            libc::kill(self.child.id().unwrap() as i32, libc::SIGTERM);
        }
        let status = tokio::time::timeout(Duration::from_secs(10), self.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success(), "runtime exited {status}");
        self.server.abort();
    }
}
fn text(value: &Value) -> String {
    value.to_string()
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
    r.call(|m, p| m == "sendMessage" && text(p).contains("queued"))
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
    assert_eq!(std::fs::read(path).unwrap(), b"synthetic-sticker-bytes");
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
async fn nonstreaming_compaction_edits_its_visible_progress_message() {
    let r = Running::start("final").await;
    r.message(1, 42, "/compact");
    let confirmation = r
        .event(|event| event["event"] == "session.confirmation" && event["action"] == "compact")
        .await;
    r.callback(
        2,
        &format!("session:{}:confirm", confirmation["id"].as_str().unwrap()),
        confirmation["message_id"].as_i64().unwrap(),
    );
    r.call(|method, params| {
        method == "sendRichMessage" && text(params).contains("Compacting conversation")
    })
    .await;
    let (_, completed) = r
        .call(|method, params| {
            method == "editMessageText" && text(params).contains("Conversation compacted")
        })
        .await;
    r.event(|event| event["event"] == "turn.delivered").await;
    let outbox = r
        .db()
        .query_row(
            "SELECT status,telegram_message_id FROM telegram_outbox",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(outbox.0, "sent");
    assert_eq!(outbox.1, completed["message_id"].as_str().unwrap());
    assert!(
        r.fx()
            .iter()
            .filter(|v| v["method"] == "session/prompt")
            .all(|v| v["params"]["prompt"] == json!([{"type":"text","text":"/compact"}]))
    );
    r.stop().await;
}
