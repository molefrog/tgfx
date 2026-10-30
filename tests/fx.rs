use serde_json::json;
use tgfx::{
    fx::{FxEvent, FxOptions, FxSession, Projector},
    memory::SessionMemory,
    types::{MemoryOptions, OutputMode},
};
use tokio::sync::mpsc;
fn options(root: &std::path::Path) -> FxOptions {
    use std::os::unix::fs::PermissionsExt;
    let wrapper = root.join("fx-fixture");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexec python3 '{}' \"$@\"\n",
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/support/fx_fixture.py")
                .display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    FxOptions {
        binary: wrapper.to_string_lossy().into_owned(),
        cwd: root.into(),
        saved_session: None,
        model: None,
        permission_mode: "auto".into(),
        mcp_servers: vec![],
        memory: MemoryOptions::default(),
    }
}
async fn wait_ready(rx: &mut mpsc::UnboundedReceiver<FxEvent>) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(FxEvent::Update(v)) = rx.recv().await
                && v["update"]["content"]["text"] == "WAIT_READY"
            {
                break;
            }
        }
    })
    .await
    .unwrap()
}
async fn echoed_prompt(session: &FxSession) -> serde_json::Value {
    let (tx, mut rx) = mpsc::unbounded_channel();
    session
        .prompt(vec![json!({"type":"text","text":"BLOCKS"})], tx)
        .await
        .unwrap();
    let mut text = String::new();
    while let Some(FxEvent::Update(v)) = rx.recv().await {
        if v["update"]["sessionUpdate"] == "agent_message_chunk" {
            text.push_str(v["update"]["content"]["text"].as_str().unwrap());
        }
    }
    serde_json::from_str(&text).unwrap()
}
#[tokio::test]
async fn cancelled_and_failed_prompts_do_not_advance_the_memory_cursor() {
    for request in ["WAIT", "MAX"] {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("MEMORY.md"), "# Rule\nKeep this fact.").unwrap();
        let session = FxSession::start(options(root.path())).await.unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let running = session.clone();
        let task = tokio::spawn(async move {
            running
                .prompt(vec![json!({"type":"text","text":request})], tx)
                .await
        });
        if request == "WAIT" {
            wait_ready(&mut rx).await;
            session.cancel().await.unwrap();
            assert_eq!(task.await.unwrap().unwrap()["stopReason"], "cancelled");
        } else {
            assert!(task.await.unwrap().is_err());
        }
        assert!(
            echoed_prompt(&session).await[0]["text"]
                .as_str()
                .unwrap()
                .starts_with("<memory ")
        );
        session.close().await.unwrap();
    }
}
#[tokio::test]
async fn steering_leaves_memory_updates_for_the_next_ordinary_turn() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("MEMORY.md");
    std::fs::write(&path, "# Rule\nFirst fact.").unwrap();
    let session = FxSession::start(options(root.path())).await.unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let running = session.clone();
    let task = tokio::spawn(async move {
        running
            .prompt(vec![json!({"type":"text","text":"WAIT"})], tx)
            .await
    });
    wait_ready(&mut rx).await;
    std::fs::write(&path, "# Rule\nFirst fact.\n\n# Added\nSecond fact.").unwrap();
    session
        .steer(vec![json!({"type":"text","text":"BLOCKS"})])
        .await
        .unwrap();
    task.await.unwrap().unwrap();
    let mut text = String::new();
    while let Some(FxEvent::Update(v)) = rx.recv().await {
        if v["update"]["sessionUpdate"] == "agent_message_chunk" {
            text.push_str(v["update"]["content"]["text"].as_str().unwrap());
        }
    }
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&text).unwrap(),
        json!([{"type":"text","text":"BLOCKS"}])
    );
    let next = echoed_prompt(&session).await;
    let update = next[0]["text"].as_str().unwrap();
    assert!(update.contains("action=\"append\""));
    assert!(update.contains("Second fact."));
    assert!(!update.contains("First fact."));
    session.close().await.unwrap();
}
#[tokio::test]
async fn official_acp_reloads_and_retains_unknown_envelopes() {
    let root = tempfile::tempdir().unwrap();
    let mut opts = options(root.path());
    opts.saved_session = Some("missing".into());
    let session = FxSession::start(opts.clone()).await.unwrap();
    assert!(session.replaced_previous());
    assert_eq!(session.session_id(), "fixture");
    let (tx, mut rx) = mpsc::unbounded_channel();
    assert_eq!(
        session
            .prompt(vec![json!({"type":"text","text":"HELLO"})], tx)
            .await
            .unwrap()["stopReason"],
        "end_turn"
    );
    let mut updates = vec![];
    while let Ok(FxEvent::Update(v)) = rx.try_recv() {
        updates.push(v);
    }
    assert!(
        updates
            .iter()
            .any(|v| v["update"]["sessionUpdate"] == "fixture_future_update")
    );
    assert!(updates.iter().any(|v| v["update"]["name"] == "read_file"));
    assert!(
        updates
            .iter()
            .any(|v| v["update"]["_meta"]["fx"]["retained"] == true)
    );
    assert_eq!(
        session.set_config_option("model", "next").await.unwrap()[0]["currentValue"],
        "next"
    );
    session.close().await.unwrap();
    assert!(!session.usable());
    opts.saved_session = Some("fixture".into());
    let resumed = FxSession::start(opts).await.unwrap();
    assert!(!resumed.replaced_previous());
    resumed.close().await.unwrap();
}
#[tokio::test]
async fn cancel_and_steer_remain_responsive_during_prompt() {
    for steering in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let session = FxSession::start(options(root.path())).await.unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let running = session.clone();
        let task = tokio::spawn(async move {
            running
                .prompt(vec![json!({"type":"text","text":"WAIT"})], tx)
                .await
        });
        wait_ready(&mut rx).await;
        if steering {
            session
                .steer(vec![json!({"type":"text","text":"FOLLOW UP"})])
                .await
                .unwrap();
        } else {
            session.cancel().await.unwrap();
        }
        let result = tokio::time::timeout(std::time::Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            result["stopReason"],
            if steering { "end_turn" } else { "cancelled" }
        );
        session.close().await.unwrap();
    }
}
#[tokio::test]
async fn dropped_permission_receiver_rejects_without_deadlock() {
    let root = tempfile::tempdir().unwrap();
    let session = FxSession::start(options(root.path())).await.unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let running = session.clone();
    let task = tokio::spawn(async move {
        running
            .prompt(vec![json!({"type":"text","text":"PERMISSION"})], tx)
            .await
    });
    let request = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(FxEvent::Permission { request, respond }) = rx.recv().await {
                drop(respond);
                break request;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(request["options"][0]["kind"], "reject_once");
    task.await.unwrap().unwrap();
    session.close().await.unwrap();
}
#[tokio::test]
async fn cancelling_pending_permission_rejects_it() {
    let root = tempfile::tempdir().unwrap();
    let session = FxSession::start(options(root.path())).await.unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let running = session.clone();
    let task = tokio::spawn(async move {
        running
            .prompt(vec![json!({"type":"text","text":"PERMISSION"})], tx)
            .await
    });
    let held = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(FxEvent::Permission { respond, .. }) = rx.recv().await {
                break respond;
            }
        }
    })
    .await
    .unwrap();
    session.cancel().await.unwrap();
    task.await.unwrap().unwrap();
    assert!(
        held.send(json!({"outcome":{"outcome":"selected","optionId":"allow"}}))
            .is_err()
    );
    session.close().await.unwrap();
}
#[tokio::test]
async fn crash_and_limits_surface_as_errors() {
    for text in ["CRASH", "MAX"] {
        let root = tempfile::tempdir().unwrap();
        let session = FxSession::start(options(root.path())).await.unwrap();
        let (tx, _) = mpsc::unbounded_channel();
        let result = session
            .prompt(vec![json!({"type":"text","text":text})], tx)
            .await;
        assert!(result.is_err(), "{text}");
        session.close().await.unwrap();
    }
}
#[tokio::test]
async fn cli_preflight_and_usage_use_real_subprocess() {
    let root = tempfile::tempdir().unwrap();
    let opts = options(root.path());
    let inspect = tgfx::fx::preflight::inspect(&opts.binary, root.path())
        .await
        .unwrap();
    assert_eq!(inspect["version"], "0.0.15");
    let usage = tgfx::fx::usage::read(&opts.binary, root.path())
        .await
        .unwrap();
    assert_eq!(usage["kind"], "usage");
    assert!(tgfx::fx::usage::parse_usage("{}").is_err());
}
#[test]
fn preflight_requires_fx_0_0_15_or_newer() {
    use tgfx::fx::preflight::assert_supported_version;
    for version in ["0.0.8", "0.0.14"] {
        let error = assert_supported_version(version).unwrap_err();
        assert!(error.to_string().contains("0.0.15"));
    }
    for version in ["0.0.15", "v0.0.15-dev", "0.1.0"] {
        assert_supported_version(version).unwrap();
    }
}
#[test]
fn memory_is_transactional_and_handles_additions_edits_and_compaction() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("MEMORY.md");
    std::fs::write(&path, "# Rules\nBe clear <ok>\n").unwrap();
    let mut memory = SessionMemory::new(root.path(), MemoryOptions::default()).unwrap();
    let initial = memory.prepare().unwrap();
    assert!(
        initial.block.as_ref().unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("<memory source=")
    );
    assert!(
        initial.block.as_ref().unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("&lt;ok&gt;")
    );
    assert!(memory.prepare().unwrap().block.is_some());
    memory.commit(initial);
    assert!(memory.prepare().unwrap().block.is_none());
    std::fs::write(&path, "# Rules\nBe clear <ok>\n\n# New\nHello\n").unwrap();
    let added = memory.prepare().unwrap();
    let text = added.block.as_ref().unwrap()["text"].as_str().unwrap();
    assert!(text.contains("action=\"append\""));
    assert!(!text.contains("Be clear"));
    memory.commit(added);
    std::fs::write(&path, "# Rules\nChanged\n").unwrap();
    let changed = memory.prepare().unwrap();
    assert!(
        changed.block.as_ref().unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("action=\"reread\"")
    );
    memory.commit(changed);
    memory.reset();
    assert!(
        memory.prepare().unwrap().block.as_ref().unwrap()["text"]
            .as_str()
            .unwrap()
            .starts_with("<memory ")
    );
}
#[cfg(unix)]
#[test]
fn memory_refuses_symlinks_outside_root_and_special_files() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    symlink(outside.path(), root.path().join("MEMORY.md")).unwrap();
    assert!(
        SessionMemory::new(root.path(), MemoryOptions::default())
            .unwrap()
            .prepare()
            .is_err()
    );
    assert!(
        SessionMemory::new(
            root.path(),
            MemoryOptions {
                enabled: true,
                file: "../outside".into()
            }
        )
        .is_err()
    );
}
#[test]
fn projector_selects_final_answer_and_never_reopens_finished_tools() {
    let mut p = Projector::new();
    for v in [
        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Let me look"}}),
        json!({"sessionUpdate":"tool_call","toolCallId":"a","name":"read_file","kind":"read","title":"Read","status":"completed","rawInput":{"path":"file.txt"}}),
        json!({"sessionUpdate":"tool_call_update","toolCallId":"a","status":"in_progress"}),
        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Final **answer**"}}),
    ] {
        p.apply(&v);
    }
    assert_eq!(p.tool_states()[0].status, "completed");
    assert_eq!(p.plain_final(OutputMode::Final), "Final **answer**");
    let live = p.rich(OutputMode::Detailed, true);
    assert!(
        live["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["type"] == "details"
                && b["summary"].as_str().unwrap_or("").contains("Read 1 file"))
    );
    assert!(
        !p.rich(OutputMode::Final, true)
            .to_string()
            .contains("Let me look")
    );
}
#[test]
fn projector_suppresses_bootstrap_and_filters_diagnostics() {
    let mut p = Projector::new();
    p.apply(&json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Reading guidelines now"}}));
    p.apply(&json!({"sessionUpdate":"tool_call","toolCallId":"g","name":"mcp_features","status":"completed","rawInput":{"uri":"telegram://guidelines"}}));
    p.apply(&json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello\n[context] internal warning"}}));
    let rich = p.rich(OutputMode::Detailed, true).to_string();
    assert!(!rich.contains("Reading guidelines now"));
    assert!(!rich.contains("internal warning"));
    assert!(rich.contains("Hello"));
}
#[test]
fn memory_markdown_sections_ignore_quoted_and_fenced_headings() {
    let source = "Preamble\n\n# One\nText\n\n```\n# fake\n```\n\n> # quoted\n\nTwo\n===\nFinal\n";
    let parts = tgfx::memory::sections(source);
    assert_eq!(parts.len(), 3);
    assert_eq!(parts[1].heading.as_deref(), Some("One"));
    assert_eq!(parts[2].heading.as_deref(), Some("Two"));
}

#[tokio::test]
async fn cancel_terminates_agent_that_ignores_it() {
    let root = tempfile::tempdir().unwrap();
    let session = FxSession::start(options(root.path())).await.unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let running = session.clone();
    let task = tokio::spawn(async move {
        running
            .prompt(vec![json!({"type":"text","text":"IGNORE_CANCEL"})], tx)
            .await
    });
    wait_ready(&mut rx).await;
    session.cancel().await.unwrap();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(4), task)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(!session.usable());
    session.close().await.unwrap();
}
#[tokio::test]
async fn invalid_permission_selection_fails_closed() {
    let root = tempfile::tempdir().unwrap();
    let session = FxSession::start(options(root.path())).await.unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let running = session.clone();
    let task = tokio::spawn(async move {
        running
            .prompt(vec![json!({"type":"text","text":"PERMISSION"})], tx)
            .await
    });
    let mut text = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            FxEvent::Permission { respond, .. } => respond
                .send(json!({"outcome":{"outcome":"selected","optionId":"forged"}}))
                .unwrap(),
            FxEvent::Update(v) => {
                if let Some(t) = v["update"]["content"]["text"].as_str() {
                    text.push_str(t)
                }
            }
        }
    }
    task.await.unwrap().unwrap();
    assert!(text.contains("reject"));
    session.close().await.unwrap();
}
#[tokio::test]
async fn session_memory_is_reinjected_after_compaction() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("MEMORY.md"), "# Rule\nA clear rule\n").unwrap();
    let session = FxSession::start(options(root.path())).await.unwrap();
    for expected in [true, false] {
        let (tx, mut rx) = mpsc::unbounded_channel();
        session
            .prompt(vec![json!({"type":"text","text":"BLOCKS"})], tx)
            .await
            .unwrap();
        let mut text = String::new();
        while let Some(FxEvent::Update(v)) = rx.recv().await {
            if let Some(t) = v["update"]["content"]["text"].as_str() {
                text.push_str(t)
            }
        }
        assert_eq!(text.contains("<memory "), expected);
    }
    let (tx, _) = mpsc::unbounded_channel();
    session
        .prompt(vec![json!({"type":"text","text":"/compact"})], tx)
        .await
        .unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    session
        .prompt(vec![json!({"type":"text","text":"BLOCKS"})], tx)
        .await
        .unwrap();
    let mut text = String::new();
    while let Some(FxEvent::Update(v)) = rx.recv().await {
        if let Some(t) = v["update"]["content"]["text"].as_str() {
            text.push_str(t)
        }
    }
    assert!(text.contains("<memory "));
    session.close().await.unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn closing_session_terminates_descendants() {
    let root = tempfile::tempdir().unwrap();
    let session = FxSession::start(options(root.path())).await.unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    session
        .prompt(vec![json!({"type":"text","text":"CHILD"})], tx)
        .await
        .unwrap();
    let mut pid = 0;
    while let Ok(FxEvent::Update(v)) = rx.try_recv() {
        if let Some(t) = v["update"]["content"]["text"].as_str() {
            pid = t.parse::<i32>().unwrap()
        }
    }
    assert!(pid > 0);
    session.close().await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            if unsafe { libc::kill(pid, 0) } < 0 {
                break;
            }
            let out = tokio::process::Command::new("ps")
                .args(["-p", &pid.to_string(), "-o", "stat="])
                .output()
                .await
                .unwrap();
            if String::from_utf8_lossy(&out.stdout).trim().starts_with('Z') {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn child_environment_excludes_service_credentials_and_control_endpoints() {
    let names = [
        "TELEGRAM_BOT_TOKEN",
        "TGFX_HOME",
        "TGFX_RUNTIME_DIR",
        "TGFX_MCP_SECRET",
        "TGFX_INTERNAL_TELEGRAM_TOKEN",
        "PATH",
        "HOME",
        "FX_API_KEY",
        "HTTPS_PROXY",
    ];
    let clean = tgfx::fx::preflight::sanitize_environment_from(
        names.iter().map(|name| ((*name).into(), "value".into())),
    );
    let kept: Vec<_> = clean
        .iter()
        .map(|(key, _)| key.to_string_lossy().into_owned())
        .collect();
    assert_eq!(kept, vec!["PATH", "HOME", "FX_API_KEY", "HTTPS_PROXY"]);
}

#[tokio::test]
async fn context_usage_is_retained_after_prompt_and_replayed_on_load() {
    use tgfx::fx::usage::ContextUsage;
    let root = tempfile::tempdir().unwrap();
    let opts = options(root.path());
    let session = FxSession::start(opts.clone()).await.unwrap();
    assert_eq!(session.context_usage(), None);
    let (tx, _) = mpsc::unbounded_channel();
    session
        .prompt(vec![json!({"type":"text","text":"USAGE"})], tx)
        .await
        .unwrap();
    let expected = Some(ContextUsage {
        used: 6400,
        size: 256000,
    });
    assert_eq!(session.context_usage(), expected);
    let mut loaded_options = opts.clone();
    loaded_options.saved_session = Some(session.session_id());
    session.close().await.unwrap();
    let loaded = FxSession::start(loaded_options).await.unwrap();
    assert_eq!(loaded.context_usage(), expected);
    loaded.close().await.unwrap();
    let fresh = FxSession::start(opts).await.unwrap();
    assert_eq!(fresh.context_usage(), None);
    fresh.close().await.unwrap();
}
