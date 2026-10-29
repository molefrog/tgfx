use serde_json::json;
use tgfx::{
    history::HistoryInput,
    state::State,
    telegram,
    types::{BotIdentity, InboundMessage, Route},
};
fn fixture() -> (tempfile::TempDir, State) {
    let d = tempfile::tempdir().unwrap();
    let s = State::open(&d.path().join("state.db"), d.path()).unwrap();
    (d, s)
}
fn message(update: i64, id: i64, text: &str, edited: bool) -> InboundMessage {
    let raw = json!({"message_id":id,"date":id,"chat":{"id":-9,"type":"supergroup","title":"Team"},"from":{"id":42,"is_bot":false,"first_name":"Ada"},"text":text});
    let update = json!({"update_id":update,if edited{"edited_message"}else{"message"}:raw});
    let bot = BotIdentity {
        id: "100".into(),
        username: Some("bot".into()),
        display_name: "Bot".into(),
    };
    let mut m = telegram::normalize(&update, &bot).unwrap();
    m.invokes_agent = Some(true);
    m
}
fn ingest(s: &State, m: &mut InboundMessage) -> i64 {
    let route = m.route.clone();
    s.ensure_route(&route).unwrap();
    s.ingest_update(
        "100",
        m.update_id,
        Some(&route.key),
        Some(&json!({"kind":"message","message":m})),
        Some(m),
        true,
    )
    .unwrap()
    .unwrap()
}
#[test]
fn cursor_and_authorized_payload_commit_and_deduplicate() {
    let (_d, s) = fixture();
    s.ingest_update("100", 1, None, None, None, false).unwrap();
    assert_eq!(s.next_offset("100").unwrap(), 2);
    assert!(
        s.query("SELECT * FROM telegram_inbox", [])
            .unwrap()
            .is_empty()
    );
    let mut m = message(2, 2, "hello", false);
    let id = ingest(&s, &mut m);
    assert_eq!(ingest(&s, &mut m), id);
    assert_eq!(
        s.query("SELECT * FROM telegram_inbox", []).unwrap().len(),
        1
    );
    assert_eq!(s.next_offset("100").unwrap(), 3);
    assert!(s.claim_inbox(id).unwrap());
    assert!(!s.claim_inbox(id).unwrap());
    s.mark_inbox(id, "done", None).unwrap();
    assert!(s.inbox(id).unwrap().unwrap().payload_json.is_none());
}
#[test]
fn recovery_never_replays_claimed_work_and_reconciles_delivery() {
    let (_d, s) = fixture();
    let mut m = message(1, 1, "hello", false);
    let id = ingest(&s, &mut m);
    s.claim_inbox(id).unwrap();
    s.mark_inbox(id, "running", None).unwrap();
    let (received, n) = s.recover_inbox().unwrap();
    assert!(received.is_empty());
    assert_eq!(n, 1);
    let mut m = message(2, 2, "hello", false);
    let id = ingest(&s, &mut m);
    s.claim_inbox(id).unwrap();
    let out = s
        .create_outbox(
            "effect",
            &m.route,
            Some(id),
            "rich_final",
            &json!({"plain":"done"}),
        )
        .unwrap();
    s.mark_outbox(out, "sent", Some("20"), None).unwrap();
    let (_, n) = s.recover_inbox().unwrap();
    assert_eq!(n, 0);
    assert_eq!(s.inbox(id).unwrap().unwrap().status, "done");
}
#[test]
fn queued_edits_replace_but_started_edits_do_not_run_again() {
    let (_d, s) = fixture();
    let mut m = message(1, 10, "original", false);
    let id = ingest(&s, &mut m);
    let mut edit = message(2, 10, "edited", true);
    ingest(&s, &mut edit);
    assert_eq!(s.inbox(id).unwrap().unwrap().status, "discarded");
    s.history
        .begin(
            &edit.route.key,
            &edit.context_ref,
            edit.history_seq.unwrap(),
            2,
            None,
        )
        .unwrap();
    let mut later = message(3, 10, "after starting", true);
    ingest(&s, &mut later);
    assert_eq!(later.invokes_agent, Some(false));
}
#[test]
fn capabilities_are_route_scoped_and_expire_on_reset() {
    let (_d, s) = fixture();
    let mut m = message(1, 1, "hello", false);
    s.ensure_route(&m.route).unwrap();
    s.register_inbound(&mut m, true).unwrap();
    assert!(s.active_context(&m.route.key).unwrap().is_some());
    assert!(s.active_context("100:-9:5").unwrap().is_none());
    assert!(
        s.message_reference(&m.message_ref, &m.route.key)
            .unwrap()
            .is_some()
    );
    assert!(
        s.message_reference(&m.message_ref, "100:-9:5")
            .unwrap()
            .is_none()
    );
    assert!(
        s.principal(&m.sender.reference, &m.route.key)
            .unwrap()
            .is_some()
    );
    s.set_route_session(&m.route.key, "old", false).unwrap();
    s.reset_route(&m.route.key).unwrap();
    assert!(
        s.message_reference(&m.message_ref, &m.route.key)
            .unwrap()
            .is_none()
    );
    assert!(
        s.principal(&m.sender.reference, &m.route.key)
            .unwrap()
            .is_none()
    );
    assert_eq!(s.route(&m.route.key).unwrap().unwrap().generation, 2);
}
#[test]
fn effect_ledger_blocks_uncertain_repetition_and_resolves_once() {
    let (_d, s) = fixture();
    assert_eq!(s.begin_effect("e", "100", "route", "tool").unwrap(), "new");
    assert_eq!(
        s.begin_effect("e", "100", "route", "tool").unwrap(),
        "unknown"
    );
    s.complete_effect("e", &json!({"ok":true})).unwrap();
    assert_eq!(
        s.begin_effect("e", "100", "route", "tool").unwrap(),
        "complete"
    );
    assert_eq!(s.effect_result("e").unwrap(), Some(json!({"ok":true})));
    s.create_interaction(
        "i",
        "100",
        "route",
        "test",
        &json!({}),
        &tgfx::state::expires(1),
    )
    .unwrap();
    assert!(s.resolve_interaction("i", &json!("first")).unwrap());
    assert!(!s.resolve_interaction("i", &json!("second")).unwrap());
}
#[test]
fn workspace_adoption_preserves_telegram_delivery_but_resets_execution() {
    let (_d, s) = fixture();
    s.adopt_workspace("first").unwrap();
    let mut m = message(1, 1, "queued", false);
    let id = ingest(&s, &mut m);
    s.set_route_session(&m.route.key, "session", false).unwrap();
    let out = s
        .create_outbox(
            "e",
            &m.route,
            Some(id),
            "rich_final",
            &json!({"plain":"reply"}),
        )
        .unwrap();
    let change = s.adopt_workspace("second").unwrap();
    assert_eq!(change["discarded"], 1);
    assert_eq!(s.inbox(id).unwrap().unwrap().status, "discarded");
    assert!(s.route(&m.route.key).unwrap().unwrap().session_id.is_none());
    assert_eq!(s.recoverable_outbox().unwrap()[0].id, out);
    assert_eq!(s.next_offset("100").unwrap(), 2);
}
#[test]
fn history_snapshots_retain_original_edits_and_exclude_future_messages() {
    let (_d, s) = fixture();
    let mut m = message(1, 1, "original", false);
    s.history.record_inbound(&mut m).unwrap();
    let through = m.history_seq.unwrap();
    let mut edit = message(2, 1, "edited", true);
    s.history.record_inbound(&mut edit).unwrap();
    let mut future = message(3, 2, "later", false);
    s.history.record_inbound(&mut future).unwrap();
    let page = s
        .history
        .read(&m.route.key, through, HistoryInput::default())
        .unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
    assert_eq!(page["messages"][0]["text"], "original");
    let latest = s
        .history
        .read(
            &m.route.key,
            future.history_seq.unwrap(),
            HistoryInput::default(),
        )
        .unwrap();
    assert_eq!(latest["messages"][0]["text"], "edited");
    assert_eq!(latest["messages"][0]["ref"], page["messages"][0]["ref"]);
}
#[test]
fn history_preview_prioritizes_recent_text_and_pages_omissions() {
    let (_d, s) = fixture();
    for i in 1..=8 {
        let mut m = message(i, i, &format!("message {i}"), false);
        s.history.record_inbound(&mut m).unwrap();
    }
    let mut current = message(9, 9, "request", false);
    s.history.record_inbound(&mut current).unwrap();
    let p = s.history.preview(&current, false).unwrap().unwrap();
    assert_eq!(p["included"], 5);
    assert_eq!(p["omitted"], 3);
    assert_eq!(p["messages"][0]["text"], "message 4");
    let page = s
        .history
        .read(
            &current.route.key,
            current.history_seq.unwrap(),
            HistoryInput {
                cursor: p["older_cursor"].as_str().map(str::to_owned),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 3);
}
#[test]
fn unicode_remainder_cursors_are_lossless_and_scoped() {
    let (_d, s) = fixture();
    let original = "🦀é".repeat(20000);
    let mut m = message(1, 1, &original, false);
    s.history.record_inbound(&mut m).unwrap();
    let through = m.history_seq.unwrap();
    let p = s
        .history
        .read(&m.route.key, through, HistoryInput::default())
        .unwrap();
    assert_eq!(
        p["messages"][0]["text"].as_str().unwrap().chars().count(),
        32000
    );
    let token = p["messages"][0]["remainder_cursor"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(
        s.history
            .read(
                "100:-9:2",
                through,
                HistoryInput {
                    cursor: Some(token.clone()),
                    ..Default::default()
                }
            )
            .is_err()
    );
    let next = s
        .history
        .read(
            &m.route.key,
            through,
            HistoryInput {
                cursor: Some(token),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(
        format!(
            "{}{}",
            p["messages"][0]["text"].as_str().unwrap(),
            next["messages"][0]["text"].as_str().unwrap()
        ),
        original
    );
}
#[test]
fn delivery_advances_preview_only_through_its_request() {
    let (_d, s) = fixture();
    let mut first = message(1, 1, "discussion", false);
    s.history.record_inbound(&mut first).unwrap();
    let mut request = message(2, 2, "request", false);
    let id = ingest(&s, &mut request);
    s.history
        .begin(
            &request.route.key,
            &request.context_ref,
            request.history_seq.unwrap(),
            id,
            None,
        )
        .unwrap();
    let mut later = message(3, 3, "intervening", false);
    s.history.record_inbound(&mut later).unwrap();
    let out = s
        .create_outbox(
            "e",
            &request.route,
            Some(id),
            "rich_final",
            &json!({"plain":"reply"}),
        )
        .unwrap();
    s.mark_outbox(out, "sent", None, None).unwrap();
    let mut next = message(4, 4, "next", false);
    s.history.record_inbound(&mut next).unwrap();
    let p = s.history.preview(&next, false).unwrap().unwrap();
    assert_eq!(p["messages"].as_array().unwrap().len(), 1);
    assert_eq!(p["messages"][0]["text"], "intervening");
}
#[test]
fn history_migration_preserves_colliding_telegram_ids_by_origin() {
    let (_d, s) = fixture();
    let mut old = message(1, 1, "before migration", false);
    s.history.record_inbound(&mut old).unwrap();
    s.ensure_route(&old.route).unwrap();
    let page = s
        .history
        .read(
            &old.route.key,
            old.history_seq.unwrap(),
            HistoryInput {
                limit: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
    let reference = page["messages"][0]["ref"].as_str().unwrap();
    s.migrate_chat("100", "-9", "-1009").unwrap();
    let newroute = Route::new("100", "-1009", "0", "supergroup");
    let mut new = message(2, 1, "after migration", false);
    new.route = newroute;
    s.history.record_inbound(&mut new).unwrap();
    let page = s
        .history
        .read(
            &new.route.key,
            new.history_seq.unwrap(),
            HistoryInput::default(),
        )
        .unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 2);
    assert_eq!(page["messages"][0]["ref"], reference);
}
#[test]
fn clearing_archive_invalidates_cursors_but_reset_only_changes_previews() {
    let (_d, s) = fixture();
    let mut old = message(1, 1, "archive", false);
    s.history.record_inbound(&mut old).unwrap();
    s.history.reset(&old.route.key, None).unwrap();
    let mut next = message(2, 2, "request", false);
    s.history.record_inbound(&mut next).unwrap();
    assert!(s.history.preview(&next, false).unwrap().is_none());
    let page = s
        .history
        .read(
            &next.route.key,
            next.history_seq.unwrap(),
            HistoryInput::default(),
        )
        .unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 2);
    s.history.clear("-9", "100").unwrap();
    assert!(
        s.history
            .read(
                &next.route.key,
                next.history_seq.unwrap(),
                HistoryInput {
                    around: page["messages"][0]["ref"].as_str().map(str::to_owned),
                    ..Default::default()
                }
            )
            .is_err()
    );
}
#[test]
fn legacy_schema_upgrades_preserve_rows() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.db");
    {
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE routes(route_key TEXT PRIMARY KEY,bot_id TEXT NOT NULL,chat_id TEXT NOT NULL,topic_id TEXT NOT NULL,chat_kind TEXT NOT NULL,session_id TEXT,generation INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,last_prompt_json TEXT,dynamic_commands_json TEXT); INSERT INTO routes VALUES('100:42:0','100','42','0','private','old',3,'now','{}','[]');").unwrap();
    }
    let s = State::open(&path, root.path()).unwrap();
    assert_eq!(
        s.route("100:42:0").unwrap().unwrap().session_id.as_deref(),
        Some("old")
    );
    let cols = s
        .query("SELECT name FROM pragma_table_info('routes')", [])
        .unwrap();
    assert!(!cols.iter().any(|v| v["name"] == "last_prompt_json"));
}
#[test]
fn history_archive_survives_capability_expiry_and_reopening() {
    let (root, s) = fixture();
    let mut m = message(1, 1, "full ".repeat(100).as_str(), false);
    s.history.record_inbound(&mut m).unwrap();
    s.register_inbound(&mut m, true).unwrap();
    s.ensure_route(&m.route).unwrap();
    s.reset_route(&m.route.key).unwrap();
    s.prune().unwrap();
    let p = s
        .history
        .read(
            &m.route.key,
            m.history_seq.unwrap(),
            HistoryInput::default(),
        )
        .unwrap();
    assert_eq!(p["messages"][0]["text"], m.text.unwrap());
    assert_eq!(p["messages"][0]["from"]["display_name"], "Ada");
    drop(s);
    let s = State::open(&root.path().join("state.db"), root.path()).unwrap();
    assert_eq!(s.history.latest_seq("100:-9:0").unwrap(), 1);
}
#[test]
fn startup_revokes_crash_left_contexts_without_removing_history() {
    let (root, state) = fixture();
    let mut message = message(1, 1, "private request", false);
    state.ensure_route(&message.route).unwrap();
    state.history.record_inbound(&mut message).unwrap();
    state.register_inbound(&mut message, true).unwrap();
    assert!(state.active_context(&message.route.key).unwrap().is_some());
    drop(state);
    let state = State::open(&root.path().join("state.db"), root.path()).unwrap();
    state.revoke_active_contexts("100").unwrap();
    assert!(state.active_context(&message.route.key).unwrap().is_none());
    assert_eq!(
        state
            .history
            .read(
                &message.route.key,
                message.history_seq.unwrap(),
                HistoryInput::default()
            )
            .unwrap()["messages"][0]["text"],
        "private request"
    );
}
#[test]
fn original_typescript_and_rust_share_the_existing_database_schema() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("state.db");
    let workspace = root.path().to_string_lossy().into_owned();
    let script = r#"
        import {StateStore} from './src/state.ts';
        const [database,workspace]=process.argv.slice(-2); const state=new StateStore(database,workspace);
        const route={key:'100:-9:0',botId:'100',chatId:'-9',topicId:'0',chatKind:'supergroup'};
        state.ensureRoute(route);state.setRouteSession(route.key,'legacy-session');
        state.ingestUpdate({botId:'100',updateId:7,routeKey:route.key,payload:{kind:'message',legacy:true},authorized:true});
        state.createInteraction({id:'legacy',botId:'100',routeKey:route.key,kind:'choice',payload:{question:'Pick',options:['A','B']},expiresAt:new Date(Date.now()+86400000).toISOString()});
        state.close();
    "#;
    let output = std::process::Command::new("bun")
        .args(["-e", script, database.to_str().unwrap(), &workspace])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("Bun required for TypeScript compatibility check");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let state = State::open(&database, root.path()).unwrap();
    assert_eq!(state.next_offset("100").unwrap(), 8);
    assert_eq!(
        state
            .route("100:-9:0")
            .unwrap()
            .unwrap()
            .session_id
            .as_deref(),
        Some("legacy-session")
    );
    assert!(
        state
            .resolve_interaction("legacy", &json!({"index":1}))
            .unwrap()
    );
    let route = state.route("100:-9:0").unwrap().unwrap().as_route();
    let id=state.create_outbox("rust-final",&route,Some(1),"rich_final",&json!({"chatId":"-9","topicId":"0","rich":{"blocks":[{"type":"paragraph","text":"ready"}]},"plain":"ready"})).unwrap();
    state.mark_outbox(id, "sent", Some("90"), None).unwrap();
    state
        .register_bot_message(&route, "90", Some("Rust reply"))
        .unwrap();
    drop(state);
    let script = r#"
        import {StateStore} from './src/state.ts';
        const [database,workspace]=process.argv.slice(-2);const state=new StateStore(database,workspace);
        if(state.interaction('legacy')?.state!=='resolved')throw new Error('Interaction format incompatible');
        if(state.recentMessages('100:-9:0',25)[0]?.excerpt!=='Rust reply')throw new Error('Message format incompatible');
        const history=state.history.read('100:-9:0',state.history.latestSeq('100:-9:0'));
        if(history.messages[0]?.text!=='Rust reply')throw new Error('History format incompatible');
        if(state.db.query("SELECT status FROM telegram_outbox WHERE effect_key='rust-final'").get()?.status!=='sent')throw new Error('Outbox incompatible');state.close();
    "#;
    let output = std::process::Command::new("bun")
        .args(["-e", script, database.to_str().unwrap(), &workspace])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
