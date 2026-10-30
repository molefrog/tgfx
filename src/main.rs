use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use serde_json::{Value, json};
use std::{
    io::{self, IsTerminal},
    path::{Path, PathBuf},
};
use tgfx::{
    config, secrets,
    telegram::TelegramApi,
    types::{BotIdentity, Config, OutputMode},
};
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(version, about = "Run a local fx agent through Telegram")]
struct Cli {
    /// Default reply style for DMs without a saved choice
    #[arg(long, value_enum, global = true)]
    output: Option<OutputMode>,
    #[arg(long, global = true)]
    yolo: bool,
    #[arg(long, global = true)]
    no_icons: bool,
    #[arg(long, global = true)]
    no_tui: bool,
    #[arg(long, global = true)]
    json: bool,
    #[arg(long, global = true)]
    no_color: bool,
    #[arg(long, global = true)]
    debug: bool,
    #[arg(long, global = true)]
    model: Option<String>,
    #[arg(long, global = true)]
    cwd: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Command>,
}
#[derive(Subcommand)]
enum Command {
    /// Submit a durable external event to the running controller.
    Emit(Emit),
    /// Show access policy, approval destination, reply settings and routes.
    Access,
    /// Grant access or adjust reply policy; without IDs, pair another user.
    Allow(Allow),
    /// Remove users/chats from the allowlist.
    Deny {
        #[arg(allow_negative_numbers=true,num_args=1..)]
        ids: Vec<String>,
    },
    /// Show or change the approval chat/topic.
    Approvals {
        #[arg(allow_negative_numbers = true)]
        target: Option<String>,
    },
    /// Add, replace or remove a saved bot token.
    Auth {
        #[arg(long)]
        remove: bool,
    },
    /// Inspect or clear observed chat history.
    History {
        #[arg(value_parser=["clear"])]
        action: Option<String>,
        #[arg(long, allow_negative_numbers = true)]
        chat: Option<String>,
    },
    /// Check Telegram, FX and storage readiness.
    Doctor,
    Version,
    #[command(hide = true)]
    Mcp,
    #[command(name = "mcp-proxy", hide = true)]
    McpProxy,
}
#[derive(Args)]
struct Allow {
    #[arg(allow_negative_numbers = true)]
    ids: Vec<String>,
    #[arg(long)]
    chat: bool,
    #[arg(long,value_parser=["all","mention"])]
    reply: Option<String>,
    #[arg(long)]
    inherit: bool,
    #[arg(long,value_parser=["all","mention"])]
    dm: Option<String>,
    #[arg(long,value_parser=["all","mention"])]
    groups: Option<String>,
}
#[derive(Args)]
struct Emit {
    name: Option<String>,
    #[arg(long, allow_negative_numbers = true)]
    chat: Option<String>,
    #[arg(long)]
    topic: Option<String>,
    #[arg(long)]
    id: Option<String>,
    #[arg(long, conflicts_with = "payload_file")]
    payload: Option<String>,
    #[arg(long)]
    payload_file: Option<String>,
    #[arg(long)]
    prompt: Option<String>,
    #[arg(long)]
    steer: bool,
    #[arg(long)]
    wait: bool,
    #[arg(long)]
    status: Option<String>,
}
#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let debug = cli.debug;
    if let Err(e) = execute(cli).await {
        eprintln!(
            "{}",
            secrets::redact(&if debug {
                format!("{e:?}")
            } else {
                format!("{e:#}")
            })
        );
        std::process::exit(1);
    }
}
fn need_terminal() -> Result<()> {
    if !io::stdin().is_terminal() {
        bail!(
            "Setup requires an interactive terminal. Initialize this folder first or supply TELEGRAM_BOT_TOKEN and policy.json in TGFX_RUNTIME_DIR."
        )
    };
    Ok(())
}
fn canonical_id(raw: &str, negative: bool) -> Result<String> {
    let raw = raw.trim();
    config::validate_id(raw, negative)?;
    let digits = raw.trim_start_matches('-').trim_start_matches('0');
    if digits.is_empty() {
        return Ok("0".into());
    }
    Ok(format!(
        "{}{}",
        if raw.starts_with('-') { "-" } else { "" },
        digits
    ))
}
fn interactive(cli: &Cli) -> bool {
    !cli.no_tui
        && !cli.json
        && io::stdin().is_terminal()
        && io::stdout().is_terminal()
        && io::stderr().is_terminal()
        && std::env::var("TERM").is_ok_and(|s| s != "dumb")
        && !["CI", "CONTINUOUS_INTEGRATION"].iter().any(|name| {
            std::env::var(name).is_ok_and(|s| !s.is_empty() && s != "0" && s != "false")
        })
}
fn ask(question: &str) -> Result<String> {
    use std::io::Write;
    eprint!("{question}");
    io::stderr().flush()?;
    let mut text = String::new();
    if io::stdin().read_line(&mut text)? == 0 {
        bail!("Setup input ended")
    };
    Ok(text.trim().into())
}
fn parse_ids(input: &str) -> Result<tgfx::types::Access> {
    let mut access = tgfx::types::Access::default();
    for id in input
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
    {
        let id = canonical_id(id, true)?;
        let list = if id.starts_with('-') {
            &mut access.chat_ids
        } else {
            &mut access.user_ids
        };
        if !list.contains(&id) {
            list.push(id);
        }
    }
    if access.user_ids.is_empty() && access.chat_ids.is_empty() {
        bail!("Specify at least one numeric user or chat ID")
    };
    Ok(access)
}
async fn test_approvals(t: &TelegramApi, bot: &str, chat: &str, topic: &str) -> Result<()> {
    t.call("getChat", json!({"chat_id":chat})).await?;
    let route = tgfx::types::Route::new(
        bot,
        chat,
        topic,
        if chat.starts_with('-') {
            "supergroup"
        } else {
            "private"
        },
    );
    t.send_text(&route, "TGFX approvals will be sent here.")
        .await?;
    Ok(())
}
fn required(w: &Path) -> Result<Config> {
    config::load(w)?.context("This workspace is not initialized. Run tgfx interactively first.")
}
fn api(token: &str) -> Result<TelegramApi> {
    TelegramApi::new(token, std::env::var("TGFX_API_ROOT").ok().as_deref())
}
fn token(c: &Config) -> Result<String> {
    secrets::get(&c.active_bot_id)?
        .context("Telegram token is missing; use tgfx auth or TELEGRAM_BOT_TOKEN")
}
fn target(s: &str) -> Result<(String, String)> {
    let (c, t) = s.split_once('/').unwrap_or((s, "0"));
    Ok((canonical_id(c, true)?, canonical_id(t, false)?))
}
async fn pair(t: &TelegramApi, b: &BotIdentity) -> Result<(String, String)> {
    need_terminal()?;
    let code = format!("tgfx-{}", uuid::Uuid::new_v4().simple());
    let link = format!(
        "https://t.me/{}?start={code}",
        b.username.as_deref().context("Bot has no username")?
    );
    eprintln!("Open this link and press Start to pair your account:\n{link}");
    if let Ok(qr) = qrcode::QrCode::new(link.as_bytes()) {
        eprintln!(
            "{}",
            qr.render::<qrcode::render::unicode::Dense1x2>()
                .quiet_zone(true)
                .build()
        );
    }
    let mut offset = 0i64;
    loop {
        let updates = t
            .call(
                "getUpdates",
                json!({"offset":offset,"timeout":10,"allowed_updates":["message"]}),
            )
            .await?;
        for u in updates.as_array().context("Invalid update response")? {
            if let Some(id) = u["update_id"].as_i64() {
                offset = id + 1;
            }
            let m = &u["message"];
            if m["chat"]["type"] == "private" && m["text"] == format!("/start {code}") {
                let user = tgfx::types::decimal(&m["from"]["id"]).context("Missing sender")?;
                let chat = tgfx::types::decimal(&m["chat"]["id"]).context("Missing chat")?;
                t.call("getUpdates", json!({"offset":offset,"timeout":0}))
                    .await?;
                t.call("sendMessage",json!({"chat_id":chat,"text":"Paired. TGFX will use your account for access and approvals."})).await?;
                return Ok((user, chat));
            }
        }
    }
}
async fn initialized(
    w: &Path,
    allow_setup: bool,
) -> Result<(Config, String, TelegramApi, BotIdentity)> {
    let existing = config::load(w)?;
    if existing.is_none() && !allow_setup {
        bail!(
            "This folder is not initialized. Run tgfx in an interactive terminal to connect a bot."
        );
    }
    let mut supplied = if let Some(c) = &existing {
        secrets::get(&c.active_bot_id)?
    } else {
        std::env::var("TELEGRAM_BOT_TOKEN")
            .ok()
            .filter(|s| !s.trim().is_empty())
    };
    let prompted = supplied.is_none();
    if supplied.is_none() {
        if !allow_setup {
            bail!("Telegram token is missing; use tgfx auth or TELEGRAM_BOT_TOKEN");
        }
        need_terminal()?;
        supplied = Some(rpassword::prompt_password("Telegram bot token (hidden): ")?);
    }
    let token = supplied.unwrap().trim().to_owned();
    let t = api(&token)?;
    let b = t.get_me().await?;
    if let Some(c) = &existing
        && c.active_bot_id != b.id
    {
        bail!(
            "Token belongs to bot {}, this folder uses {}. Use tgfx auth to switch.",
            b.id,
            c.active_bot_id
        )
    }
    if t.call("getWebhookInfo", json!({})).await?["url"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        bail!("Bot has an active webhook; remove it before using long polling")
    }
    let setup_lock = if existing.is_none() {
        Some(tgfx::lock::RuntimeLock::acquire(&b.id, w)?)
    } else {
        None
    };
    let c = if let Some(c) = existing {
        c
    } else {
        need_terminal()?;
        let choice = ask("Setup: [1] Pair by link/QR (default), [2] Enter numeric IDs: ")?;
        let (access, chat, topic) = if choice == "2" {
            let access = parse_ids(&ask(
                "Allowed user IDs / negative chat IDs (comma separated): ",
            )?)?;
            let (chat, topic) = target(&ask("Approvals chat ID[/topic ID]: ")?)?;
            (access, chat, topic)
        } else {
            let (user, chat) = pair(&t, &b).await?;
            (
                tgfx::types::Access {
                    user_ids: vec![user],
                    chat_ids: vec![],
                },
                chat,
                "0".into(),
            )
        };
        test_approvals(&t, &b.id, &chat, &topic).await?;
        let c: Config = serde_json::from_value(
            json!({"version":1,"activeBotId":b.id,"access":access,"approvals":{"chatId":chat,"topicId":topic}}),
        )?;
        config::save(w, &c)?;
        required(w)?
    };
    if prompted {
        secrets::set(&b.id, &token)?;
        eprintln!("Bot token saved: {}.", secrets::source(&b.id)?);
    }
    drop(setup_lock);
    Ok((c, token, t, b))
}
async fn execute(cli: Cli) -> Result<()> {
    let show_tui = interactive(&cli);
    let w = config::absolute(&cli.cwd.clone().unwrap_or(std::env::current_dir()?))?;
    match cli.command {
        Some(Command::Version) => println!("{}", env!("CARGO_PKG_VERSION")),
        Some(Command::Mcp) => tgfx::mcp::serve().await?,
        Some(Command::McpProxy) => tgfx::mcp::proxy().await?,
        Some(Command::Emit(args)) => emit(args, &w).await?,
        Some(Command::Auth { remove }) => {
            config::assert_policy_writable()?;
            if remove {
                let c = required(&w)?;
                secrets::remove(&c.active_bot_id)?;
                println!("Removed saved token for {}", c.active_bot_id);
            } else {
                need_terminal()?;
                let raw = rpassword::prompt_password("Telegram bot token (hidden): ")?;
                let b = api(raw.trim())?.get_me().await?;
                secrets::set(&b.id, raw.trim())?;
                if let Some(mut c) = config::load(&w)? {
                    c.active_bot_id = b.id.clone();
                    config::save(&w, &c)?;
                }
                println!(
                    "Saved token for @{}",
                    b.username.as_deref().unwrap_or(&b.id)
                );
            }
        }
        Some(Command::Access) => {
            let c = required(&w)?;
            let p = config::workspace_paths(&c.active_bot_id, &w)?;
            let routes = if p.database.exists() {
                tgfx::state::State::open(&p.database,&w)?.query("SELECT chat_id,topic_id,session_id,generation,updated_at FROM routes WHERE bot_id=?",[&c.active_bot_id])?
            } else {
                vec![]
            };
            let principals = c
                .access
                .user_ids
                .iter()
                .map(|id| json!({"id":id,"kind":"user"}))
                .chain(
                    c.access
                        .chat_ids
                        .iter()
                        .map(|id| json!({"id":id,"kind":"chat"})),
                )
                .collect::<Vec<_>>();
            let sessions=routes.iter().map(|r|json!({"chat":r["chat_id"],"topic":r["topic_id"],"session":r["session_id"],"generation":r["generation"],"lastActive":r["updated_at"]})).collect::<Vec<_>>();
            let value = json!({"bot":c.active_bot_id,"workspace":w,"access":principals,"approvals":c.approvals,"settings":{"output":c.output,"customIcons":c.custom_icons,"imagePreviews":c.image_previews,"dmReply":c.dm_reply,"groupReply":c.group_reply,"chatReplies":c.chat_replies,"chatFormats":c.chat_formats},"sessions":sessions});
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&value)?);
            } else {
                println!(
                    "Users: {}\nChats: {}\nDM replies: {} · groups: {}\nApprovals: {}/{}\nRoutes: {}",
                    c.access.user_ids.join(", "),
                    c.access.chat_ids.join(", "),
                    c.dm_reply,
                    c.group_reply,
                    c.approvals.chat_id,
                    c.approvals.topic_id,
                    routes.len()
                );
            }
        }
        Some(Command::Allow(a)) => {
            let mut c = required(&w)?;
            let mut changed = Vec::new();
            if a.dm.is_some() {
                changed.push("dmReply");
            }
            if a.groups.is_some() {
                changed.push("groupReply");
            }
            if a.reply.is_some() || a.inherit {
                changed.push("chatReplies");
            }
            if a.reply.is_some() && a.inherit {
                bail!("Choose --reply or --inherit")
            }
            if a.dm.is_some() || a.groups.is_some() {
                if !a.ids.is_empty() || a.chat || a.reply.is_some() || a.inherit {
                    bail!("Defaults cannot be combined with grants")
                };
                if let Some(x) = a.dm {
                    c.dm_reply = x;
                }
                if let Some(x) = a.groups {
                    c.group_reply = x;
                }
            } else {
                let mut ids = a.ids;
                let explicit_chat = a.chat;
                if ids.is_empty() {
                    config::assert_policy_writable()?;
                    if a.inherit {
                        bail!("--inherit requires an existing ID");
                    }
                    need_terminal()?;
                    let choice = ask(
                        "Access: [1] Pair another user (default), [2] Enter numeric IDs, [3] Edit a grant's reply policy: ",
                    )?;
                    match choice.as_str() {
                        "2" => {
                            let a = parse_ids(&ask("User IDs / negative chat IDs: ")?)?;
                            ids.extend(a.user_ids);
                            ids.extend(a.chat_ids);
                        }
                        "3" => {
                            eprintln!(
                                "Users: {} · chats: {}",
                                c.access.user_ids.join(", "),
                                c.access.chat_ids.join(", ")
                            );
                            let id = ask("Grant ID: ")?;
                            if !c.access.user_ids.contains(&id) && !c.access.chat_ids.contains(&id)
                            {
                                bail!("That grant does not exist")
                            };
                            let policy = ask("Reply policy (all / mention / inherit): ")?;
                            changed.push("chatReplies");
                            match policy.as_str() {
                                "all" | "mention" => {
                                    c.chat_replies.insert(id, policy);
                                }
                                "inherit" => {
                                    c.chat_replies.remove(&id);
                                }
                                _ => bail!("Invalid reply policy"),
                            };
                        }
                        _ => {
                            let _lock = tgfx::lock::RuntimeLock::acquire(&c.active_bot_id, &w)?;
                            let t = api(&token(&c)?)?;
                            let b = t.get_me().await?;
                            let (user, _) = pair(&t, &b).await?;
                            ids.push(user);
                        }
                    }
                }
                for raw in ids {
                    let id = canonical_id(&raw, true)?;
                    let list = if id.starts_with('-') || explicit_chat {
                        &mut c.access.chat_ids
                    } else {
                        &mut c.access.user_ids
                    };
                    if !list.contains(&id) {
                        if a.inherit {
                            bail!("{id} is not allowed; --inherit does not grant access");
                        }
                        config::assert_policy_writable()?;
                        list.push(id.clone());
                    }
                    if let Some(policy) = &a.reply {
                        c.chat_replies.insert(id.clone(), policy.clone());
                    }
                    if a.inherit {
                        c.chat_replies.remove(&id);
                    }
                }
            }
            config::save_settings(&w, &c, &changed)?;
            eprintln!("Saved. Restart TGFX to apply access changes.");
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&c.access)?);
            }
        }
        Some(Command::Deny { ids }) => {
            config::assert_policy_writable()?;
            let mut c = required(&w)?;
            if ids.is_empty() {
                bail!("Specify at least one Telegram user or chat ID");
            }
            for id in ids {
                let id = canonical_id(&id, true)?;
                c.access.user_ids.retain(|x| x != &id);
                c.access.chat_ids.retain(|x| x != &id);
                c.chat_replies.remove(&id);
            }
            config::save_settings(&w, &c, &["chatReplies"])?;
            eprintln!("Saved access changes; restart TGFX.");
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&c.access)?);
            }
        }
        Some(Command::Approvals { target: dest }) => {
            let mut c = required(&w)?;
            if let Some(dest) = dest {
                config::assert_policy_writable()?;
                let (chat, topic) = target(&dest)?;
                test_approvals(&api(&token(&c)?)?, &c.active_bot_id, &chat, &topic).await?;
                c.approvals.chat_id = chat;
                c.approvals.topic_id = topic;
                config::save(&w, &c)?;
            }
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&c.approvals)?);
            } else {
                println!(
                    "approvals → {}{}",
                    c.approvals.chat_id,
                    if c.approvals.topic_id == "0" {
                        String::new()
                    } else {
                        format!("/{}", c.approvals.topic_id)
                    }
                );
            }
        }
        Some(Command::History { action, chat }) => {
            let c = required(&w)?;
            let p = config::workspace_paths(&c.active_bot_id, &w)?;
            let _lock = if action.is_some() {
                Some(tgfx::lock::RuntimeLock::acquire(&c.active_bot_id, &w)?)
            } else {
                None
            };
            let s = tgfx::state::State::open(&p.database, &w)?;
            if action.is_some() {
                let chat = chat.context("history clear requires --chat")?;
                config::validate_id(&chat, true)?;
                s.history.clear(&chat, &c.active_bot_id)?;
                println!(
                    "Cleared archived messages for {chat}; Telegram messages and FX sessions retained."
                );
            } else {
                let rows = s.history.stats()?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&rows)?);
                } else {
                    for r in rows {
                        println!(
                            "{} · {} messages · {} bytes · since {}",
                            r["route"], r["messages"], r["bytes"], r["captured_since"]
                        );
                    }
                }
            }
        }
        Some(Command::Doctor) => doctor(&w, cli.json).await?,
        None => {
            let fx_binary = std::env::var("FX_BINARY").unwrap_or_else(|_| "fx".into());
            tgfx::fx::preflight::inspect(&fx_binary, &w).await?;
            let (mut c, token, telegram, bot) = initialized(&w, show_tui).await?;
            if let Some(mode) = cli.output {
                c.output = mode;
            }
            if cli.no_icons {
                c.custom_icons = false;
            }
            let _lock = tgfx::lock::RuntimeLock::acquire(&c.active_bot_id, &w)?;
            let paths = config::workspace_paths(&c.active_bot_id, &w)?;
            let runtime = tgfx::runtime::Runtime::new(tgfx::runtime::RuntimeOptions {
                config: c.clone(),
                workspace: w.clone(),
                paths,
                token,
                bot: bot.clone(),
                telegram,
                fx_binary,
                model: cli.model,
                yolo: cli.yolo,
                json: cli.json,
            })?;
            let cancel = CancellationToken::new();
            let stop = cancel.clone();
            tokio::spawn(async move {
                #[cfg(unix)]
                {
                    if let Ok(mut term) =
                        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    {
                        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
                    } else {
                        let _ = tokio::signal::ctrl_c().await;
                    }
                }
                #[cfg(not(unix))]
                {
                    let _ = tokio::signal::ctrl_c().await;
                }
                stop.cancel();
            });
            if show_tui {
                let events = runtime.subscribe();
                let control = runtime.control();
                let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
                tokio::spawn(async move {
                    while let Some(cmd) = rx.recv().await {
                        use tgfx::{runtime::RuntimeControl as R, tui::UiCommand as U};
                        let mapped = match cmd {
                            U::Paused(x) => R::Pause(x),
                            U::Icons(x) => R::Icons(x),
                            U::Reply { target, policy } => R::Replies {
                                chat_id: (!matches!(target.as_str(), "dm" | "groups"))
                                    .then(|| target.clone()),
                                kind: match target.as_str() {
                                    "dm" => Some("private".into()),
                                    "groups" => Some("group".into()),
                                    _ => None,
                                },
                                policy: policy.unwrap_or("inherit".into()),
                            },
                        };
                        if control.send(mapped).is_err() {
                            break;
                        }
                    }
                });
                let mut view =
                    tgfx::tui::StatusView::new(&c, bot.username.unwrap_or(bot.id), cli.yolo);
                view.no_color |= cli.no_color;
                let ui_cancel = cancel.clone();
                let ui = tokio::task::spawn_blocking(move || {
                    tgfx::tui::run(events, tx, ui_cancel, view)
                });
                let result = runtime.run(cancel.clone()).await;
                cancel.cancel();
                ui.await??;
                result?;
            } else {
                let _ = tracing_subscriber::fmt()
                    .with_writer(io::stderr)
                    .with_ansi(
                        !cli.no_color
                            && std::env::var_os("NO_COLOR").is_none()
                            && io::stderr().is_terminal(),
                    )
                    .with_env_filter(
                        tracing_subscriber::EnvFilter::try_from_default_env()
                            .unwrap_or_else(|_| if cli.debug { "debug" } else { "info" }.into()),
                    )
                    .try_init();
                eprintln!(
                    "TGFX {} · @{} · {}",
                    env!("CARGO_PKG_VERSION"),
                    bot.username.as_deref().unwrap_or(&bot.id),
                    c.output
                );
                runtime.run(cancel).await?;
            }
        }
    }
    Ok(())
}
async fn doctor(w: &Path, structured: bool) -> Result<()> {
    let mut checks = Vec::new();
    let binary = std::env::var("FX_BINARY").unwrap_or_else(|_| "fx".into());
    match tgfx::fx::preflight::inspect(&binary, w).await {
        Ok(r) => checks.push(json!({"check":"fx","ok":true,"detail":r})),
        Err(e) => checks.push(json!({"check":"fx","ok":false,"detail":e.to_string()})),
    }
    match config::load(w) {
        Ok(Some(c)) => {
            checks.push(json!({"check":"config","ok":true,"detail":config::project_path(w)?}));
            match token(&c) {
                Ok(token) => {
                    let result:Result<()> = async {
                        let t=api(&token)?;
                        let b=t.get_me().await?;
                        let webhook=t.call("getWebhookInfo",json!({})).await?;
                        let webhook_active=webhook["url"].as_str().is_some_and(|s|!s.is_empty());
                        checks.push(json!({"check":"Telegram","ok":b.id==c.active_bot_id && !webhook_active,"detail":{"bot":b,"tokenSource":secrets::source(&c.active_bot_id)?,"webhookConfigured":webhook_active}}));
                        match t.call("getChat",json!({"chat_id":c.approvals.chat_id})).await {
                            Ok(v)=>checks.push(json!({"check":"approvals chat","ok":true,"detail":{"chat":v,"topic":c.approvals.topic_id}})),
                            Err(e)=>checks.push(json!({"check":"approvals chat","ok":false,"detail":e.to_string()})),
                        }
                        let me=t.call("getMe",json!({})).await?;
                        for chat in c.access.chat_ids.iter().filter(|id|id.starts_with('-')) {
                            let result:Result<_>=async {Ok(tokio::try_join!(t.call("getChat",json!({"chat_id":chat})),t.call("getChatMember",json!({"chat_id":chat,"user_id":c.active_bot_id})))?)}.await;
                            match result {
                                Ok((info,member))=>{
                                    let admin=matches!(member["status"].as_str(),Some("administrator"|"creator"));
                                    checks.push(json!({"check":format!("group {chat}"),"ok":true,"detail":{"chat":info,"membership":member}}));
                                    checks.push(json!({"check":format!("history {chat}"),"ok":admin||me["can_read_all_group_messages"]==true,"detail":"History contains observed allowed messages; full group delivery requires admin or disabled BotFather Group Privacy."}));
                                }
                                Err(e)=>checks.push(json!({"check":format!("group {chat}"),"ok":false,"detail":e.to_string()})),
                            }
                        }
                        Ok(())
                    }.await;
                    if let Err(e) = result {
                        checks.push(json!({"check":"Telegram","ok":false,"detail":secrets::redact(&e.to_string())}));
                    }
                }
                Err(e) => checks.push(json!({"check":"token","ok":false,"detail":e.to_string()})),
            }
            let p = config::workspace_paths(&c.active_bot_id, w)?;
            match tgfx::state::State::open(&p.database, w) {
                Ok(_) => checks.push(json!({"check":"SQLite","ok":true,"detail":p.database})),
                Err(e) => checks.push(json!({"check":"SQLite","ok":false,"detail":e.to_string()})),
            }
        }
        Ok(None) => checks
            .push(json!({"check":"config","ok":false,"detail":"Workspace is not initialized"})),
        Err(e) => checks.push(json!({"check":"config","ok":false,"detail":e.to_string()})),
    }
    if structured {
        println!("{}", serde_json::to_string_pretty(&checks)?);
    } else {
        for c in &checks {
            println!(
                "{} {} · {}",
                if c["ok"] == true { "✓" } else { "✗" },
                c["check"].as_str().unwrap_or("check"),
                c["detail"]
            );
        }
    }
    if checks.iter().any(|c| c["ok"] != true) {
        bail!("Some diagnostic checks failed")
    };
    Ok(())
}
async fn emit(a: Emit, w: &Path) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    let w = config::absolute(w)?;
    let path = tgfx::event_socket::discover_events_socket(&w)?;
    async fn request(path: &Path, p: &Value) -> Result<Value> {
        let socket = tokio::net::UnixStream::connect(path)
            .await
            .context("Cannot connect to running TGFX")?;
        let (read, mut write) = socket.into_split();
        write.write_all(format!("{p}\n").as_bytes()).await?;
        let mut reader = BufReader::new(read.take(2 * 1024 * 1024));
        let mut line = String::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            reader.read_line(&mut line),
        )
        .await??;
        let r: Value = serde_json::from_str(&line)?;
        if r["ok"] != true {
            bail!("{}", r["error"].as_str().unwrap_or("Event failed"))
        };
        Ok(r["value"].clone())
    }
    let mut job = if let Some(id) = a.status {
        request(&path, &json!({"op":"get","id":id})).await?
    } else {
        let name = a.name.context("Specify one event name or --status ID")?;
        let raw = if let Some(file) = a.payload_file {
            if file == "-" {
                use std::io::Read;
                let mut s = String::new();
                io::stdin().take(300 * 1024 + 1).read_to_string(&mut s)?;
                Some(s)
            } else {
                Some(std::fs::read_to_string(file)?)
            }
        } else {
            a.payload
        };
        let mut e = json!({"name":name,"payload":raw.map(|r|serde_json::from_str::<Value>(&r)).transpose()?.unwrap_or(Value::Null),"steer":a.steer});
        for (k, v) in [
            ("id", a.id),
            ("chatId", a.chat),
            ("topicId", a.topic),
            ("prompt", a.prompt),
        ] {
            if let Some(v) = v {
                e[k] = json!(v);
            }
        }
        if e.to_string().len() > 256 * 1024 {
            bail!("Event exceeds 256 KiB")
        };
        request(&path, &json!({"op":"emit","event":e})).await?
    };
    while a.wait && matches!(job["status"].as_str(), Some("queued" | "running")) {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        job = request(&path, &json!({"op":"get","id":job["id"]})).await?;
    }
    println!("{job}");
    if matches!(
        job["status"].as_str(),
        Some("failed" | "interrupted" | "cancelled")
    ) {
        bail!("Event did not finish successfully")
    };
    Ok(())
}
