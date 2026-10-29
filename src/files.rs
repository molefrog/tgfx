use crate::state::private_mode;
use anyhow::{Result, ensure};
use futures::StreamExt;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs::OpenOptions,
    io::Read,
    path::{Path, PathBuf},
};
use tokio::io::AsyncWriteExt;
pub fn safe_name(value: &str) -> String {
    let name = Path::new(value)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("attachment");
    let mut out = String::new();
    let mut replace = false;
    for c in name.chars() {
        if c.is_alphanumeric() || "._-".contains(c) {
            out.push(c);
            replace = false
        } else if !replace {
            out.push('_');
            replace = true
        }
        if out.chars().count() >= 160 {
            break;
        }
    }
    if out.is_empty() {
        "attachment".into()
    } else {
        out
    }
}
fn shared(path: &Path) -> Result<bool> {
    #[cfg(unix)]
    {
        // New bot and context directories inherit the operator's setgid root.
        for parent in path.ancestors() {
            match std::fs::symlink_metadata(parent) {
                Ok(meta) => return Ok(meta.is_dir() && meta.permissions().mode() & 0o2000 != 0),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            }
        }
    }
    Ok(false)
}
fn download_root(root: &Path) -> Result<PathBuf> {
    let shared = shared(root)?;
    std::fs::create_dir_all(root)?;
    ensure!(
        !std::fs::symlink_metadata(root)?.file_type().is_symlink(),
        "The tgfx attachment directory must not be a symbolic link"
    );
    private_mode(root, if shared { 0o2750 } else { 0o700 })?;
    Ok(root.canonicalize()?)
}
pub fn temporary_download_directory(root: &Path, prefix: &str) -> Result<tempfile::TempDir> {
    let mut b = tempfile::Builder::new();
    b.prefix(prefix);
    Ok(if shared(root)? {
        let directory = b.tempdir_in(download_root(root)?)?;
        private_mode(directory.path(), 0o2750)?;
        directory
    } else {
        b.tempdir()?
    })
}
pub fn safe_download_path(root: &Path, context: &str, filename: &str) -> Result<PathBuf> {
    ensure!(
        !context.is_empty()
            && context.len() <= 128
            && context
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "Invalid attachment context reference"
    );
    let root = download_root(root)?;
    let directory = root.join(context);
    std::fs::create_dir_all(&directory)?;
    ensure!(
        !std::fs::symlink_metadata(&directory)?
            .file_type()
            .is_symlink(),
        "The attachment context directory must not be a symbolic link"
    );
    private_mode(&directory, if shared(&root)? { 0o2750 } else { 0o700 })?;
    let actual = directory.canonicalize()?;
    ensure!(
        actual == directory && actual.starts_with(&root),
        "Attachment context directory escaped the tgfx files directory"
    );
    Ok(actual.join(safe_name(filename)))
}
pub async fn write_response_limited(
    response: reqwest::Response,
    path: &Path,
    max_bytes: u64,
) -> Result<u64> {
    ensure!(
        response.status().is_success(),
        "Telegram attachment download failed ({})",
        response.status()
    );
    ensure!(
        response.content_length().is_none_or(|n| n <= max_bytes),
        "Downloaded attachment exceeded the size limit"
    );
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let mode = if shared(path.parent().unwrap_or(Path::new(".")))? {
        0o640
    } else {
        0o600
    };
    #[cfg(unix)]
    {
        options.mode(mode).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let mut partial = PartialDownload {
        path: path.to_owned(),
        complete: false,
    };
    #[cfg(unix)]
    file.set_permissions(std::fs::Permissions::from_mode(mode))?;
    let mut file = tokio::fs::File::from_std(file);
    let result = async {
        let mut total = 0;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            total += chunk.len() as u64;
            ensure!(
                total <= max_bytes,
                "Downloaded attachment exceeded the size limit"
            );
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        Ok::<u64, anyhow::Error>(total)
    }
    .await;
    drop(file);
    partial.complete = result.is_ok();
    result
}
#[derive(Debug, Clone)]
pub struct FileRoots {
    pub workspace: PathBuf,
    pub files: PathBuf,
    pub home: PathBuf,
}
#[derive(Debug)]
pub struct SendableFile {
    pub path: PathBuf,
    pub bytes: Vec<u8>,
}
pub fn read_sendable_file(raw: &str, roots: &FileRoots, max_bytes: u64) -> Result<SendableFile> {
    let workspace = roots.workspace.canonicalize()?;
    let files = roots
        .files
        .canonicalize()
        .unwrap_or_else(|_| roots.files.clone());
    let home = roots
        .home
        .canonicalize()
        .unwrap_or_else(|_| roots.home.clone());
    let validate = |path: &Path| -> Result<()> {
        if path.starts_with(&files) {
            return Ok(());
        }
        ensure!(
            !path.starts_with(&home) && !path.starts_with(workspace.join(".fx/telegram")),
            "Private tgfx runtime files cannot be sent"
        );
        ensure!(
            path.starts_with(&workspace),
            "Only files inside the current workspace or its Telegram downloads may be sent"
        );
        Ok(())
    };
    let path = workspace.join(raw).canonicalize()?;
    validate(&path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(&path)?;
    let meta = file.metadata()?;
    ensure!(meta.is_file(), "Only a regular workspace file may be sent");
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        validate(&std::fs::read_link(format!(
            "/proc/self/fd/{}",
            file.as_raw_fd()
        ))?)?;
    }
    #[cfg(not(target_os = "linux"))]
    {
        validate(&path.canonicalize()?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let current = std::fs::metadata(&path)?;
            ensure!(
                current.dev() == meta.dev() && current.ino() == meta.ino(),
                "The upload file changed while opening"
            );
        }
    }
    ensure!(
        meta.len() <= max_bytes,
        "This file exceeds Telegram's upload limit"
    );
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(meta.len().min(max_bytes) + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= meta.len(),
        "The upload file grew while reading"
    );
    Ok(SendableFile { path, bytes })
}
pub fn prune_files(root: &Path, max_age: std::time::Duration) -> Result<usize> {
    if !root.exists() {
        return Ok(0);
    }
    let mut n = 0;
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let m = entry.metadata()?;
        if m.modified()?.elapsed().unwrap_or_default() > max_age {
            if m.is_dir() {
                std::fs::remove_dir_all(entry.path())?;
            } else {
                std::fs::remove_file(entry.path())?;
            }
            n += 1;
        }
    }
    Ok(n)
}

struct PartialDownload {
    path: PathBuf,
    complete: bool,
}
impl Drop for PartialDownload {
    fn drop(&mut self) {
        if !self.complete {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
