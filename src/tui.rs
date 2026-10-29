//! Inline terminal status. Runtime state stays in the controller; the UI sends commands.
use crate::{secrets::redact, types::Config};
use anyhow::Result;
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    terminal::{disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    TerminalOptions, Viewport,
    prelude::*,
    widgets::{Block, Paragraph},
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    io,
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub enum UiCommand {
    Paused(bool),
    Icons(bool),
    Reply {
        target: String,
        policy: Option<String>,
    },
}
#[derive(Clone, Default)]
pub struct RouteView {
    pub chat: String,
    pub who: String,
    pub state: String,
    pub trace: String,
    pub queued: u64,
    pub model: String,
    pub since: Option<Instant>,
}
pub struct StatusView {
    pub bot: String,
    pub paused: bool,
    pub icons: bool,
    pub yolo: bool,
    pub no_color: bool,
    pub poll: String,
    pub routes: BTreeMap<String, RouteView>,
    pub logs: VecDeque<String>,
    pub show_logs: bool,
    pub reply_menu: bool,
    pub selection: usize,
    pub frame: u64,
    pub dm_reply: String,
    pub group_reply: String,
    pub chats: Vec<String>,
    pub reply_target: usize,
}
impl StatusView {
    pub fn new(config: &Config, bot: String, yolo: bool) -> Self {
        Self {
            bot,
            paused: false,
            icons: config.custom_icons,
            yolo,
            no_color: std::env::var_os("NO_COLOR").is_some(),
            poll: "starting".into(),
            routes: BTreeMap::new(),
            logs: VecDeque::new(),
            show_logs: false,
            reply_menu: false,
            selection: 0,
            frame: 0,
            dm_reply: config.dm_reply.clone(),
            group_reply: config.group_reply.clone(),
            chats: config
                .access
                .user_ids
                .iter()
                .chain(&config.access.chat_ids)
                .cloned()
                .collect(),
            reply_target: 0,
        }
    }
    pub fn apply(&mut self, v: &Value) {
        let kind = v["type"]
            .as_str()
            .or_else(|| v["event"].as_str())
            .unwrap_or("status");
        if kind == "boot" && v["step"] == "polling" && v["state"] == "done" {
            self.poll = "listening".into();
        }
        if kind == "poll" || kind.starts_with("poll.") {
            self.poll = v["state"]
                .as_str()
                .unwrap_or(if kind.contains("error") {
                    "reconnecting"
                } else {
                    "listening"
                })
                .into();
        }
        if kind == "settings" {
            let s = v.get("settings").unwrap_or(v);
            if let Some(x) = s["paused"].as_bool() {
                self.paused = x;
            }
            if let Some(x) = s["customIcons"].as_bool() {
                self.icons = x;
            }
            if let Some(x) = s["dmReply"].as_str() {
                self.dm_reply = x.into();
            }
            if let Some(x) = s["groupReply"].as_str() {
                self.group_reply = x.into();
            }
            if let Some(chats) = s["allowedChats"].as_array() {
                self.chats = chats
                    .iter()
                    .filter_map(|c| c.as_str().map(str::to_owned))
                    .collect();
                self.reply_target = self.reply_target.min(self.chats.len() + 1);
            }
        }
        let key = v["route"]["key"]
            .as_str()
            .or_else(|| v["route_key"].as_str())
            .or_else(|| {
                if kind == "log" {
                    None
                } else {
                    v["chat"].as_str()
                }
            });
        if let Some(key) = key {
            let r = self.routes.entry(key.into()).or_default();
            r.chat = v["route"]["chat"]
                .as_str()
                .or_else(|| v["chat"].as_str())
                .unwrap_or(key)
                .into();
            if let Some(w) = v["who"].as_str() {
                r.who = w.into();
            }
            if let Some(m) = v["model"].as_str() {
                r.model = m.into();
            }
            if let Some(q) = v["waiting"].as_u64().or_else(|| v["queued"].as_u64()) {
                r.queued = q;
            }
            let state = v["state"].as_str().unwrap_or(kind);
            r.state = state.into();
            if state == "started" || kind == "turn.started" {
                r.since = Some(Instant::now());
                r.trace.clear();
            }
            if let Some(g) = v["glyph"].as_str() {
                r.trace.push_str(g);
                r.trace = r
                    .trace
                    .chars()
                    .rev()
                    .take(35)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
            }
            if kind.contains("deliver") || state == "finished" {
                r.state = v["outcome"].as_str().unwrap_or("delivered").into();
                r.since = None;
            }
        }
        let text = v["message"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{kind} {}", v["state"].as_str().unwrap_or("")));
        self.logs.push_back(redact(&text));
        while self.logs.len() > 200 {
            self.logs.pop_front();
        }
    }
    pub fn key(&mut self, key: KeyCode) -> Option<UiCommand> {
        if self.reply_menu {
            match key {
                KeyCode::Esc => self.reply_menu = false,
                KeyCode::Up => self.selection = self.selection.saturating_sub(1),
                KeyCode::Down => self.selection = (self.selection + 1).min(2),
                KeyCode::Tab => {
                    self.reply_target = (self.reply_target + 1) % (self.chats.len() + 2);
                }
                KeyCode::Char(c) if ('1'..='3').contains(&c) => {
                    self.selection = c as usize - '1' as usize;
                }
                KeyCode::Enter => {
                    self.reply_menu = false;
                    let target = if self.reply_target == 0 {
                        "dm".into()
                    } else if self.reply_target == 1 {
                        "groups".into()
                    } else {
                        self.chats[self.reply_target - 2].clone()
                    };
                    let policy = match self.selection {
                        0 => Some("all".into()),
                        1 => Some("mention".into()),
                        _ => None,
                    };
                    return Some(UiCommand::Reply { target, policy });
                }
                _ => {}
            }
            return None;
        }
        match key {
            KeyCode::Char('r') => {
                self.reply_menu = true;
                self.selection = 0;
            }
            KeyCode::Char('l') => self.show_logs = !self.show_logs,
            KeyCode::Char('p') => {
                self.paused = !self.paused;
                return Some(UiCommand::Paused(self.paused));
            }
            KeyCode::Char('i') => {
                self.icons = !self.icons;
                return Some(UiCommand::Icons(self.icons));
            }
            _ => {}
        }
        None
    }
    pub fn draw(&self, f: &mut Frame) {
        let spin = ["◐", "◓", "◑", "◒"][self.frame as usize % 4];
        let mut lines = vec![
            Line::from(vec![
                Span::styled(format!("@{} ", self.bot), self.style(Color::Cyan)),
                Span::raw(format!(
                    "{} ─── tgfx ─── {} fx",
                    if self.paused {
                        "⏸ paused"
                    } else {
                        &self.poll
                    },
                    spin
                )),
            ]),
            Line::from(format!(
                "icons {}{}",
                if self.icons { "on" } else { "off" },
                if self.yolo { " · YOLO" } else { "" }
            )),
        ];
        for route in self.routes.values().rev().take(5) {
            let elapsed = route
                .since
                .map(|s| format!(" {}s", s.elapsed().as_secs()))
                .unwrap_or_default();
            lines.push(Line::from(format!(
                "  {} {} · {}{} {}{}",
                route.chat,
                route.who,
                route.state,
                elapsed,
                route.trace,
                if route.queued > 0 {
                    format!(" +{} waiting", route.queued)
                } else {
                    String::new()
                }
            )));
        }
        if self.routes.is_empty() {
            lines.push(Line::from("  Waiting for Telegram messages…"));
        }
        if self.reply_menu {
            let choices = ["Every message", "Mentions or replies", "Inherit"];
            let title = format!(
                "Replies · {} (Tab changes target)",
                if self.reply_target == 0 {
                    "DMs"
                } else if self.reply_target == 1 {
                    "groups"
                } else {
                    &self.chats[self.reply_target - 2]
                }
            );
            lines.push(Line::from(title));
            for (i, c) in choices.iter().enumerate() {
                lines.push(Line::styled(
                    format!("{} {}", if i == self.selection { "›" } else { " " }, c),
                    self.style(if i == self.selection {
                        Color::Cyan
                    } else {
                        Color::Gray
                    }),
                ));
            }
            lines.push(Line::from("↑↓ select · Enter apply · Esc cancel"));
        } else {
            lines.push(Line::styled(
                "r replies · p pause · i icons · l logs · q quit",
                self.style(Color::DarkGray),
            ));
        }
        if self.show_logs {
            for line in self
                .logs
                .iter()
                .rev()
                .take(6)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
            {
                lines.push(Line::from(line.as_str()));
            }
        }
        f.render_widget(Paragraph::new(lines).block(Block::default()), f.area());
    }
    fn style(&self, color: Color) -> Style {
        if self.no_color {
            Style::default()
        } else {
            Style::default().fg(color)
        }
    }
}
struct Restore;
impl Drop for Restore {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = crossterm::execute!(io::stdout(), crossterm::cursor::Show);
    }
}
pub fn run(
    mut status: broadcast::Receiver<Value>,
    commands: mpsc::UnboundedSender<UiCommand>,
    shutdown: CancellationToken,
    mut view: StatusView,
) -> Result<()> {
    enable_raw_mode()?;
    let _restore = Restore;
    let mut terminal = ratatui::Terminal::with_options(
        CrosstermBackend::new(io::stdout()),
        TerminalOptions {
            viewport: Viewport::Inline(18),
        },
    )?;
    while !shutdown.is_cancelled() {
        while let Ok(event) = status.try_recv() {
            view.apply(&event);
        }
        terminal.draw(|f| view.draw(f))?;
        if event::poll(Duration::from_millis(80))?
            && let Event::Key(k) = event::read()?
            && k.kind == KeyEventKind::Press
        {
            if k.code == KeyCode::Char('q') && !view.reply_menu
                || k.code == KeyCode::Char('c')
                    && k.modifiers.contains(event::KeyModifiers::CONTROL)
            {
                shutdown.cancel();
                break;
            }
            if let Some(c) = view.key(k.code) {
                let _ = commands.send(c);
            }
        }
        view.frame += 1;
    }
    terminal.show_cursor()?;
    Ok(())
}
