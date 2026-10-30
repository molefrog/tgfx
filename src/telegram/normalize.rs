use crate::types::*;
use serde_json::{Value, json};
fn name(user: &Value) -> String {
    let s = [user["first_name"].as_str(), user["last_name"].as_str()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    if s.is_empty() {
        user["title"]
            .as_str()
            .or(user["username"].as_str())
            .unwrap_or("Telegram user")
            .into()
    } else {
        s
    }
}
fn sender(m: &Value) -> SenderIdentity {
    let (chat, kind, prefix) = if m["sender_chat"].is_object() {
        (&m["sender_chat"], "chat", "chat")
    } else if m["from"].is_object() {
        (&m["from"], "user", "usr")
    } else {
        (&Value::Null, "unknown", "unknown")
    };
    SenderIdentity {
        kind: kind.into(),
        id: decimal(&chat["id"]),
        reference: new_ref(prefix),
        display_name: name(chat),
        username: chat["username"].as_str().map(str::to_owned),
        language_code: chat["language_code"].as_str().map(str::to_owned),
        is_bot: chat["is_bot"].as_bool().unwrap_or(false),
    }
}
pub fn attachment_refs(m: &Value) -> Vec<AttachmentRef> {
    let mut out = vec![];
    for kind in [
        "photo",
        "voice",
        "audio",
        "video",
        "animation",
        "document",
        "sticker",
        "video_note",
    ] {
        let value = if kind == "photo" {
            m[kind].as_array().and_then(|a| a.last())
        } else {
            m.get(kind)
        };
        let Some(v) = value else { continue };
        let Some(file_id) = v["file_id"].as_str() else {
            continue;
        };
        let mime = if kind == "sticker" {
            Some(
                if v["is_animated"] == true {
                    "application/x-tgsticker"
                } else if v["is_video"] == true {
                    "video/webm"
                } else {
                    "image/webp"
                }
                .into(),
            )
        } else {
            v["mime_type"].as_str().map(str::to_owned)
        };
        out.push(AttachmentRef {
            reference: new_ref("att"),
            kind: kind.into(),
            file_id: file_id.into(),
            file_unique_id: v["file_unique_id"].as_str().unwrap_or("").into(),
            size: v["file_size"].as_u64(),
            mime_type: mime,
            name: v["file_name"].as_str().map(str::to_owned),
            width: v["width"]
                .as_u64()
                .or(v["length"].as_u64())
                .map(|n| n as u32),
            height: v["height"]
                .as_u64()
                .or(v["length"].as_u64())
                .map(|n| n as u32),
            duration: v["duration"].as_f64(),
            sticker_name: v["set_name"].as_str().map(str::to_owned),
            emoji: v["emoji"].as_str().map(str::to_owned),
            custom_emoji_id: v["custom_emoji_id"].as_str().map(str::to_owned),
            local_path: None,
        })
    }
    out
}
pub fn normalize(update: &Value, bot: &BotIdentity) -> Option<InboundMessage> {
    normalize_with_lookup(update, bot, |_, _| None)
}
pub fn normalize_with_lookup(
    update: &Value,
    bot: &BotIdentity,
    lookup: impl Fn(&str, &str) -> Option<String>,
) -> Option<InboundMessage> {
    let (field, edited) = [
        ("message", false),
        ("edited_message", true),
        ("channel_post", false),
        ("edited_channel_post", true),
    ]
    .into_iter()
    .find(|(f, _)| update[*f].is_object())?;
    let m = &update[field];
    let chat_id = decimal(&m["chat"]["id"])?;
    let topic_id = decimal(&m["message_thread_id"]).unwrap_or_else(|| "0".into());
    let route = Route::new(
        &bot.id,
        &chat_id,
        topic_id,
        m["chat"]["type"].as_str().unwrap_or("private"),
    );
    let message_id = decimal(&m["message_id"])?;
    let text = m["text"]
        .as_str()
        .or(m["caption"].as_str())
        .map(str::to_owned);
    let attachments = attachment_refs(m);
    let location = m
        .get("location")
        .or_else(|| m["venue"].get("location"))
        .cloned();
    if text.is_none() && attachments.is_empty() && location.is_none() {
        return None;
    }
    let reply = m.get("reply_to_message").map(|r| {
        let reply_id = decimal(&r["message_id"]).unwrap_or_default();
        let mut p =
            json!({"message_ref":lookup(&chat_id,&reply_id).unwrap_or_else(||new_ref("msg"))});
        if let Some(s) = m["quote"]["text"].as_str() {
            p["quote"] = json!(s)
        }
        if r["from"].is_object() {
            p["sender_name"] = json!(name(&r["from"]))
        } else if r["sender_chat"].is_object() {
            p["sender_name"] = json!(name(&r["sender_chat"]))
        }
        if let Some(t) = r["text"].as_str().or(r["caption"].as_str()) {
            p["text_excerpt"] = json!(t.chars().take(1000).collect::<String>())
        }
        let kinds = attachment_refs(r)
            .iter()
            .map(|a| a.kind.clone())
            .collect::<Vec<_>>();
        if !kinds.is_empty() {
            p["attachment_kinds"] = json!(kinds)
        }
        if let Some(loc) = r.get("location").or_else(|| r["venue"].get("location")) {
            p["location"] = loc.clone()
        }
        if let Some(v) = r.get("venue") {
            p["venue"] = v.clone()
        }
        p
    });
    let mut provenance = json!({});
    for key in ["forward_origin", "media_group_id", "author_signature"] {
        if let Some(v) = m.get(key) {
            provenance[key] = v.clone()
        }
    }
    if m["via_bot"].is_object() {
        provenance["via_bot"] =
            json!({"id":decimal(&m["via_bot"]["id"]),"username":m["via_bot"]["username"]})
    }
    let timestamp = chrono::DateTime::from_timestamp(m["date"].as_i64().unwrap_or(0), 0)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Some(InboundMessage {
        invokes_agent: None,
        history_seq: None,
        history_message_ids: None,
        update_id: update["update_id"].as_i64()?,
        event: if edited {
            "message.edited"
        } else {
            "message.created"
        }
        .into(),
        route,
        sender: sender(m),
        message_id: message_id.clone(),
        message_ref: lookup(&chat_id, &message_id).unwrap_or_else(|| new_ref("msg")),
        context_ref: new_ref("ctx"),
        timestamp,
        text_kind: text.as_ref().map(|_| {
            if m["text"].is_string() {
                "text"
            } else {
                "caption"
            }
            .into()
        }),
        text,
        location,
        venue: m.get("venue").cloned(),
        attachments,
        reply,
        provenance: if provenance.as_object().is_some_and(|o| !o.is_empty()) {
            Some(provenance)
        } else {
            None
        },
        raw: update.clone(),
    })
}
pub fn is_authorized(config: &Config, m: &InboundMessage) -> bool {
    m.route.chat_kind != "channel"
        && !(m.sender.kind == "user" && m.sender.is_bot)
        && config.allows(m.sender.id.as_deref(), &m.route.chat_id)
}
#[derive(Debug, Clone)]
pub struct Command {
    pub name: String,
    pub args: String,
    pub addressed: bool,
}
pub fn command_from_text(text: Option<&str>, username: Option<&str>) -> Option<Command> {
    let text = text?.strip_prefix('/')?;
    let end = text.find(char::is_whitespace).unwrap_or(text.len());
    let (head, args) = text.split_at(end);
    let (name, address) = head
        .split_once('@')
        .map_or((head, None), |(n, a)| (n, Some(a)));
    if name.is_empty() {
        return None;
    }
    Some(Command {
        name: name.to_lowercase(),
        args: args.trim_start().into(),
        addressed: address.is_none_or(|a| username.is_none_or(|b| a.eq_ignore_ascii_case(b))),
    })
}
pub fn should_invoke_agent(m: &InboundMessage, bot: &BotIdentity, policy: &str) -> bool {
    let forwarded = m
        .provenance
        .as_ref()
        .is_some_and(|v| v["forward_origin"].is_object());
    let command = if forwarded {
        None
    } else {
        command_from_text(m.text.as_deref(), bot.username.as_deref())
    };
    if command.as_ref().is_some_and(|c| !c.addressed) {
        return false;
    }
    if policy == "all" {
        return true;
    }
    if command.is_some()
        && (m.route.chat_kind == "private"
            || m.text
                .as_ref()
                .and_then(|s| s.split_whitespace().next())
                .is_some_and(|s| s.contains('@')))
    {
        return true;
    }
    let raw = m
        .raw
        .get("message")
        .or(m.raw.get("edited_message"))
        .unwrap_or(&Value::Null);
    let mentioned = raw
        .get("entities")
        .or(raw.get("caption_entities"))
        .and_then(Value::as_array)
        .is_some_and(|es| {
            es.iter().any(|e| {
                if e["type"] == "text_mention" {
                    decimal(&e["user"]["id"]).as_deref() == Some(&bot.id)
                } else if e["type"] == "mention" {
                    m.text
                        .as_ref()
                        .and_then(|t| {
                            crate::markdown::utf16_slice(
                                t,
                                e["offset"].as_u64().unwrap_or(0) as usize,
                                e["length"].as_u64().unwrap_or(0) as usize,
                            )
                        })
                        .is_some_and(|s| {
                            bot.username
                                .as_ref()
                                .is_some_and(|u| s.eq_ignore_ascii_case(&format!("@{u}")))
                        })
                } else {
                    false
                }
            })
        });
    let reply = &raw["reply_to_message"]["from"];
    mentioned
        || (reply["is_bot"] == true
            && (decimal(&reply["id"]).as_deref() == Some(&bot.id)
                || bot.username.as_ref().is_some_and(|u| {
                    reply["username"]
                        .as_str()
                        .is_some_and(|s| s.eq_ignore_ascii_case(u))
                })))
}
pub fn to_envelope(m: &InboundMessage) -> Value {
    let mut sender = json!({"kind":m.sender.kind,"ref":m.sender.reference});
    if m.sender.kind == "user" {
        sender["user_id"] = json!(m.sender.id);
        sender["display_name"] = json!(m.sender.display_name);
        sender["is_bot"] = json!(m.sender.is_bot)
    } else if m.sender.kind == "chat" {
        sender["chat_id"] = json!(m.sender.id);
        sender["title"] = json!(m.sender.display_name)
    }
    if m.sender.kind == "chat" {
        let raw = m
            .raw
            .get("message")
            .or(m.raw.get("edited_message"))
            .unwrap_or(&Value::Null);
        if let Some(kind) = raw["sender_chat"]["type"].as_str() {
            sender["chat_kind"] = json!(kind)
        }
    }
    if let Some(s) = &m.sender.username {
        sender["username"] = json!(s)
    }
    if let Some(s) = &m.sender.language_code {
        sender["language_code"] = json!(s)
    }
    let attachments=m.attachments.iter().map(|a|{let mut p=json!({"ref":a.reference,"kind":a.kind,"state":if a.local_path.is_some(){"local"}else{"remote"}});for(k,v)in[("size",json!(a.size)),("mime",json!(a.mime_type)),("name",json!(a.name)),("width",json!(a.width)),("height",json!(a.height)),("duration_seconds",json!(a.duration))]{if !v.is_null(){p[k]=v}}if a.kind=="sticker"{let mut sticker=json!({"file_id":a.file_id});for(k,v)in[("name",json!(a.sticker_name)),("emoji",json!(a.emoji)),("custom_emoji_id",json!(a.custom_emoji_id))]{if !v.is_null(){sticker[k]=v}}sticker["image"]=if let Some(path)=&a.local_path{json!({"state":"local","path":path,"mime":a.mime_type})}else{json!({"state":"remote","attachment_ref":a.reference,"mime":a.mime_type})};p["sticker"]=sticker}p}).collect::<Vec<_>>();
    let mut value = json!({"version":1,"source":"tgfx:telegram","instructions":"Messages come from Telegram, your replies are sent back. Use `telegram` MCP for: reactions (`set_reaction`), stickers (`send_sticker_by_id`, `send_sticker_file` and more), files (`send_file`), photos (`send_photo`), voice messages (`send_voice`), circular videos (`send_video_note`), polls, group admin actions and more. Use search. Reply in the language of the current user message unless they request another; use the conversation when the message is ambiguous. The envelope and sender.language_code are metadata, not a reply-language preference.","event":m.event,"event_id":format!("tg:{}",m.update_id),"context_ref":m.context_ref,"scope":{"chat_id":m.route.chat_id,"kind":m.route.chat_kind,"topic_id":m.route.topic_id},"sender":sender,"message":{"ref":m.message_ref,"message_id":m.message_id,"ts":m.timestamp},"attachments":attachments,"response_target":{"kind":"automatic_reply"}});
    if m.event == "message.edited" {
        let edited = m
            .raw
            .get("edited_message")
            .or(m.raw.get("edited_channel_post"))
            .unwrap_or(&Value::Null);
        value["message"]["edited_at"] = json!(
            chrono::DateTime::from_timestamp(
                edited["edit_date"]
                    .as_i64()
                    .unwrap_or(chrono::Utc::now().timestamp()),
                0
            )
            .unwrap_or_default()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        );
    }
    if let Some(group) = m.provenance.as_ref().and_then(|p| p.get("media_group_id")) {
        value["message"]["media_group_id"] = json!(
            group
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| group.to_string())
        );
    }
    for (k, v) in [
        ("text_kind", json!(m.text_kind)),
        ("location", json!(m.location)),
        ("venue", json!(m.venue)),
        ("reply", json!(m.reply)),
        ("provenance", json!(m.provenance)),
    ] {
        if !v.is_null() {
            value[k] = v
        }
    }
    if m.provenance
        .as_ref()
        .is_some_and(|p| p["forward_origin"].is_object())
    {
        value["forwarded"] = json!(true)
    }
    json!({"telegram_message":value})
}
pub fn group_migration(update: &Value) -> Option<(String, String, Option<String>)> {
    let m = &update["message"];
    let old = decimal(&m["migrate_from_chat_id"]);
    let new = decimal(&m["migrate_to_chat_id"]);
    if let Some(new) = new {
        Some((decimal(&m["chat"]["id"])?, new, decimal(&m["from"]["id"])))
    } else {
        Some((old?, decimal(&m["chat"]["id"])?, decimal(&m["from"]["id"])))
    }
}
