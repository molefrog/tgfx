//! Presentation cases use the same public APIs as the runtime.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
pub fn render(a: &Value) -> Result<Value> {
    let result = match a["op"].as_str().context("Missing op")? {
        "markdown" => {
            serde_json::to_value(tgfx::markdown::render(a["source"].as_str().unwrap_or(""))?)?
        }
        "projector" => {
            let mut p = tgfx::fx::projector::Projector::new();
            if let Some(icons) = a.get("icons") {
                p.set_icons(serde_json::from_value(icons.clone())?);
            }
            p.set_now(a["started"].as_u64().unwrap_or(0));
            let mut change = "none";
            for event in a["events"].as_array().into_iter().flatten() {
                p.set_now(event["at"].as_u64().unwrap_or(0));
                if event.get("waiting").is_some() {
                    change = p.set_waiting(event["waiting"].as_str().map(str::to_owned));
                } else {
                    change = p.apply(&event["value"]);
                }
            }
            p.set_now(a["now"].as_u64().unwrap_or(0));
            let mode = a["output"].as_str().unwrap_or("live").parse()?;
            json!({"rich":p.rich(mode,a["final"].as_bool().unwrap_or(false)),"plain":p.plain_final(mode),"change":change,"snapshot":p.snapshot()})
        }
        "tools" => match a["action"].as_str().unwrap_or("describe") {
            "registry" => {
                json!({"names":tgfx::fx::tools::FX_TOOL_NAMES,"activities":tgfx::fx::tools::ACTIVITY_ORDER})
            }
            "summary" => json!(tgfx::fx::tools::activity_summary(
                a["activity"].as_str().unwrap_or(""),
                a["count"].as_u64().unwrap_or(1) as usize
            )),
            _ => serde_json::to_value(tgfx::fx::tools::describe_tool(
                a["name"].as_str().unwrap_or(""),
                a["title"].as_str().unwrap_or(""),
                a["kind"].as_str().unwrap_or(""),
                a.get("input").unwrap_or(&json!({})),
            ))?,
        },
        "normalize" => {
            let bot = serde_json::from_value(a["bot"].clone())?;
            serde_json::to_value(tgfx::telegram::normalize_with_lookup(
                &a["update"],
                &bot,
                |chat, id| {
                    a["lookup"][format!("{chat}:{id}")]
                        .as_str()
                        .map(str::to_owned)
                },
            ))?
        }
        "envelope" => tgfx::telegram::to_envelope(
            &serde_json::from_value(a["message"].clone())?,
            a["bootstrap"].as_bool().unwrap_or(false),
        ),
        "bootstrap" => json!(tgfx::telegram::SESSION_BOOTSTRAP_INSTRUCTIONS),
        "authorized" => json!(tgfx::telegram::is_authorized(
            &serde_json::from_value(a["config"].clone())?,
            &serde_json::from_value(a["message"].clone())?
        )),
        "invoke" => {
            let m: tgfx::types::InboundMessage = serde_json::from_value(a["message"].clone())?;
            let bot = tgfx::types::BotIdentity {
                id: a["botId"].as_str().unwrap_or("").into(),
                username: a["username"].as_str().map(str::to_owned),
                display_name: String::new(),
            };
            json!(tgfx::telegram::should_invoke_agent(
                &m,
                &bot,
                a["policy"]
                    .as_str()
                    .unwrap_or(if m.route.chat_kind == "private" {
                        "all"
                    } else {
                        "mention"
                    })
            ))
        }
        "command" => tgfx::telegram::command_from_text(a["text"].as_str(), a["username"].as_str())
            .map(|c| json!({"name":c.name,"args":c.args,"addressed":c.addressed}))
            .unwrap_or(Value::Null),
        "migration" => tgfx::telegram::group_migration(&a["update"])
            .map(|(old, new, sender)| json!({"oldChatId":old,"newChatId":new,"senderId":sender}))
            .unwrap_or(Value::Null),
        "icons" => {
            json!({"icons":tgfx::telegram::custom_icons(a["kind"].as_str()),"set":tgfx::telegram::icon_set()})
        }
        "provider_icons" => json!(tgfx::telegram::provider_icons(
            a["stickers"].as_array().map(Vec::as_slice)
        )),
        "reply_style" => {
            tgfx::telegram::reply_style_picker(a["current"].as_str().unwrap_or("live").parse()?)
        }
        "session_confirmation" => tgfx::telegram::session_confirmation(
            a["action"].as_str().unwrap_or("clear"),
            a["id"].as_str().unwrap_or("id"),
        ),
        "cost_report" => tgfx::telegram::cost_report(&a["report"]),
        "parse_usage" => tgfx::fx::usage::parse_usage(a["source"].as_str().unwrap_or(""))?,
        "selected_model" => tgfx::telegram::selected_model(&a["model"]),
        "model_picker_icons" => serde_json::to_value(tgfx::telegram::model_picker_with_icons(
            a["options"].as_array().map(Vec::as_slice).unwrap_or(&[]),
            a["current"].as_str().unwrap_or(""),
            a["id"].as_str().unwrap_or("id"),
            a["provider"].as_u64().map(|n| n as usize),
            a["page"].as_u64().unwrap_or(0) as usize,
            &serde_json::from_value(a.get("icons").cloned().unwrap_or(json!({})))?,
        ))?,
        "model_picker" => serde_json::to_value(tgfx::telegram::model_picker(
            a["options"].as_array().map(Vec::as_slice).unwrap_or(&[]),
            a["current"].as_str().unwrap_or(""),
            a["id"].as_str().unwrap_or("id"),
            a["provider"].as_u64().map(|i| i as usize),
            a["page"].as_u64().unwrap_or(0) as usize,
            true,
        ))?,
        other => bail!("Unknown presentation case {other}"),
    };
    Ok(result)
}
