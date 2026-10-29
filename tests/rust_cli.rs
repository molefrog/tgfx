use serde_json::{Value, json};
use std::{path::Path, process::Command};
fn run(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_tgfx"))
        .args(args)
        .current_dir(dir)
        .env("TGFX_HOME", dir.join("home"))
        .env_remove("TGFX_POLICY_FILE")
        .env_remove("TELEGRAM_BOT_TOKEN")
        .output()
        .unwrap()
}
fn setup(dir: &Path) -> std::path::PathBuf {
    use sha2::{Digest, Sha256};
    let canonical = dir.canonicalize().unwrap();
    let hash = format!(
        "{:x}",
        Sha256::digest(canonical.to_string_lossy().as_bytes())
    );
    let slug = dir.file_name().unwrap().to_string_lossy();
    let path = dir
        .join("home/projects")
        .join(format!("{slug}-{}.json", &hash[..12]));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path,json!({"version":1,"activeBotId":"100","access":{"userIds":["42"],"chatIds":[]},"approvals":{"chatId":"42"}}).to_string()).unwrap();
    path
}
#[test]
fn global_settings_and_project_override_are_compatible() {
    let d = tempfile::tempdir().unwrap();
    let p = setup(d.path());
    std::fs::write(
        d.path().join("home/config.json"),
        json!({"version":1,"defaults":{"output":"final","dmReply":"mention","customIcons":false}})
            .to_string(),
    )
    .unwrap();
    let mut v: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    v["groupReply"] = json!("all");
    std::fs::write(p, v.to_string()).unwrap();
    let out = run(d.path(), &["access", "--json"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["settings"]["dmReply"], "mention");
    assert_eq!(v["settings"]["groupReply"], "all");
}
#[test]
fn negative_chat_grants_and_inherit_roundtrip() {
    let d = tempfile::tempdir().unwrap();
    let p = setup(d.path());
    let out = run(d.path(), &["allow", "--chat", "-100123", "--reply", "all"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    assert_eq!(v["access"]["chatIds"], json!(["-100123"]));
    assert_eq!(v["chatReplies"]["-100123"], "all");
    let out = run(d.path(), &["allow", "--chat", "-100123", "--inherit"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
    assert!(v["chatReplies"].get("-100123").is_none());
}
#[test]
fn last_access_entry_cannot_be_removed() {
    let d = tempfile::tempdir().unwrap();
    let p = setup(d.path());
    let before = std::fs::read(&p).unwrap();
    let out = run(d.path(), &["deny", "42"]);
    assert!(!out.status.success());
    assert_eq!(std::fs::read(p).unwrap(), before);
}
#[test]
fn operator_policy_fails_closed_and_blocks_mutation() {
    let d = tempfile::tempdir().unwrap();
    let p = setup(d.path());
    let policy = d.path().join("policy.json");
    std::fs::copy(p, &policy).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_tgfx"))
        .args(["deny", "42"])
        .current_dir(d.path())
        .env("TGFX_HOME", d.path().join("home"))
        .env("TGFX_POLICY_FILE", &policy)
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("TGFX_POLICY_FILE"));
    std::fs::remove_file(&policy).unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_tgfx"))
        .args(["access", "--json"])
        .current_dir(d.path())
        .env("TGFX_HOME", d.path().join("home"))
        .env("TGFX_POLICY_FILE", &policy)
        .output()
        .unwrap();
    assert!(!out.status.success());
}
#[test]
fn private_config_permissions_survive_restrictive_umask() {
    let d = tempfile::tempdir().unwrap();
    let p = setup(d.path());
    let out = run(d.path(), &["allow", "77"]);
    assert!(out.status.success());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(p).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
#[test]
fn no_config_headless_does_not_wait_for_input() {
    let d = tempfile::tempdir().unwrap();
    let out = run(d.path(), &["access"]);
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("initialized"));
}
#[test]
fn unrelated_access_edit_keeps_global_defaults_inherited() {
    let d = tempfile::tempdir().unwrap();
    let p = setup(d.path());
    let defaults = d.path().join("home/config.json");
    std::fs::write(
        &defaults,
        json!({"version":1,"defaults":{"output":"final","dmReply":"mention","customIcons":false}})
            .to_string(),
    )
    .unwrap();
    let out = run(d.path(), &["allow", "77"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    for key in ["output", "dmReply", "customIcons"] {
        assert!(v.get(key).is_none(), "{key} unexpectedly frozen");
    }
    std::fs::write(
        defaults,
        json!({"version":1,"defaults":{"output":"detailed","dmReply":"all","customIcons":true}})
            .to_string(),
    )
    .unwrap();
    let out = run(d.path(), &["access", "--json"]);
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["settings"]["dmReply"], "all");
}
#[test]
fn ids_are_canonical_and_global_flags_work_after_subcommands() {
    let d = tempfile::tempdir().unwrap();
    let p = setup(d.path());
    let out = run(d.path(), &["allow", "00077", "-00091", "--no-color"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
    assert_eq!(v["access"]["userIds"], json!(["42", "77"]));
    assert_eq!(v["access"]["chatIds"], json!(["-91"]));
    let out = run(
        d.path(),
        &["access", "--json", "--no-tui", "--debug", "--no-color"],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(serde_json::from_slice::<Value>(&out.stdout).is_ok());
}
#[test]
fn managed_access_allows_reply_preferences_but_never_new_grants() {
    let d = tempfile::tempdir().unwrap();
    let p = setup(d.path());
    let policy = d.path().join("policy.json");
    std::fs::copy(&p, &policy).unwrap();
    let invoke = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_tgfx"))
            .args(args)
            .current_dir(d.path())
            .env("TGFX_HOME", d.path().join("home"))
            .env("TGFX_POLICY_FILE", &policy)
            .output()
            .unwrap()
    };
    let out = invoke(&["allow", "42", "--reply", "mention"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    assert_eq!(v["chatReplies"]["42"], "mention");
    let before = std::fs::read(&p).unwrap();
    let out = invoke(&["allow", "42", "99", "--reply", "all"]);
    assert!(!out.status.success());
    assert_eq!(std::fs::read(&p).unwrap(), before);
    let out = invoke(&["allow", "99", "--inherit"]);
    assert!(!out.status.success());
    assert_eq!(std::fs::read(p).unwrap(), before);
}
