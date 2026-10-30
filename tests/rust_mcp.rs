use axum::{
    Json, Router,
    extract::{Path as AxumPath, State as AxumState},
    routing::{get, post},
};
use rusqlite::params;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tgfx::{
    mcp::{McpEnvironment, TelegramMcp, TelegramMcpBroker, files::*},
    state::State,
    types::now,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
#[derive(Clone, Default)]
struct Mock {
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    failed: Arc<Mutex<bool>>,
    delay_rights: Arc<std::sync::atomic::AtomicBool>,
    rights_entered: Arc<tokio::sync::Notify>,
    rights_resume: Arc<tokio::sync::Notify>,
}
async fn endpoint(
    AxumState(mock): AxumState<Mock>,
    AxumPath(method): AxumPath<String>,
    body: axum::body::Bytes,
) -> (axum::http::StatusCode, Json<Value>) {
    mock.calls.lock().unwrap().push((
        method.clone(),
        serde_json::from_slice(&body).unwrap_or(json!({"multipart":true})),
    ));
    if method == "getChatMember" && mock.delay_rights.load(std::sync::atomic::Ordering::Acquire) {
        mock.rights_entered.notify_one();
        mock.rights_resume.notified().await;
    }
    if *mock.failed.lock().unwrap() && method == "setMessageReaction" {
        return (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"ok":false,"error_code":500,"description":"unknown"})),
        );
    }
    let result = match method.as_str() {
        "getChatMember" => {
            json!({"status":"administrator","can_pin_messages":true,"can_manage_topics":true,"can_delete_messages":true,"can_restrict_members":true,"can_invite_users":true})
        }
        "getFile" => json!({"file_path":"original.png"}),
        "getStickerSet" => {
            json!({"name":"pack","title":"Pack","sticker_type":"regular","stickers":[{"file_id":"sticker-id","file_unique_id":"unique","width":512,"height":512,"emoji":"🦀"}]})
        }
        "sendPoll" => json!({"message_id":21,"poll":{"id":"poll-1"}}),
        m if m.starts_with("send") => {
            let count = mock.calls.lock().unwrap().len();
            json!({"message_id":100+count})
        }
        _ => json!(true),
    };
    (
        axum::http::StatusCode::OK,
        Json(json!({"ok":true,"result":result})),
    )
}
struct Fixture {
    _temp: tempfile::TempDir,
    state: State,
    server: TelegramMcp,
    env: McpEnvironment,
    mock: Mock,
    http: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new(group: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let home = temp.path().join("private");
        let files = home.join("files");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&files).unwrap();
        let database = home.join("test.db");
        let state = State::open(&database, &workspace).unwrap();
        let chat = if group { "-100" } else { "42" };
        let route = format!("123:{chat}:0");
        {
            let db = state.db.lock().unwrap();
            db.execute("INSERT INTO routes(route_key,bot_id,chat_id,topic_id,chat_kind,updated_at) VALUES(?, '123',?, '0',?,?)",params![route,chat,if group{"supergroup"}else{"private"},now()]).unwrap();
            db.execute("INSERT INTO context_capabilities(context_ref,bot_id,route_key,chat_id,topic_id,message_ref,message_id,attachments_json,expires_at,created_at) VALUES('ctx_test','123',?,?,'0','msg_test','1','[]','2099-01-01T00:00:00.000Z',?)",params![route,chat,now()]).unwrap();
            db.execute("INSERT INTO telegram_messages(ref,bot_id,route_key,chat_id,topic_id,message_id,owned_by_bot,created_at,expires_at) VALUES('msg_test','123',?,?,'0','1',0,?,'2099-01-01T00:00:00.000Z')",params![route,chat,now()]).unwrap();
        }
        let mock = Mock::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/bot123:TEST/{method}", post(endpoint))
            .route(
                "/file/bot123:TEST/original.png",
                get(|| async { b"original unmodified image bytes".as_slice() }),
            )
            .with_state(mock.clone());
        let http = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let env = McpEnvironment {
            token: "123:TEST".into(),
            bot_id: "123".into(),
            route_key: route,
            history_only: false,
            workspace,
            home,
            database,
            files,
            approvals_chat: "42".into(),
            approvals_topic: "0".into(),
            route_label: Some("Group".into()),
            allowed_chats: if group { vec![chat.into()] } else { vec![] },
            protected_users: vec!["99".into()],
            api_root: Some(root),
        };
        let server = TelegramMcp::new(env.clone()).await.unwrap();
        Self {
            _temp: temp,
            state,
            server,
            env,
            mock,
            http,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.http.abort()
    }
}
#[tokio::test]
async fn mcp_effects_are_deduplicated_and_uncertain_actions_are_blocked() {
    let f = Fixture::new(false).await;
    let args = json!({"emoji":"🦀"});
    let first = f
        .server
        .execute("set_reaction", args.clone())
        .await
        .unwrap();
    assert_eq!(f.server.execute("set_reaction", args).await.unwrap(), first);
    assert_eq!(
        f.mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(m, _)| m == "setMessageReaction")
            .count(),
        1
    );
    *f.mock.failed.lock().unwrap() = true;
    let uncertain = json!({"emoji":"🔥"});
    assert!(
        f.server
            .execute("set_reaction", uncertain.clone())
            .await
            .is_err()
    );
    *f.mock.failed.lock().unwrap() = false;
    assert!(
        f.server
            .execute("set_reaction", uncertain)
            .await
            .unwrap_err()
            .to_string()
            .contains("unknown outcome")
    );
}
#[tokio::test]
async fn context_expiration_revokes_actions_and_admin_catalog_is_scoped() {
    let f = Fixture::new(false).await;
    assert!(!f.server.tools().iter().any(|t| t.name == "delete_messages"));
    f.state
        .db
        .lock()
        .unwrap()
        .execute("UPDATE context_capabilities SET active=0", [])
        .unwrap();
    assert!(
        f.server
            .execute("send_sticker_by_id", json!({"file_id":"file"}))
            .await
            .unwrap_err()
            .to_string()
            .contains("expired")
    );
    let group = Fixture::new(true).await;
    assert!(
        group
            .server
            .tools()
            .iter()
            .any(|t| t.name == "delete_messages")
    );
    assert!(
        group
            .server
            .execute("pin_message", json!({"message_ref":"not-observed"}))
            .await
            .unwrap_err()
            .to_string()
            .contains("message_ref")
    );
}
#[tokio::test]
async fn media_choices_polls_and_removed_sticker_fields_work_through_http() {
    let f = Fixture::new(false).await;
    let path = f.env.workspace.join("document.txt");
    std::fs::write(&path, "content").unwrap();
    for name in ["send_file", "send_photo", "send_voice", "send_video_note"] {
        assert_eq!(
            f.server.execute(name, json!({"path":path})).await.unwrap()["sent"],
            true
        )
    }
    assert_eq!(
        f.server
            .execute("send_sticker_by_id", json!({"file_id":"sticker"}))
            .await
            .unwrap()["sent"],
        true
    );
    let pack = f
        .server
        .execute("get_sticker_pack", json!({"name":"pack"}))
        .await
        .unwrap();
    assert_eq!(pack["stickers"][0]["file_id"], "sticker-id");
    let choice = f
        .server
        .execute(
            "request_choice",
            json!({"question":"Choose","options":["A","B"]}),
        )
        .await
        .unwrap();
    assert!(
        choice["interaction_ref"]
            .as_str()
            .unwrap()
            .starts_with("interaction_")
    );
    let poll = f
        .server
        .execute(
            "create_poll",
            json!({"question":"Vote","options":["A","B"]}),
        )
        .await
        .unwrap();
    assert!(poll["poll_ref"].as_str().is_some());
    let db = f.state.db.lock().unwrap();
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM telegram_interactions WHERE state='pending'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
}
#[tokio::test]
async fn admin_action_waits_for_one_approval_then_calls_telegram() {
    let f = Fixture::new(true).await;
    let service = f.server.clone();
    let task = tokio::spawn(async move {
        service
            .execute("pin_message", json!({"message_ref":"msg_test"}))
            .await
    });
    tokio::time::timeout(Duration::from_secs(5),async{loop{let id:Option<String>={let db=f.state.db.lock().unwrap();db.query_row("SELECT interaction_id FROM telegram_interactions WHERE kind='telegram_admin:pins' AND json_extract(payload_json,'$.card.messageId') IS NOT NULL",[],|r|r.get(0)).ok()};if let Some(id)=id{f.state.db.lock().unwrap().execute("UPDATE telegram_interactions SET state='resolved',result_json='\"approve\"' WHERE interaction_id=?",[id]).unwrap();break}tokio::task::yield_now().await}}).await.unwrap();
    assert_eq!(task.await.unwrap().unwrap()["pinned"], true);
    assert!(
        f.mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(m, _)| m == "pinChatMessage")
    );
}
#[test]
fn uploads_reject_private_files_symlinks_and_non_regular_inodes() {
    let temp = tempfile::tempdir().unwrap();
    let workspace = temp.path().join("workspace");
    let private = temp.path().join("private");
    let files = private.join("files");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&files).unwrap();
    let secret = private.join("secret");
    std::fs::write(&secret, "do not send").unwrap();
    std::os::unix::fs::symlink(&secret, workspace.join("escape")).unwrap();
    assert!(read_sendable_file("escape", &workspace, &files, &private, 100).is_err());
    assert!(read_sendable_file(".", &workspace, &files, &private, 100).is_err());
    let normal = workspace.join("doc");
    std::fs::write(&normal, "ok").unwrap();
    assert_eq!(
        read_sendable_file("doc", &workspace, &files, &private, 100)
            .unwrap()
            .1,
        b"ok"
    );
}
#[test]
fn downloads_reject_symlink_context_and_sanitize_names() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("files");
    std::fs::create_dir(&root).unwrap();
    std::os::unix::fs::symlink(temp.path(), root.join("ctx_escape")).unwrap();
    assert!(safe_download_path(&root, "ctx_escape", "file").is_err());
    assert_eq!(
        safe_download_path(&root, "ctx_safe", "../../voice weird.ogg")
            .unwrap()
            .file_name()
            .unwrap(),
        "voice_weird.ogg"
    );
    assert!(safe_download_path(&root, "../escape", "file").is_err());
}
#[tokio::test]
async fn broker_requires_capability_and_revocation_disconnects_child() {
    let temp = tempfile::tempdir().unwrap();
    let broker = TelegramMcpBroker::listen(temp.path(), vec!["/bin/cat".into()])
        .await
        .unwrap();
    let lease = broker.lease(HashMap::new()).unwrap();
    let descriptor = lease.descriptor();
    assert!(
        descriptor["env"]
            .as_array()
            .unwrap()
            .iter()
            .all(|v| v["name"] != "TGFX_MCP_TOKEN")
    );
    let capability = descriptor["env"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "TGFX_MCP_CAPABILITY")
        .unwrap()["value"]
        .as_str()
        .unwrap();
    let mut connection = tokio::net::UnixStream::connect(&broker.path).await.unwrap();
    connection
        .write_all(format!("{}\nhello\n", json!({"capability":capability})).as_bytes())
        .await
        .unwrap();
    let mut reader = BufReader::new(connection);
    let mut line = String::new();
    tokio::time::timeout(Duration::from_secs(3), reader.read_line(&mut line))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(line, "hello\n");
    lease.revoke().await;
    line.clear();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), reader.read_line(&mut line))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    let mut invalid = tokio::net::UnixStream::connect(&broker.path).await.unwrap();
    invalid
        .write_all(b"{\"capability\":\"wrong\"}\n")
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), invalid.read_u8())
            .await
            .unwrap()
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::UnexpectedEof
    );
    broker.close().await.unwrap();
    assert!(!broker.path.exists());
}
#[tokio::test]
async fn official_mcp_transport_lists_tools_and_reads_recent_messages() {
    use rmcp::ServiceExt;
    let f = Fixture::new(false).await;
    let (server_io, client_io) = tokio::io::duplex(64 * 1024);
    let (read, write) = tokio::io::split(server_io);
    let server = f.server.clone();
    let task = tokio::spawn(async move {
        server
            .serve((read, write))
            .await
            .unwrap()
            .waiting()
            .await
            .unwrap()
    });
    let (read, mut write) = tokio::io::split(client_io);
    let mut read = BufReader::new(read);
    async fn exchange(
        read: &mut BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>,
        write: &mut tokio::io::WriteHalf<tokio::io::DuplexStream>,
        request: Value,
    ) -> Value {
        write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        let id = request["id"].clone();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let mut line = String::new();
                assert!(read.read_line(&mut line).await.unwrap() > 0);
                let response: Value = serde_json::from_str(&line).unwrap();
                if response["id"] == id {
                    return response;
                }
            }
        })
        .await
        .unwrap()
    }
    let initialized=exchange(&mut read,&mut write,json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"tgfx-test","version":"1"}}})).await;
    assert_eq!(initialized["result"]["serverInfo"]["name"], "tgfx-telegram");
    write
        .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
        .await
        .unwrap();
    let tools = exchange(
        &mut read,
        &mut write,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
    )
    .await;
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 13);
    let result=exchange(&mut read,&mut write,json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"set_reaction","arguments":{"emoji":"🦀"}}})).await;
    assert_eq!(result["result"]["structuredContent"]["reacted"], true);
    assert!(
        initialized["result"]["capabilities"]
            .get("resources")
            .is_none()
    );
    let recent=exchange(&mut read,&mut write,json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_recent_messages","arguments":{}}})).await;
    assert_eq!(
        recent["result"]["structuredContent"]["chat_recent"]["messages"][0]["ref"],
        "msg_test"
    );
    drop(write);
    drop(read);
    task.abort();
}
#[tokio::test]
async fn recent_messages_are_live_scoped_and_require_an_active_context() {
    let f = Fixture::new(false).await;
    {
        let db = f.state.db.lock().unwrap();
        for (reference, route, chat, expiry) in [
            ("wrong-route", "123:-100:0", "-100", "2099-01-01T00:00:00Z"),
            ("expired", "123:42:0", "42", "2000-01-01T00:00:00Z"),
        ] {
            db.execute("INSERT INTO telegram_messages(ref,bot_id,route_key,chat_id,topic_id,message_id,owned_by_bot,created_at,expires_at) VALUES(?,'123',?,?,'0','2',0,?,?)",params![reference,route,chat,now(),expiry]).unwrap();
        }
    }
    let recent = f
        .server
        .execute("get_recent_messages", json!({}))
        .await
        .unwrap();
    assert_eq!(
        recent["chat_recent"]["messages"].as_array().unwrap().len(),
        1
    );
    assert_eq!(recent["chat_recent"]["messages"][0]["ref"], "msg_test");
    assert!(
        f.server
            .execute("get_recent_messages", json!({"chat_id":"-100"}))
            .await
            .is_err()
    );
    f.state
        .db
        .lock()
        .unwrap()
        .execute("UPDATE context_capabilities SET active=0", [])
        .unwrap();
    assert!(
        f.server
            .execute("get_recent_messages", json!({}))
            .await
            .is_err()
    );
    assert!(f.mock.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn malformed_arguments_are_rejected_before_action_ledger() {
    let f = Fixture::new(false).await;
    for args in [
        json!({"question":"Hello","options":["only one"]}),
        json!({"question":"Hello","options":["A","B"],"chat_id":"elsewhere"}),
    ] {
        assert!(f.server.execute("request_choice", args).await.is_err())
    }
    let count: i64 = f
        .state
        .db
        .lock()
        .unwrap()
        .query_row("SELECT count(*) FROM effect_ledger", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    assert!(f.mock.calls.lock().unwrap().is_empty());
}
#[tokio::test]
async fn later_turn_history_contains_tool_messages_and_bulletin_edits() {
    let f = Fixture::new(true).await;
    f.state
        .history
        .snapshot(&f.env.route_key, "ctx_test")
        .unwrap();
    f.server
        .execute(
            "request_choice",
            json!({"question":"Pick the release date","options":["Monday","Tuesday"]}),
        )
        .await
        .unwrap();
    let path = f.env.workspace.join("report.txt");
    std::fs::write(&path, "report").unwrap();
    f.server
        .execute(
            "send_file",
            json!({"path":path,"caption":"Release report caption"}),
        )
        .await
        .unwrap();
    for text in ["Initial bulletin", "Updated release bulletin"] {
        let server = f.server.clone();
        let task = tokio::spawn(async move {
            server
                .execute("set_pinned_message", json!({"text":text}))
                .await
        });
        tokio::time::timeout(Duration::from_secs(5),async{loop{let resolved=f.state.db.lock().unwrap().execute("UPDATE telegram_interactions SET state='resolved',result_json='\"approve\"' WHERE kind='telegram_admin:pins' AND state='pending' AND json_extract(payload_json,'$.card.messageId') IS NOT NULL",[]).unwrap();if resolved>0{break}tokio::task::yield_now().await}}).await.unwrap();
        task.await.unwrap().unwrap();
    }
    let old = f.server.execute("read_history", json!({})).await.unwrap();
    assert!(old["messages"].as_array().unwrap().is_empty());
    f.state
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE context_capabilities SET context_ref='ctx_later' WHERE context_ref='ctx_test'",
            [],
        )
        .unwrap();
    f.state
        .history
        .snapshot(&f.env.route_key, "ctx_later")
        .unwrap();
    let later = f.server.execute("read_history", json!({})).await.unwrap();
    let texts = later["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["text"].as_str())
        .collect::<Vec<_>>();
    assert!(texts.contains(&"Pick the release date"));
    assert!(texts.contains(&"Release report caption"));
    assert!(texts.contains(&"Updated release bulletin"));
    assert!(!texts.contains(&"Initial bulletin"));
}
#[tokio::test]
async fn oversized_streamed_download_removes_partial_file() {
    use axum::routing::get;
    let router = Router::new().route(
        "/bytes",
        get(|| async {
            axum::body::Body::from_stream(futures::stream::iter([
                Ok::<_, std::convert::Infallible>(axum::body::Bytes::from_static(b"12345")),
                Ok(axum::body::Bytes::from_static(b"67890")),
            ]))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/bytes", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("partial");
    let response = reqwest::get(url).await.unwrap();
    assert!(write_response_limited(response, &path, 6).await.is_err());
    assert!(!path.exists());
    server.abort();
}
#[tokio::test]
async fn shared_download_permissions_survive_restrictive_umask() {
    use std::os::unix::fs::PermissionsExt;
    if std::env::var("TGFX_TEST_SHARED_FIXTURE").as_deref() != Ok("1") {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "shared_download_permissions_survive_restrictive_umask",
                "--nocapture",
            ])
            .env("TGFX_TEST_SHARED_FIXTURE", "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    unsafe {
        libc::umask(0o077);
    }
    let temp = tempfile::tempdir().unwrap();
    let shared_root = temp.path().join("downloads");
    std::fs::create_dir(&shared_root).unwrap();
    std::fs::set_permissions(&shared_root, std::fs::Permissions::from_mode(0o2750)).unwrap();
    let root = shared_root.join("100");
    let path = safe_download_path(&root, "ctx_shared", "file").unwrap();
    let parent = path.parent().unwrap();
    assert_eq!(
        std::fs::metadata(&root).unwrap().permissions().mode() & 0o7777,
        0o2750
    );
    assert_eq!(
        std::fs::metadata(parent).unwrap().permissions().mode() & 0o7777,
        0o2750
    );
    let preview = temporary_download_directory(&root, "preview-").unwrap();
    assert!(preview.path().starts_with(root.canonicalize().unwrap()));
    assert_eq!(
        std::fs::metadata(preview.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o2750
    );
    let private_root = temp.path().join("private");
    let private_file = safe_download_path(&private_root, "ctx_private", "file").unwrap();
    assert_eq!(
        std::fs::metadata(private_file.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o700
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/file", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/file", axum::routing::get(|| async { "voice" })),
        )
        .await
        .unwrap()
    });
    write_response_limited(reqwest::get(&url).await.unwrap(), &path, 100)
        .await
        .unwrap();
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o640
    );
    write_response_limited(reqwest::get(url).await.unwrap(), &private_file, 100)
        .await
        .unwrap();
    assert_eq!(
        std::fs::metadata(&private_file)
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    server.abort();
}
#[tokio::test]
async fn delayed_admin_rights_cannot_adopt_a_replacement_turn_context() {
    let f = Fixture::new(true).await;
    f.mock
        .delay_rights
        .store(true, std::sync::atomic::Ordering::Release);
    let server = f.server.clone();
    let action = tokio::spawn(async move {
        server
            .execute("pin_message", json!({"message_ref":"msg_test"}))
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), f.mock.rights_entered.notified())
        .await
        .unwrap();
    f.state.db.lock().unwrap().execute("UPDATE context_capabilities SET context_ref='ctx_replacement' WHERE context_ref='ctx_test'",[]).unwrap();
    f.mock.rights_resume.notify_one();
    let error = tokio::time::timeout(Duration::from_secs(3), action)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(error.to_string().contains("expired"));
    assert!(
        !f.mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(m, _)| m == "sendMessage" || m == "pinChatMessage")
    );
    let count: i64 = f
        .state
        .db
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM telegram_interactions WHERE kind='telegram_admin:pins'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}
#[tokio::test]
async fn native_cli_mcp_proxy_stays_alive_through_discovery() {
    check_native_proxy(false).await;
}
#[tokio::test]
async fn native_cli_mcp_proxy_supports_fx_stateless_discovery() {
    check_native_proxy(true).await;
}
async fn check_native_proxy(modern: bool) {
    let f = Fixture::new(false).await;
    let socket_dir = tempfile::Builder::new()
        .prefix("tmcp-")
        .tempdir_in("/tmp")
        .unwrap();
    let broker = TelegramMcpBroker::listen(
        socket_dir.path(),
        vec![env!("CARGO_BIN_EXE_tgfx").into(), "mcp".into()],
    )
    .await
    .unwrap();
    let env = HashMap::from([
        ("TGFX_MCP_TOKEN".into(), f.env.token.clone()),
        ("TGFX_MCP_BOT_ID".into(), f.env.bot_id.clone()),
        ("TGFX_MCP_ROUTE_KEY".into(), f.env.route_key.clone()),
        (
            "TGFX_MCP_WORKSPACE".into(),
            f.env.workspace.to_string_lossy().into_owned(),
        ),
        (
            "TGFX_MCP_HOME".into(),
            f.env.home.to_string_lossy().into_owned(),
        ),
        (
            "TGFX_MCP_DATABASE".into(),
            f.env.database.to_string_lossy().into_owned(),
        ),
        (
            "TGFX_MCP_FILES".into(),
            f.env.files.to_string_lossy().into_owned(),
        ),
        (
            "TGFX_MCP_APPROVALS_CHAT".into(),
            f.env.approvals_chat.clone(),
        ),
        (
            "TGFX_INTERNAL_TELEGRAM_API_ROOT".into(),
            f.env.api_root.clone().unwrap(),
        ),
    ]);
    let lease = broker.lease(env).unwrap();
    let descriptor = lease.descriptor();
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_tgfx"));
    command
        .arg("mcp-proxy")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for value in descriptor["env"].as_array().unwrap() {
        command.env(
            value["name"].as_str().unwrap(),
            value["value"].as_str().unwrap(),
        );
    }
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    async fn rpc(
        stdin: &mut tokio::process::ChildStdin,
        stdout: &mut BufReader<tokio::process::ChildStdout>,
        request: Value,
    ) -> Value {
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .unwrap();
        stdin.flush().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let mut line = String::new();
                assert!(
                    stdout.read_line(&mut line).await.unwrap() > 0,
                    "MCP proxy closed before reply"
                );
                let response: Value = serde_json::from_str(&line).unwrap();
                if response["id"] == request["id"] {
                    return response;
                }
            }
        })
        .await
        .unwrap()
    }
    let metadata = json!({"progressToken":1,"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"fx","version":"0.0.15"}});
    let discovery = rpc(
        &mut stdin,
        &mut stdout,
        json!({"jsonrpc":"2.0","id":0,"method":"server/discover","params":{"_meta":metadata}}),
    )
    .await;
    assert!(
        discovery["result"]["supportedVersions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "2026-07-28")
    );
    if !modern {
        let initialized=rpc(&mut stdin,&mut stdout,json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"native-test","version":"1"}}})).await;
        assert_eq!(initialized["result"]["serverInfo"]["name"], "tgfx-telegram");
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n")
            .await
            .unwrap();
    }
    let parameters = if modern {
        json!({"_meta":metadata})
    } else {
        json!({})
    };
    let tools = rpc(
        &mut stdin,
        &mut stdout,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":parameters}),
    )
    .await;
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 13);
    assert!(child.try_wait().unwrap().is_none());
    let mut call = json!({"name":"set_reaction","arguments":{"emoji":"🦀"}});
    if modern {
        call["_meta"] = metadata;
    }
    let result = rpc(
        &mut stdin,
        &mut stdout,
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":call}),
    )
    .await;
    assert_eq!(result["result"]["structuredContent"]["reacted"], true);
    lease.revoke().await;
    let status = tokio::time::timeout(Duration::from_secs(3), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success());
    broker.close().await.unwrap();
}

