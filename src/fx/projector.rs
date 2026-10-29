use super::tools::*;
use crate::{secrets::redact, types::OutputMode};
use serde_json::{Value, json};
use std::{collections::HashMap, time::Instant};
#[derive(Clone, Debug)]
enum Entry {
    Assistant {
        message_id: Option<String>,
        markdown: String,
    },
    Tool(String),
}
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolState {
    pub id: String,
    pub name: String,
    pub title: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub kind: String,
    pub status: String,
    pub input: Value,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
}
impl ToolState {
    fn description(&self) -> ToolDescription {
        describe_tool(&self.name, &self.title, &self.kind, &self.input)
    }
    fn visible(&self) -> bool {
        !self.name.is_empty() || terminal(&self.status)
    }
}
fn terminal(s: &str) -> bool {
    matches!(s, "completed" | "done" | "failed" | "error")
}
#[derive(Clone, Debug)]
enum Item {
    Assistant {
        markdown: String,
        blocks: Vec<Value>,
    },
    Tools(Vec<ToolState>),
}
pub struct Projector {
    timeline: Vec<Entry>,
    tools: HashMap<String, ToolState>,
    thought: String,
    first_thought_id: Option<String>,
    has_thought: bool,
    waiting: Option<String>,
    started: Instant,
    clock: Option<u64>,
    started_at: u64,
    changed_at: u64,
    wanted_phrase: String,
    phase: String,
    phase_since: u64,
    icons: HashMap<String, String>,
}
impl Default for Projector {
    fn default() -> Self {
        Self::new()
    }
}
impl Projector {
    pub fn new() -> Self {
        Self {
            timeline: vec![],
            tools: HashMap::new(),
            thought: String::new(),
            first_thought_id: None,
            has_thought: false,
            waiting: None,
            started: Instant::now(),
            clock: None,
            started_at: 0,
            changed_at: 0,
            wanted_phrase: "Thinking…".into(),
            phase: "Thinking…".into(),
            phase_since: 0,
            icons: HashMap::new(),
        }
    }
    pub fn set_icons(&mut self, icons: HashMap<String, String>) {
        self.icons = icons;
    }
    pub fn set_now(&mut self, now: u64) {
        if self.clock.is_none() {
            self.started_at = now;
            self.phase_since = now;
            self.changed_at = now;
        }
        self.clock = Some(now);
    }
    pub fn set_waiting(&mut self, text: Option<String>) -> &'static str {
        if self.waiting == text {
            return "none";
        }
        self.waiting = text;
        "tool"
    }
    fn now(&self) -> u64 {
        self.clock
            .unwrap_or_else(|| self.started.elapsed().as_millis() as u64)
    }
    fn progress_line(&mut self, now: u64) -> String {
        if self.wanted_phrase != self.phase
            && (!matches!(self.wanted_phrase.as_str(), "Thinking…" | "Working…")
                || now.saturating_sub(self.phase_since) >= 2500)
        {
            self.phase = self.wanted_phrase.clone();
            self.phase_since = now;
        }
        self.phase.clone()
    }
    pub fn apply(&mut self, value: &Value) -> &'static str {
        self.changed_at = self.now();
        let shown = self.phase.clone();
        let change = self.apply_update(value.get("update").unwrap_or(value));
        let line = self.progress_line(self.changed_at);
        if change == "none" && line != shown {
            "status"
        } else {
            change
        }
    }
    fn apply_update(&mut self, u: &Value) -> &'static str {
        match u["sessionUpdate"].as_str() {
            Some("agent_message_chunk") => {
                if u["content"]["type"] != "text" {
                    return "none";
                }
                let Some(text) = u["content"]["text"].as_str() else {
                    return "none";
                };
                let visible = diagnostic_offset(text).map(|i| &text[..i]).unwrap_or(text);
                if visible.is_empty() {
                    return "none";
                }
                let id = u["messageId"].as_str().map(str::to_owned);
                if let Some(Entry::Assistant {
                    message_id,
                    markdown,
                }) = self.timeline.last_mut()
                    && *message_id == id
                {
                    markdown.push_str(visible);
                    if let Some(i) = diagnostic_offset(markdown) {
                        markdown.truncate(i)
                    }
                } else {
                    self.timeline.push(Entry::Assistant {
                        message_id: id,
                        markdown: visible.into(),
                    });
                }
                if boundary_regex().is_match(visible) {
                    "boundary"
                } else {
                    "text"
                }
            }
            Some("agent_thought_chunk") => {
                if u["content"]["type"] != "text" {
                    return "none";
                }
                if !self.tools.values().any(|t| !terminal(&t.status)) {
                    self.wanted_phrase = "Thinking…".into();
                }
                let id = u["messageId"].as_str().map(str::to_owned);
                if !self.has_thought {
                    self.has_thought = true;
                    self.first_thought_id = id.clone();
                    self.thought = u["content"]["text"].as_str().unwrap_or("").into();
                } else if id == self.first_thought_id {
                    self.thought
                        .push_str(u["content"]["text"].as_str().unwrap_or(""));
                }
                "none"
            }
            Some("tool_call" | "tool_call_update") => {
                let Some(id) = u["toolCallId"].as_str() else {
                    return "none";
                };
                let now = self.now();
                let previous = self.tools.get(id).cloned();
                let t = self.tools.entry(id.into()).or_insert_with(|| {
                    self.timeline.push(Entry::Tool(id.into()));
                    ToolState {
                        id: id.into(),
                        name: String::new(),
                        title: "Tool".into(),
                        kind: String::new(),
                        status: "pending".into(),
                        input: json!({}),
                        started_at: now,
                        finished_at: None,
                    }
                });
                for (key, target) in [
                    ("name", &mut t.name),
                    ("title", &mut t.title),
                    ("kind", &mut t.kind),
                ] {
                    if let Some(value) = u[key].as_str() {
                        *target = value.into();
                    }
                }
                if u["rawInput"].is_object() {
                    t.input = u["rawInput"].clone()
                }
                if let Some(status) = u["status"].as_str()
                    && (!terminal(&t.status) || terminal(status))
                {
                    t.status = status.into();
                }
                if terminal(&t.status) {
                    t.finished_at.get_or_insert(now);
                }
                self.wanted_phrase = progress_phrase(t.description().activity).into();
                if !t.visible() {
                    return "none";
                }
                if previous.as_ref().is_none_or(|old| {
                    !old.visible()
                        || old.name != t.name
                        || old.title != t.title
                        || old.input != t.input
                }) {
                    "tool"
                } else {
                    "none"
                }
            }
            _ => "none",
        }
    }
    pub fn snapshot(&self) -> Value {
        let tools:Vec<_>=self.tool_states().iter().map(|t|{let mut v=json!({"id":t.id,"name":t.name,"title":t.title,"status":t.status,"input":t.input,"startedAt":t.started_at});if !t.kind.is_empty(){v["kind"]=json!(t.kind)}
if let Some(at)=t.finished_at{v["finishedAt"]=json!(at)}v}).collect();
        json!({"prose":self.prose(),"thought":self.thought(),"tools":tools,"changedAt":self.changed_at})
    }
    pub fn prose(&self) -> String {
        redact(
            &self
                .timeline
                .iter()
                .filter_map(|e| match e {
                    Entry::Assistant { markdown, .. } => Some(markdown.as_str()),
                    _ => None,
                })
                .collect::<String>(),
        )
    }
    pub fn thought(&self) -> String {
        redact(&self.thought)
    }
    pub fn status(&self) -> String {
        self.waiting.clone().unwrap_or_else(|| {
            if self.wanted_phrase != self.phase && self.now() - self.phase_since >= 2500 {
                self.wanted_phrase.clone()
            } else {
                self.phase.clone()
            }
        })
    }
    pub fn tool_states(&self) -> Vec<ToolState> {
        self.timeline
            .iter()
            .filter_map(|e| {
                if let Entry::Tool(id) = e {
                    self.tools.get(id).cloned()
                } else {
                    None
                }
            })
            .collect()
    }
    fn projected(&self) -> Vec<Item> {
        let mut result = vec![];
        let mut group = vec![];
        let suppress = self
            .timeline
            .iter()
            .enumerate()
            .find_map(|(i, e)| {
                if let Entry::Tool(id) = e {
                    Some(
                        if self
                            .tools
                            .get(id)
                            .is_some_and(|t| reads_telegram_guidelines(&t.input))
                        {
                            i
                        } else {
                            0
                        },
                    )
                } else {
                    None
                }
            })
            .unwrap_or(0);
        let flush = |group: &mut Vec<ToolState>, result: &mut Vec<Item>| {
            let any = !group.is_empty();
            let visible: Vec<_> = group.drain(..).filter(ToolState::visible).collect();
            let hidden = any && visible.is_empty();
            if !visible.is_empty() {
                result.push(Item::Tools(visible));
            }
            hidden
        };
        for (i, e) in self.timeline.iter().enumerate() {
            match e {
                Entry::Tool(id) => {
                    if let Some(t) = self.tools.get(id) {
                        group.push(t.clone())
                    }
                }
                Entry::Assistant { markdown, .. } => {
                    if i < suppress {
                        continue;
                    }
                    let markdown = redact(markdown);
                    let blocks = rich_blocks(&markdown);
                    if blocks.is_empty() {
                        continue;
                    }
                    let hidden = flush(&mut group, &mut result);
                    if hidden
                        && let Some(Item::Assistant {
                            blocks: previous, ..
                        }) = result.last_mut()
                        && let Some(last) = previous.last_mut()
                        && last["type"] == "paragraph"
                        && blocks[0]["type"] == "paragraph"
                    {
                        let old = last["text"].clone();
                        last["text"] = if let Some(a) = old.as_array() {
                            let mut a = a.clone();
                            a.push(json!("\n\n"));
                            json!(a)
                        } else {
                            json!([old, "\n\n"])
                        }
                    }
                    result.push(Item::Assistant { markdown, blocks });
                }
            }
        }
        flush(&mut group, &mut result);
        result
    }
    fn selected(&self, output: OutputMode, final_response: bool) -> Vec<Item> {
        let all = self.projected();
        if output.activity() {
            return all;
        }
        let mut end = all.len();
        if final_response {
            while end > 0 && matches!(all[end - 1], Item::Tools(_)) {
                end -= 1
            }
        }
        let mut start = end;
        while start > 0 && matches!(all[start - 1], Item::Assistant { .. }) {
            start -= 1
        }
        all[start..end].to_vec()
    }
    fn waiting_blocks(&self) -> Vec<Value> {
        self.waiting
            .as_ref()
            .map(|s| vec![json!({"type":"paragraph","text":{"type":"italic","text":s}})])
            .unwrap_or_default()
    }
    pub fn rich(&self, output: OutputMode, final_response: bool) -> Value {
        let items = self.selected(output, final_response);
        if items.is_empty() {
            if final_response {
                return json!({"blocks":[]});
            }
            let now = self.now();
            let waited = now.saturating_sub(self.started_at);
            let suffix = if waited >= 5000 {
                format!(" {}s", seconds(self.started_at, now))
            } else {
                String::new()
            };
            let line = if output == OutputMode::Progress {
                self.status()
            } else {
                "Thinking…".into()
            };
            let mut blocks = vec![
                json!({"type":"thinking","text":[{"type":"custom_emoji","custom_emoji_id":"5573473356579078196","alternative_text":"🙂"},format!(" {line}{suffix}")]}),
            ];
            blocks.extend(self.waiting_blocks());
            return json!({"blocks":blocks});
        }
        let mut blocks = vec![];
        for (i, item) in items.iter().enumerate() {
            match item {
                Item::Assistant { blocks: b, .. } => blocks.extend(b.clone()),
                Item::Tools(tools) => blocks.push(self.tool_group(
                    tools,
                    !final_response,
                    (!final_response && i == items.len() - 1).then(|| self.now()),
                )),
            }
        }
        if !final_response {
            blocks.extend(self.waiting_blocks())
        }
        json!({"blocks":blocks})
    }
    fn rows(&self, tools: &[ToolState]) -> Vec<(ToolState, usize)> {
        let mut rows: Vec<(ToolState, usize)> = vec![];
        for tool in tools {
            let d = tool.description();
            let key = (d.title, argument_preview(&d.argument));
            if let Some((old, n)) = rows.last_mut() {
                let o = old.description();
                if (o.title, argument_preview(&o.argument)) == key {
                    *n += 1;
                    continue;
                }
            }
            rows.push((tool.clone(), 1));
        }
        rows
    }
    fn icon(&self, t: &ToolState) -> Option<(&str, bool)> {
        let mcp = |name: &str| -> Option<&str> {
            let n = normalize_icon(name);
            let n = n.strip_prefix("mcp_")?;
            self.icons
                .iter()
                .filter(|(a, _)| n == a.as_str() || n.starts_with(&format!("{a}_")))
                .max_by_key(|(a, _)| a.len())
                .or_else(|| self.icons.get_key_value("mcp"))
                .map(|(_, id)| id.as_str())
        };
        if t.name == "mcp_features"
            && let Some(server) = t.input["server"].as_str()
            && let Some(id) = mcp(&format!("mcp_{server}"))
        {
            return Some((id, false));
        }
        if let Some(id) = self.icons.get(&format!("tool:{}", normalize_icon(&t.name))) {
            return Some((id, true));
        }
        mcp(&t.name).map(|id| (id, false))
    }
    fn tool_group(&self, tools: &[ToolState], working: bool, live_at: Option<u64>) -> Value {
        let mut blocks:Vec<Value>=self.rows(tools).iter().map(|(t,count)|{let d=t.description();let title=if *count>1{format!("{} ×{count}",d.title)}else{d.title};let preview=argument_preview(&d.argument);let icon=self.icon(t);if icon.is_none()&&preview.is_empty(){json!({"type":"paragraph","text":title})}else{let mut text=vec![];if let Some((id,fx))=icon{text.push(json!({"type":"custom_emoji","custom_emoji_id":id,"alternative_text":if fx{"🛠️"}else{"🧩"}}));text.push(json!(format!(" {title}")))}else{text.push(json!(title))}
if !preview.is_empty(){text.push(json!(" "));text.push(json!({"type":"code","text":preview}));}json!({"type":"paragraph","text":text})}}).collect();
        if let Some(at) = live_at {
            blocks.push(json!({"type":"paragraph","text":format!("⏱ {}s",seconds(tools.iter().map(|t|t.started_at).min().unwrap_or(at),at))}));
        }
        let mut v = json!({"type":"details","summary":if working{"Working...".into()}else{self.completed_summary(tools)},"blocks":blocks});
        if working {
            v["is_open"] = json!(true)
        }
        v
    }
    fn completed_summary(&self, tools: &[ToolState]) -> String {
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for t in tools {
            if terminal(&t.status)
                && !matches!(t.status.as_str(), "failed" | "error")
                && let Some(a) = t.description().activity
            {
                *counts.entry(a).or_default() += 1;
            }
        }
        let activities: Vec<_> = ACTIVITY_ORDER
            .iter()
            .filter(|a| counts.contains_key(**a))
            .collect();
        if activities.is_empty() {
            return format!(
                "Worked for {}s",
                seconds(
                    tools.iter().map(|t| t.started_at).min().unwrap_or(0),
                    tools
                        .iter()
                        .map(|t| t.finished_at.unwrap_or(self.changed_at))
                        .max()
                        .unwrap_or(0)
                )
            );
        }
        let s = activities
            .iter()
            .take(4)
            .map(|a| activity_summary(a, counts[**a]))
            .collect::<Vec<_>>()
            .join(", ");
        let mut chars = s.chars();
        let mut s = chars
            .next()
            .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
            .unwrap_or_default();
        if activities.len() > 4 {
            s.push_str(&format!(" + {} more", activities.len() - 4))
        }
        s
    }
    pub fn plain_final(&self, output: OutputMode) -> String {
        self.selected(output, true)
            .iter()
            .map(|item| match item {
                Item::Assistant { markdown, .. } => markdown.trim().to_owned(),
                Item::Tools(tools) => {
                    let rows = self
                        .rows(tools)
                        .iter()
                        .map(|(t, n)| {
                            let d = t.description();
                            let title = if *n > 1 {
                                format!("{} ×{n}", d.title)
                            } else {
                                d.title
                            };
                            let arg = argument_preview(&d.argument);
                            if arg.is_empty() {
                                title
                            } else {
                                format!("{title} {arg}")
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    format!("{}\n{rows}", self.completed_summary(tools))
                }
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}
fn seconds(from: u64, to: u64) -> u64 {
    ((to.saturating_sub(from) + 500) / 1000).max(1)
}
fn diagnostic_offset(s: &str) -> Option<usize> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?:^|\n)[\t ]*(?:\[context\][\t ]|skill discovery warning:)").unwrap()
    })
    .find(s)
    .map(|m| m.start())
}
fn rich_blocks(markdown: &str) -> Vec<Value> {
    crate::markdown::render(markdown)
        .ok()
        .and_then(|r| serde_json::to_value(r).ok())
        .and_then(|v| v["blocks"].as_array().cloned())
        .unwrap_or_default()
}

pub fn default_icons() -> HashMap<String, String> {
    let definitions: Vec<Value> =
        serde_json::from_str(include_str!("../telegram/icons.json")).unwrap_or_default();
    let mut icons = HashMap::new();
    for icon in definitions {
        let Some(id) = icon["customEmojiId"].as_str() else {
            continue;
        };
        let tool = icon["kind"] == "tool";
        if let Some(aliases) = icon["aliases"].as_array() {
            for alias in aliases {
                if let Some(alias) = alias.as_str() {
                    let key = normalize_icon(alias);
                    icons.insert(
                        if tool { format!("tool:{key}") } else { key },
                        id.to_owned(),
                    );
                }
            }
        }
    }
    icons
}

fn boundary_regex() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r#"(?:\n\s*\n|[.!?](?:["')\]]*)\s*|```\s*|\$\$\s*)$"#).unwrap()
    })
}

fn normalize_icon(s: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new("[^a-z0-9]+").unwrap())
        .replace_all(&s.to_lowercase(), "_")
        .trim_matches('_')
        .to_string()
}
