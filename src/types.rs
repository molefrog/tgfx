use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum OutputMode {
    Final,
    #[default]
    Live,
    Detailed,
}
impl OutputMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Final => "final",
            Self::Live => "live",
            Self::Detailed => "detailed",
        }
    }
    pub fn activity(self) -> bool {
        self == Self::Detailed
    }
    pub fn streams(self) -> bool {
        matches!(self, Self::Live | Self::Detailed)
    }
}
impl std::fmt::Display for OutputMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}
impl std::str::FromStr for OutputMode {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> anyhow::Result<Self> {
        Ok(match s {
            "final" => Self::Final,
            "live" => Self::Live,
            "detailed" => Self::Detailed,
            _ => anyhow::bail!("Unknown output mode {s}"),
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    #[serde(default)]
    pub user_ids: Vec<String>,
    #[serde(default)]
    pub chat_ids: Vec<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approvals {
    pub chat_id: String,
    #[serde(default = "zero")]
    pub topic_id: String,
}
pub fn zero() -> String {
    "0".into()
}
pub fn yes() -> bool {
    true
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryOptions {
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "memory_file")]
    pub file: String,
}
fn memory_file() -> String {
    "MEMORY.md".into()
}
impl Default for MemoryOptions {
    fn default() -> Self {
        Self {
            enabled: true,
            file: memory_file(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    pub active_bot_id: String,
    pub access: Access,
    pub approvals: Approvals,
    #[serde(default)]
    pub output: OutputMode,
    #[serde(default = "yes")]
    pub custom_icons: bool,
    #[serde(default = "yes")]
    pub image_previews: bool,
    #[serde(default = "dm_reply")]
    pub dm_reply: String,
    #[serde(default = "group_reply")]
    pub group_reply: String,
    #[serde(default)]
    pub chat_replies: HashMap<String, String>,
    #[serde(default)]
    pub chat_formats: HashMap<String, OutputMode>,
    #[serde(default)]
    pub memory: MemoryOptions,
}
fn dm_reply() -> String {
    "all".into()
}
fn group_reply() -> String {
    "mention".into()
}
impl Config {
    pub fn output_for(&self, route: &Route) -> OutputMode {
        if route.chat_kind == "private" {
            self.chat_formats
                .get(&route.chat_id)
                .copied()
                .unwrap_or(self.output)
        } else {
            OutputMode::Final
        }
    }
    pub fn allows(&self, user: Option<&str>, chat: &str) -> bool {
        self.access.chat_ids.iter().any(|c| c == chat)
            || user.is_some_and(|u| self.access.user_ids.iter().any(|v| v == u))
    }
    pub fn reply_policy(&self, route: &Route) -> &str {
        self.chat_replies
            .get(&route.chat_id)
            .map(String::as_str)
            .unwrap_or(if route.chat_kind == "private" {
                &self.dm_reply
            } else {
                &self.group_reply
            })
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub key: String,
    pub bot_id: String,
    pub chat_id: String,
    pub topic_id: String,
    pub chat_kind: String,
}
impl Route {
    pub fn new(
        bot: impl Into<String>,
        chat: impl Into<String>,
        topic: impl Into<String>,
        kind: impl Into<String>,
    ) -> Self {
        let (bot_id, chat_id, topic_id) = (bot.into(), chat.into(), topic.into());
        Self {
            key: format!("{bot_id}:{chat_id}:{topic_id}"),
            bot_id,
            chat_id,
            topic_id,
            chat_kind: kind.into(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotIdentity {
    pub id: String,
    pub username: Option<String>,
    pub display_name: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SenderIdentity {
    pub kind: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub language_code: Option<String>,
    #[serde(default)]
    pub is_bot: bool,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    #[serde(rename = "ref")]
    pub reference: String,
    pub kind: String,
    pub file_id: String,
    pub file_unique_id: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub sticker_name: Option<String>,
    #[serde(default)]
    pub emoji: Option<String>,
    #[serde(default)]
    pub custom_emoji_id: Option<String>,
    #[serde(default)]
    pub local_path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundMessage {
    #[serde(default)]
    pub invokes_agent: Option<bool>,
    #[serde(default)]
    pub history_seq: Option<i64>,
    #[serde(default)]
    pub history_message_ids: Option<Vec<String>>,
    pub update_id: i64,
    pub event: String,
    pub route: Route,
    pub sender: SenderIdentity,
    pub message_id: String,
    pub message_ref: String,
    pub context_ref: String,
    pub timestamp: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub text_kind: Option<String>,
    #[serde(default)]
    pub location: Option<Value>,
    #[serde(default)]
    pub venue: Option<Value>,
    #[serde(default)]
    pub attachments: Vec<AttachmentRef>,
    #[serde(default)]
    pub reply: Option<Value>,
    #[serde(default)]
    pub provenance: Option<Value>,
    pub raw: Value,
}
pub fn new_ref(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4())
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn decimal(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::to_owned)
        .or_else(|| v.as_i64().map(|n| n.to_string()))
        .or_else(|| v.as_u64().map(|n| n.to_string()))
}
