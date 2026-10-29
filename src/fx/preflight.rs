use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::process::Command;

pub fn sanitize_environment() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    sanitize_environment_from(std::env::vars_os())
}
pub fn sanitize_environment_from(
    environment: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    environment
        .into_iter()
        .filter(|(name, _)| {
            let n = name.to_string_lossy();
            !matches!(
                n.as_ref(),
                "TELEGRAM_BOT_TOKEN" | "TGFX_POLICY_FILE" | "TGFX_HOME" | "TGFX_EVENTS_SOCKET"
            ) && !n.starts_with("TGFX_MCP_")
                && !n.starts_with("TGFX_INTERNAL_TELEGRAM_")
                && !n.starts_with("TGFX_TOKEN")
        })
        .collect()
}
pub async fn run(binary: &str, args: &[&str], cwd: &Path) -> Result<String> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(sanitize_environment())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let child = command
        .spawn()
        .with_context(|| format!("Cannot start {binary}"))?;
    let pid = child.id();
    struct Group(Option<u32>);
    impl Drop for Group {
        fn drop(&mut self) {
            #[cfg(unix)]
            if let Some(pid) = self.0 {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        }
    }
    let _group = Group(pid);
    let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .context("fx command did not finish within 15 seconds")??;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "{}",
            crate::secrets::redact(if stderr.trim().is_empty() {
                &stdout
            } else {
                stderr.trim()
            })
        )
    }
    Ok(stdout)
}
pub fn assert_supported_version(version: &str) -> Result<()> {
    let re = regex::Regex::new(r"^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$")?;
    let Some(c) = re.captures(version.trim()) else {
        bail!(
            "Could not parse fx version {}",
            crate::secrets::redact(version)
        )
    };
    let current = (
        c[1].parse::<u64>()?,
        c[2].parse::<u64>()?,
        c[3].parse::<u64>()?,
    );
    if current < (0, 0, 15) {
        bail!("fx 0.0.15 or newer is required (found {version}). Run fx upgrade --channel stable.")
    }
    Ok(())
}
pub fn parse_doctor(output: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(output).context("fx doctor returned invalid JSON")?;
    if !value["fail_count"].is_number()
        || !value["warn_count"].is_number()
        || !value["model"].is_string()
        || !value["auth"].is_string()
        || !value["workspace"].is_string()
        || !value["checks"].as_array().is_some_and(|a| {
            a.iter().all(|x| {
                x["name"].is_string()
                    && matches!(x["status"].as_str(), Some("ok" | "warn" | "fail"))
                    && x["detail"].is_string()
            })
        })
    {
        bail!("fx doctor returned an incomplete report")
    }
    Ok(value)
}
pub async fn inspect_fx(binary: &str, cwd: &Path) -> Result<Value> {
    let version = run(binary, &["--version"], cwd).await?;
    assert_supported_version(&version)?;
    let report = parse_doctor(&run(binary, &["doctor", "--json"], cwd).await?)?;
    if report["fail_count"].as_u64().unwrap_or(1) > 0 {
        let failures = report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|x| x["status"] == "fail")
            .map(|x| {
                format!(
                    "{}: {}",
                    x["name"].as_str().unwrap_or(""),
                    x["detail"].as_str().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        bail!("fx is not ready: {}", crate::secrets::redact(&failures))
    }
    Ok(json!({"version":version,"report":report}))
}

pub async fn inspect(binary: &str, workspace: &Path) -> Result<Value> {
    inspect_fx(binary, workspace).await
}
