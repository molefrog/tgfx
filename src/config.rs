use crate::types::Config;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct WorkspacePaths {
    pub workspace: PathBuf,
    pub config: PathBuf,
    pub database: PathBuf,
    pub lock: PathBuf,
    pub lock_info: PathBuf,
    pub files: PathBuf,
}
pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
pub fn tgfx_home() -> PathBuf {
    std::env::var_os("TGFX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".fx/telegram"))
}
pub fn runtime_dir() -> Option<PathBuf> {
    std::env::var_os("TGFX_RUNTIME_DIR").map(PathBuf::from)
}
fn read_policy() -> Result<Option<Value>> {
    match runtime_dir() {
        Some(dir) => read_json(&dir.join("policy.json")),
        None => Ok(None),
    }
}
pub fn absolute(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}
pub fn project_path(workspace: &Path) -> Result<PathBuf> {
    let path = absolute(workspace)?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let slug = regex::Regex::new(r"[^A-Za-z0-9_.-]+")?.replace_all(&name, "-");
    let hash = format!("{:x}", Sha256::digest(path.to_string_lossy().as_bytes()));
    Ok(tgfx_home().join("projects").join(format!(
        "{}-{}.json",
        if slug.is_empty() { "root" } else { &slug },
        &hash[..12]
    )))
}
pub fn workspace_paths(bot_id: &str, workspace: &Path) -> Result<WorkspacePaths> {
    validate_id(bot_id, false)?;
    let state = tgfx_home().join("state");
    let files = std::env::var_os("TGFX_FILES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| tgfx_home().join("files"))
        .join(bot_id);
    Ok(WorkspacePaths {
        workspace: absolute(workspace)?,
        config: project_path(workspace)?,
        database: state.join(format!("{bot_id}.db")),
        lock: state.join(format!("{bot_id}.lock")),
        lock_info: state.join(format!("{bot_id}.info.json")),
        files,
    })
}
pub fn validate_id(id: &str, negative: bool) -> Result<()> {
    let s = if negative {
        id.strip_prefix('-').unwrap_or(id)
    } else {
        id
    };
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        bail!("Invalid decimal Telegram ID")
    };
    Ok(())
}
pub fn validate(config: &Config) -> Result<()> {
    if config.version != 1 {
        bail!("Unsupported TGFX config version {}", config.version)
    }
    validate_id(&config.active_bot_id, false)?;
    if config.access.user_ids.is_empty() && config.access.chat_ids.is_empty() {
        bail!("At least one allowed user or chat is required")
    }
    for id in &config.access.user_ids {
        validate_id(id, false)?;
    }
    for id in &config.access.chat_ids {
        validate_id(id, true)?;
    }
    validate_id(&config.approvals.chat_id, true)?;
    validate_id(&config.approvals.topic_id, false)?;
    for value in [&config.dm_reply, &config.group_reply]
        .into_iter()
        .chain(config.chat_replies.values())
    {
        if !matches!(value.as_str(), "all" | "mention") {
            bail!("Reply policy must be all or mention")
        }
    }
    for key in config.chat_replies.keys() {
        validate_id(key, true)?;
    }
    for key in config.chat_formats.keys() {
        validate_id(key, false)?;
    }
    if config.memory.file.trim().is_empty() {
        bail!("Memory file cannot be empty")
    }
    Ok(())
}
pub fn read_json(path: &Path) -> Result<Option<Value>> {
    match fs::read(path) {
        Ok(b) => Ok(Some(
            serde_json::from_slice(&b).with_context(|| format!("Invalid {}", path.display()))?,
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub fn load(workspace: &Path) -> Result<Option<Config>> {
    let stored = read_json(&project_path(workspace)?)?;
    let policy = read_policy()?;
    if stored.is_none() && policy.is_none() {
        return Ok(None);
    }
    if let (Some(stored), Some(policy)) = (&stored, &policy)
        && stored
            .get("activeBotId")
            .is_some_and(|id| Some(id) != policy.get("activeBotId"))
    {
        bail!("Telegram policy and workspace bot identities differ");
    }
    let global = read_json(&tgfx_home().join("config.json"))?.unwrap_or(json!({}));
    let mut effective = json!({"version":1,"output":"live","customIcons":true,"dmReply":"all","groupReply":"mention","chatReplies":{},"memory":{"enabled":true,"file":"MEMORY.md"}});
    for source in [global.get("defaults"), stored.as_ref()] {
        if let Some(Value::Object(map)) = source {
            for (k, v) in map {
                effective[k] = v.clone();
            }
        }
    }
    if let Some(policy) = policy {
        for key in ["version", "activeBotId", "access", "approvals"] {
            effective[key] = policy
                .get(key)
                .cloned()
                .with_context(|| format!("Policy is missing {key}"))?;
        }
    }
    let config: Config = serde_json::from_value(effective).context("Invalid TGFX configuration")?;
    validate(&config)?;
    Ok(Some(config))
}
pub fn private_directory(path: &Path, mode: u32) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}
pub fn write_private_json(path: &Path, value: &Value) -> Result<()> {
    let parent = path.parent().context("File has no parent")?;
    private_directory(parent, 0o700)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    use std::io::Write;
    serde_json::to_writer_pretty(&mut temp, value)?;
    writeln!(temp)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}
pub fn save(workspace: &Path, config: &Config) -> Result<()> {
    save_settings(workspace, config, &[])
}
/// Persist only explicitly changed preferences; inherited defaults remain inherited.
pub fn save_settings(workspace: &Path, config: &Config, changed: &[&str]) -> Result<()> {
    validate(config)?;
    let effective = serde_json::to_value(config)?;
    let current = read_json(&project_path(workspace)?)?.unwrap_or(json!({}));
    let mut value = json!({"workspace":absolute(workspace)?});
    if let Some(policy) = read_policy()? {
        let p: Config = serde_json::from_value(policy)?;
        validate(&p)?;
        let p = serde_json::to_value(p)?;
        for key in ["version", "activeBotId", "access", "approvals"] {
            if effective[key] != p[key] {
                bail!("Access is managed by policy.json; edit that file as its owner")
            }
        }
    }
    for key in ["version", "activeBotId", "access", "approvals"] {
        value[key] = effective[key].clone();
    }
    for key in [
        "output",
        "customIcons",
        "imagePreviews",
        "dmReply",
        "groupReply",
        "chatReplies",
        "chatFormats",
        "memory",
    ] {
        if changed.contains(&key) {
            value[key] = effective[key].clone();
        } else if let Some(stored) = current.get(key) {
            value[key] = stored.clone();
        }
    }
    write_private_json(&project_path(workspace)?, &value)
}
pub fn assert_policy_writable() -> Result<()> {
    if read_policy()?.is_some() {
        bail!("Access is managed by policy.json; edit that file as its owner")
    };
    Ok(())
}
pub fn global_defaults() -> Result<Value> {
    Ok(read_json(&tgfx_home().join("config.json"))?.unwrap_or(json!({"version":1,"defaults":{}})))
}
