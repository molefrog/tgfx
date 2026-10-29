pub use crate::types::MemoryOptions;
use anyhow::{Context, Result, bail};
use comrak::{Arena, nodes::NodeValue, parse_document};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

/// A per-session memory cursor. Preparing is transactional: only commit after a completed turn.
pub struct SessionMemory {
    root: PathBuf,
    options: MemoryOptions,
    previous: Option<String>,
}
pub struct PreparedMemory {
    pub block: Option<Value>,
    snapshot: String,
}
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\"', "&quot;")
}
impl SessionMemory {
    pub fn new(root: impl Into<PathBuf>, options: MemoryOptions) -> Result<Self> {
        let file = Path::new(&options.file);
        if file.is_absolute()
            || file
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            bail!("Memory file must be inside the working directory")
        }
        Ok(Self {
            root: root.into(),
            options,
            previous: None,
        })
    }
    pub fn reset(&mut self) {
        self.previous = None;
    }
    fn read(&self) -> Result<String> {
        let root = self.root.canonicalize()?;
        let path = match root.join(&self.options.file).canonicalize() {
            Ok(p) => p,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
            Err(e) => return Err(e.into()),
        };
        if path == root || !path.starts_with(&root) {
            bail!("Memory file must be inside the working directory")
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let mut file = options.open(&path).context("Cannot read memory")?;
        if !file.metadata()?.is_file() {
            bail!("Memory must be a regular file")
        }
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            let opened = std::fs::canonicalize(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
            if !opened.starts_with(&root) {
                bail!("Memory file moved outside the working directory")
            }
        }
        let mut text = String::new();
        file.read_to_string(&mut text)?;
        Ok(text.replace("\r\n", "\n"))
    }
    pub fn prepare(&self) -> Result<PreparedMemory> {
        if !self.options.enabled {
            return Ok(PreparedMemory {
                block: None,
                snapshot: self.previous.clone().unwrap_or_default(),
            });
        }
        let current = self.read()?;
        let (action, content) = match memory_change(self.previous.as_deref(), &current) {
            MemoryChange::Initial => (
                "initial",
                format!("Your persistent memory, shared across conversations.\n\n{current}"),
            ),
            MemoryChange::Append(sections) => (
                "append",
                format!(
                    "These sections were added to your memory:\n\n{}",
                    sections.join("\n\n")
                ),
            ),
            MemoryChange::Reread => (
                "reread",
                format!(
                    "Your memory has changed. Read {} before continuing and use its current contents instead of the earlier version.",
                    self.options.file
                ),
            ),
            MemoryChange::Clear => (
                "clear",
                format!(
                    "Your memory has been cleared. Disregard the contents previously provided from {}.",
                    self.options.file
                ),
            ),
            MemoryChange::Unchanged => ("", String::new()),
        };
        let block = if action.is_empty() {
            None
        } else {
            let tag = if action == "initial" {
                "memory"
            } else {
                "memory-update"
            };
            let attr = if action == "initial" {
                String::new()
            } else {
                format!(" action=\"{action}\"")
            };
            Some(
                json!({"type":"text","text":format!("<{tag}{attr} source=\"{}\">\n{}\n</{tag}>",xml(&self.options.file),xml(&content))}),
            )
        };
        Ok(PreparedMemory {
            block,
            snapshot: current,
        })
    }
    pub fn commit(&mut self, prepared: PreparedMemory) {
        self.previous = Some(prepared.snapshot);
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub heading: Option<String>,
    pub text: String,
    pub hash: Vec<u8>,
}
pub fn sections(source: &str) -> Vec<Section> {
    let arena = Arena::new();
    let root = parse_document(&arena, source, &comrak::Options::default());
    let mut starts = vec![(0, None)];
    let mut lines = vec![0];
    for (i, b) in source.bytes().enumerate() {
        if b == b'\n' {
            lines.push(i + 1);
        }
    }
    for n in root.children() {
        if let NodeValue::Heading(h) = &n.data().value
            && h.level == 1
        {
            let at = lines[n.data().sourcepos.start.line - 1];
            let name = n
                .descendants()
                .filter_map(|c| match &c.data().value {
                    NodeValue::Text(t) => Some(t.to_string()),
                    NodeValue::Code(c) => Some(c.literal.to_string()),
                    NodeValue::SoftBreak | NodeValue::LineBreak => Some("\n".into()),
                    _ => None,
                })
                .collect::<String>();
            if at == 0 {
                starts.clear();
            }
            starts.push((at, Some(name)));
        }
    }
    starts
        .iter()
        .enumerate()
        .filter_map(|(i, (at, name))| {
            let end = starts.get(i + 1).map(|x| x.0).unwrap_or(source.len());
            let text = source[*at..end].trim_end();
            if text.trim().is_empty() {
                None
            } else {
                Some(Section {
                    heading: name.clone(),
                    text: text.into(),
                    hash: Sha256::digest(text).to_vec(),
                })
            }
        })
        .collect()
}
#[derive(Debug, PartialEq, Eq)]
pub enum MemoryChange {
    Initial,
    Append(Vec<String>),
    Reread,
    Clear,
    Unchanged,
}
pub fn memory_change(before: Option<&str>, after: &str) -> MemoryChange {
    let Some(before) = before.filter(|s| !s.trim().is_empty()) else {
        return if after.trim().is_empty() {
            MemoryChange::Unchanged
        } else {
            MemoryChange::Initial
        };
    };
    if after.trim().is_empty() {
        return MemoryChange::Clear;
    }
    if before == after {
        return MemoryChange::Unchanged;
    }
    let a = sections(before);
    let b = sections(after);
    let unique = |s: &[Section]| {
        let mut keys = std::collections::HashSet::new();
        s.iter().all(|x| keys.insert(&x.heading))
    };
    let retained: Vec<_> = b
        .iter()
        .filter(|n| a.iter().any(|o| o.heading == n.heading))
        .collect();
    if !unique(&a)
        || !unique(&b)
        || retained.len() != a.len()
        || retained
            .iter()
            .zip(&a)
            .any(|(n, o)| n.heading != o.heading || n.hash != o.hash)
    {
        return MemoryChange::Reread;
    }
    let added: Vec<_> = b
        .iter()
        .filter(|n| !a.iter().any(|o| o.heading == n.heading))
        .map(|s| s.text.clone())
        .collect();
    if added.is_empty() {
        MemoryChange::Unchanged
    } else {
        MemoryChange::Append(added)
    }
}