#[tokio::test]
async fn original_attachments_remain_downloadable_without_a_preview() {
    let f = Fixture::new(false).await;
    let attachments = json!([{"ref":"att_original","kind":"document","fileId":"original-file","fileUniqueId":"original","mimeType":"image/png","name":"original.png"}]);
    f.state
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE context_capabilities SET attachments_json=?",
            [attachments.to_string()],
        )
        .unwrap();
    let result = f
        .server
        .execute(
            "download_attachment",
            json!({"attachment_ref":"att_original"}),
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(result["path"].as_str().unwrap()).unwrap(),
        b"original unmodified image bytes"
    );
    assert!(
        f.mock
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|(m, p)| m == "getFile" && p["file_id"] == "original-file")
    );
}

#[tokio::test]
async fn distinct_attachments_with_the_same_filename_download_separately() {
    let f = Fixture::new(false).await;
    let attachments = json!([
        {"ref":"att_one","kind":"document","fileId":"file-one","fileUniqueId":"one","name":"report.pdf"},
        {"ref":"att_two","kind":"document","fileId":"file-two","fileUniqueId":"two","name":"report.pdf"}
    ]);
    f.state
        .db
        .lock()
        .unwrap()
        .execute(
            "UPDATE context_capabilities SET attachments_json=?",
            [attachments.to_string()],
        )
        .unwrap();
    let first = f
        .server
        .execute("download_attachment", json!({"attachment_ref":"att_one"}))
        .await
        .unwrap();
    let second = f
        .server
        .execute("download_attachment", json!({"attachment_ref":"att_two"}))
        .await
        .unwrap();
    assert_ne!(first["path"], second["path"]);
    for result in [first, second] {
        assert_eq!(
            std::fs::read(result["path"].as_str().unwrap()).unwrap(),
            b"original unmodified image bytes"
        );
    }
}

