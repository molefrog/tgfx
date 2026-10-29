//! MCP adapters for the same file boundary used by incoming Telegram media.
pub use crate::files::{safe_download_path, safe_name, temporary_download_directory};
use anyhow::Result;
use std::path::{Path, PathBuf};
pub fn read_sendable_file(
    raw: &str,
    workspace: &Path,
    files: &Path,
    home: &Path,
    max: usize,
) -> Result<(PathBuf, Vec<u8>)> {
    let file = crate::files::read_sendable_file(
        raw,
        &crate::files::FileRoots {
            workspace: workspace.into(),
            files: files.into(),
            home: home.into(),
        },
        max as u64,
    )?;
    Ok((file.path, file.bytes))
}
pub async fn write_response_limited(
    response: reqwest::Response,
    path: &Path,
    max: usize,
) -> Result<usize> {
    Ok(crate::files::write_response_limited(response, path, max as u64).await? as usize)
}
