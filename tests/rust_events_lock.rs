use serde_json::json;
use std::{path::PathBuf, time::Duration};
use tgfx::{
    event_socket::{event_request, listen_events},
    events::{EventJournal, ExternalEvent, event_prompt},
    lock::RuntimeLock,
    state::State,
};
#[test]
fn event_ids_compare_canonical_data_and_recover_without_replay() {
    let d = tempfile::tempdir().unwrap();
    let s = State::open(&d.path().join("state.db"), d.path()).unwrap();
    let journal = EventJournal::new(s, "/work", "100").unwrap();
    assert!(
        journal
            .accept(json!({"name":"email.received","id":"mail:1","payload":{"b":2,"a":1}}))
            .unwrap()
            .1
    );
    assert!(
        !journal
            .accept(json!({"name":"email.received","id":"mail:1","payload":{"a":1,"b":2}}))
            .unwrap()
            .1
    );
    assert!(
        journal
            .accept(json!({"name":"changed","id":"mail:1"}))
            .is_err()
    );
    journal.mark("mail:1", "running", None, None).unwrap();
    journal
        .accept(json!({"name":"email.received","id":"mail:2"}))
        .unwrap();
    let recovered = journal.recover().unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].id, "mail:2");
    assert_eq!(
        journal.get("mail:1").unwrap().unwrap().status,
        "interrupted"
    );
}
#[test]
fn external_envelope_never_impersonates_a_telegram_user() {
    let e = ExternalEvent::parse(
        json!({"id":"one","name":"email.received","payload":{"message_id":"separate"}}),
    )
    .unwrap();
    let p = event_prompt(&e);
    let v: serde_json::Value = serde_json::from_str(p[0]["text"].as_str().unwrap()).unwrap();
    assert!(v.get("telegram_message").is_none());
    assert_eq!(v["external_event"]["source"], "tgfx:emit");
    assert_eq!(v["external_event"]["scope"], json!({"kind":"background"}));
    assert!(v["external_event"].get("sender").is_none());
    assert!(v["external_event"].get("message").is_none());
}
#[tokio::test]
async fn socket_enforces_bounds_permissions_and_cleans_up() {
    let d = tempfile::Builder::new()
        .prefix("tgfx-socket-")
        .tempdir_in("/tmp")
        .unwrap();
    let p = d.path().join("events.sock");
    let socket = listen_events(&p, |v| async move { Ok(json!({"received":v})) })
        .await
        .unwrap();
    assert_eq!(
        event_request(&p, &json!({"test":1})).await.unwrap(),
        json!({"received":{"test":1}})
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        event_request(&p, &json!({"payload":"x".repeat(301*1024)}))
            .await
            .is_err()
    );
    socket.close().await.unwrap();
    assert!(!p.exists());
    std::fs::write(&p, "do not delete").unwrap();
    assert!(listen_events(&p, |v| async move { Ok(v) }).await.is_err());
    assert_eq!(std::fs::read_to_string(p).unwrap(), "do not delete");
}
#[test]
fn runtime_lock_releases_and_bots_are_independent() {
    let d = tempfile::tempdir().unwrap();
    let one = d.path().join("100.lock");
    let info = d.path().join("100.info.json");
    let mut first = RuntimeLock::acquire_paths("100", d.path(), &one, &info).unwrap();
    assert!(RuntimeLock::acquire_paths("100", d.path(), &one, &info).is_err());
    let second = RuntimeLock::acquire_paths(
        "200",
        d.path(),
        &d.path().join("200.lock"),
        &d.path().join("200.info.json"),
    )
    .unwrap();
    first.release();
    first.release();
    let next = RuntimeLock::acquire_paths("100", d.path(), &one, &info).unwrap();
    first.release();
    assert!(
        info.exists(),
        "an old holder must not delete the new holder's sidecar"
    );
    drop(first);
    assert!(info.exists());
    drop(next);
    drop(second);
}
#[test]
fn killed_holder_never_leaves_a_stale_runtime_lock() {
    let d = tempfile::tempdir().unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "runtime_lock_child", "--nocapture"])
        .env("TGFX_LOCK_TEST_PATH", d.path())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    loop {
        line.clear();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if line.contains("LOCK_READY") {
            break;
        }
    }
    let p = d.path().join("100.lock");
    let info = d.path().join("100.info.json");
    assert!(RuntimeLock::acquire_paths("100", d.path(), &p, &info).is_err());
    child.kill().unwrap();
    child.wait().unwrap();
    let _next = RuntimeLock::acquire_paths("100", d.path(), &p, &info).unwrap();
}
#[test]
fn runtime_lock_child() {
    if let Some(path) = std::env::var_os("TGFX_LOCK_TEST_PATH") {
        let d = PathBuf::from(path);
        let _lock =
            RuntimeLock::acquire_paths("100", &d, &d.join("100.lock"), &d.join("100.info.json"))
                .unwrap();
        println!("LOCK_READY");
        use std::io::Write;
        std::io::stdout().flush().unwrap();
        std::thread::sleep(Duration::from_secs(30));
    }
}
#[test]
fn saved_events_are_deduplicated_after_migration() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.db");
    let workspace = root.path().to_string_lossy().into_owned();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            &include_str!("fixtures/saved-state.sql")
                .replace("__WORKSPACE__", &workspace.replace('\'', "''")),
        )
        .unwrap();
    let state = State::open(&path, root.path()).unwrap();
    let events = EventJournal::new(state, &workspace, "100").unwrap();
    assert!(!events.accept(json!({"id":"saved-event","name":"email.received","payload":{"thread_id":"two","mixed":{"ä":1,"A":2,"a":3,"_":4},"message_id":"one"}})).unwrap().1);
    assert!(events.accept(json!({"id":"saved-event","name":"email.received","payload":{"message_id":"different"}})).is_err());
}
