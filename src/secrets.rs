use crate::config;
use anyhow::{Result, bail};
use std::{fs, path::PathBuf};
fn path(bot: &str) -> Result<PathBuf> {
    config::validate_id(bot, false)?;
    Ok(config::tgfx_home()
        .join("tokens")
        .join(format!("{bot}.token")))
}
pub fn redact(text: &str) -> String {
    static TOKEN: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\d{6,}:[A-Za-z0-9_-]{20,}").unwrap());
    TOKEN
        .replace_all(text, "[redacted Telegram token]")
        .into_owned()
}
pub fn get(bot: &str) -> Result<Option<String>> {
    if let Ok(s) = std::env::var("TELEGRAM_BOT_TOKEN")
        && !s.trim().is_empty()
    {
        return Ok(Some(s.trim().into()));
    }
    match fs::read_to_string(path(bot)?) {
        Ok(s) => return Ok((!s.trim().is_empty()).then(|| s.trim().into())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                "dev.tgfx",
                "-a",
                &format!("telegram:{bot}"),
                "-w",
            ])
            .output()?;
        if out.status.success() {
            let s = String::from_utf8(out.stdout)?.trim().to_owned();
            return Ok((!s.is_empty()).then_some(s));
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(out) = std::process::Command::new("secret-tool")
            .args([
                "lookup",
                "service",
                "dev.tgfx",
                "name",
                &format!("telegram:{bot}"),
            ])
            .output()
            && out.status.success()
        {
            let s = String::from_utf8(out.stdout)?.trim().to_owned();
            return Ok((!s.is_empty()).then_some(s));
        }
    }
    Ok(None)
}
pub fn set(bot: &str, token: &str) -> Result<()> {
    if token.trim().is_empty() {
        bail!("Token cannot be empty")
    }
    let p = path(bot)?;
    #[cfg(target_os = "macos")]
    if !p.exists() {
        let status = std::process::Command::new("security")
            .args([
                "add-generic-password",
                "-U",
                "-s",
                "dev.tgfx",
                "-a",
                &format!("telegram:{bot}"),
                "-w",
                token,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()?;
        if status.success() {
            return Ok(());
        }
    }
    #[cfg(target_os = "linux")]
    if !p.exists() {
        use std::io::Write;
        if let Ok(mut child) = std::process::Command::new("secret-tool")
            .args([
                "store",
                "--label=TGFX Telegram bot",
                "service",
                "dev.tgfx",
                "name",
                &format!("telegram:{bot}"),
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            let written = child
                .stdin
                .take()
                .is_some_and(|mut input| input.write_all(token.as_bytes()).is_ok());
            if written && child.wait()?.success() {
                return Ok(());
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    if !p.exists() {
        eprintln!(
            "OS credential store unavailable; saving bot token in a private file at {}",
            p.display()
        );
    }
    write_token(&p, token)
}
pub fn source(bot: &str) -> Result<String> {
    if std::env::var("TELEGRAM_BOT_TOKEN").is_ok_and(|s| !s.trim().is_empty()) {
        return Ok("environment token".into());
    }
    let p = path(bot)?;
    if p.exists() {
        Ok(format!("private token file {}", p.display()))
    } else {
        Ok("OS credential store".into())
    }
}
fn write_token(path: &std::path::Path, token: &str) -> Result<()> {
    use std::io::Write;
    config::private_directory(path.parent().unwrap(), 0o700)?;
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    temp.write_all(token.as_bytes())?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}
pub fn remove(bot: &str) -> Result<()> {
    write_token(&path(bot)?, "")
}