#[tokio::test]
async fn whisper_history_capability_cannot_act_or_read_other_conversations() {
    let f = Fixture::new(true).await;
    let public = tgfx::types::Route::new("123", "-100", "0", "supergroup");
    let private = public.whisper(42);
    let other = tgfx::types::Route::new("123", "-200", "0", "supergroup");
    f.state.ensure_route(&private).unwrap();
    for id in 1..=6 {
        f.state
            .history
            .record_bot(&public.key, &id.to_string(), Some(&format!("PUBLIC_{id}")))
            .unwrap();
    }
    f.state
        .history
        .record_bot(&private.key, "1", Some("PRIVATE_SECRET"))
        .unwrap();
    f.state
        .history
        .record_bot(&other.key, "1", Some("OTHER_GROUP_SECRET"))
        .unwrap();
    f.state
        .register_event_context(&private, "whisper_context")
        .unwrap();
    f.state
        .history
        .snapshot_from(&private.key, &public.key, "whisper_context")
        .unwrap();
    f.state
        .history
        .record_bot(&public.key, "7", Some("AFTER_SNAPSHOT"))
        .unwrap();
    let mut env = f.env.clone();
    env.route_key = private.key.clone();
    env.history_only = true;
    let calls = f.mock.calls.lock().unwrap().len();
    let server = TelegramMcp::new(env).await.unwrap();
    assert_eq!(
        server
            .tools()
            .iter()
            .map(|t| t.name.as_ref())
            .collect::<Vec<_>>(),
        vec!["read_history"]
    );
    let result = server
        .execute("read_history", json!({"limit":2}))
        .await
        .unwrap();
    let visible = result.to_string();
    assert!(visible.contains("PUBLIC_6"));
    assert!(!visible.contains("PRIVATE_SECRET"));
    assert!(!visible.contains("OTHER_GROUP_SECRET"));
    assert!(!visible.contains("AFTER_SNAPSHOT"));
    let older = server
        .execute(
            "read_history",
            json!({"cursor":result["older_cursor"],"limit":2}),
        )
        .await
        .unwrap();
    assert!(older.to_string().contains("PUBLIC_4"));
    assert!(
        server
            .execute("read_history", json!({"route":other.key}))
            .await
            .is_err()
    );
    for tool in [
        "send_message",
        "set_reaction",
        "download_attachment",
        "ask_question",
    ] {
        assert!(server.execute(tool, json!({})).await.is_err());
    }
    assert_eq!(f.mock.calls.lock().unwrap().len(), calls);
    f.state
        .deactivate_context(&private.key, "whisper_context")
        .unwrap();
    assert!(server.execute("read_history", json!({})).await.is_err());
}
