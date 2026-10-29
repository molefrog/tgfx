use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::LazyLock,
};
static ICONS: LazyLock<Vec<Value>> =
    LazyLock::new(|| serde_json::from_str(include_str!("icons.json")).unwrap());
pub fn icon(kind: &str, id: &str) -> Option<&'static Value> {
    ICONS.iter().find(|v| {
        v["kind"] == kind
            && v["aliases"]
                .as_array()
                .is_some_and(|a| a.iter().any(|s| s == id))
    })
}
pub fn custom_icon(kind: &str, id: &str, text: &str, enabled: bool) -> Value {
    if enabled && let Some(icon) = icon(kind, id) {
        return json!({"type":"custom_emoji","custom_emoji_id":icon["customEmojiId"],"alternative_text":icon["emoji"]});
    }
    json!(text)
}
pub fn provider_icons(stickers: Option<&[Value]>) -> HashMap<String, String> {
    let mut icons = HashMap::new();
    for icon in ICONS.iter().filter(|v| v["kind"] == "provider") {
        let id = stickers
            .and_then(|s| s.get(icon["position"].as_u64().unwrap_or(0) as usize))
            .and_then(|v| v["custom_emoji_id"].as_str())
            .or(icon["customEmojiId"].as_str())
            .unwrap_or_default();
        for alias in icon["aliases"].as_array().into_iter().flatten() {
            if let Some(alias) = alias.as_str() {
                icons.insert(alias.into(), id.into());
            }
        }
    }
    icons
}
pub fn session_confirmation(action: &str, id: &str) -> Value {
    let clear = action == "clear";
    json!({"blocks":[{"type":"paragraph","text":[if clear{"Start a fresh conversation? This stops the current task and discards queued requests. Files are kept. "}else{"Compact this conversation? FX summarizes context after queued tasks finish. "},{"type":"button","button":{"text":if clear{"Clear conversation"}else{"Compact conversation"},"style":if clear{"danger"}else{"primary"},"callback_data":format!("session:{id}:confirm")}}," ",{"type":"button","button":{"text":"Cancel","style":"link","callback_data":format!("session:{id}:cancel")}}]}]})
}
fn provider(value: &str) -> String {
    if let Some((p, _)) = value.split_once('/') {
        return p.into();
    }
    let lower = value.to_lowercase();
    for (prefix, p) in [
        ("grok-", "spacexai"),
        ("gpt-", "codex"),
        ("chatgpt-", "codex"),
        ("o1", "codex"),
        ("o3", "codex"),
        ("o4", "codex"),
        ("claude-", "anthropic"),
        ("deepseek-", "deepseek"),
        ("gemini-", "google"),
        ("gemma-", "google"),
        ("kimi-", "moonshotai"),
        ("nemotron-", "nvidia"),
        ("qwen", "alibaba"),
        ("glm-", "zai"),
        ("minimax-", "minimax"),
    ] {
        if lower.starts_with(prefix) {
            return p.into();
        }
    }
    "other".into()
}
fn model_label(v: &Value) -> String {
    let value = v["value"].as_str().unwrap_or("");
    let label = v["name"].as_str().unwrap_or(value);
    if label == value {
        value.split_once('/').map_or(value, |(_, rest)| rest).into()
    } else {
        label.into()
    }
}
fn html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
/// ACP flat select options, grouped by provider. Callbacks retain original indexes.
pub fn model_picker_with_icons(
    options: &[Value],
    current: &str,
    id: &str,
    provider_index: Option<usize>,
    requested_page: usize,
    icons: &HashMap<String, String>,
) -> Option<Value> {
    let mut order = vec![];
    let mut groups = BTreeMap::<String, Vec<(usize, &Value)>>::new();
    for (i, option) in options.iter().enumerate() {
        let p = provider(option["value"].as_str().unwrap_or(""));
        if !groups.contains_key(&p) {
            order.push(p.clone())
        }
        groups.entry(p).or_default().push((i, option));
    }
    let current_label = options
        .iter()
        .find(|v| v["value"] == current)
        .map(model_label)
        .unwrap_or_else(|| current.into());
    let mut rows = vec![];
    let navigation = |page: usize, pages: usize, action: &dyn Fn(usize) -> String| {
        let mut row = vec![];
        if page > 0 {
            row.push(json!({"text":"‹ Previous","callback_data":format!("model:{id}:{}",action(page-1))}))
        }
        row.push(
            json!({"text":format!("{} / {pages}",page+1),"callback_data":format!("model:{id}:n")}),
        );
        if page + 1 < pages {
            row.push(
                json!({"text":"Next ›","callback_data":format!("model:{id}:{}",action(page+1))}),
            )
        }
        json!(row)
    };
    if let Some(index) = provider_index {
        let p = order.get(index)?;
        let group = &groups[p];
        let pages = group.len().div_ceil(6).max(1);
        let page = requested_page.min(pages - 1);
        for (original, option) in group.iter().skip(page * 6).take(6) {
            let mut button = json!({"text":format!("{}{}",if option["value"]==current{"Current · "}else{""},model_label(option)),"callback_data":format!("model:{id}:s.{original}")});
            let provider = if format!("{} {}", option["value"], option["name"])
                .to_lowercase()
                .contains("codex")
            {
                "codex"
            } else {
                p
            };
            if let Some(icon) = icons.get(provider) {
                button["icon_custom_emoji_id"] = json!(icon)
            }
            rows.push(json!([button]));
        }
        if pages > 1 {
            rows.push(navigation(page, pages, &|n| format!("v.{index}.{n}")))
        }
        rows.push(json!([{"text":"‹ Providers","callback_data":format!("model:{id}:p.0")},{"text":"Close","callback_data":format!("model:{id}:x")}]))
    } else {
        let pages = order.len().div_ceil(6).max(1);
        let page = requested_page.min(pages - 1);
        let mut buttons = vec![];
        for (index, p) in order.iter().enumerate().skip(page * 6).take(6) {
            let definition = icon("provider", p);
            let label = definition.and_then(|v| v["label"].as_str()).unwrap_or(p);
            let mut b = json!({"text":format!("{label} · {}",groups[p].len()),"callback_data":format!("model:{id}:v.{index}.0")});
            if let Some(icon) = icons.get(p) {
                b["icon_custom_emoji_id"] = json!(icon)
            }
            buttons.push(b)
        }
        for row in buttons.chunks(2) {
            rows.push(json!(row))
        }
        if pages > 1 {
            rows.push(navigation(page, pages, &|n| format!("p.{n}")))
        }
        rows.push(json!([{"text":"Close","callback_data":format!("model:{id}:x")}]))
    }
    Some(
        json!({"text":format!("Choose model: <b>{}</b>",html(&current_label)),"parse_mode":"HTML","reply_markup":{"inline_keyboard":rows}}),
    )
}

pub fn model_picker(
    options: &[Value],
    current: &str,
    id: &str,
    provider_index: Option<usize>,
    requested_page: usize,
    icons: bool,
) -> Option<Value> {
    model_picker_with_icons(
        options,
        current,
        id,
        provider_index,
        requested_page,
        &if icons {
            provider_icons(None)
        } else {
            HashMap::new()
        },
    )
}
pub fn icon_set() -> Value {
    json!({"name":"ai_provider_labs_by_fxharness_bot","title":"tgfx icons","url":"https://t.me/addemoji/ai_provider_labs_by_fxharness_bot","ownerBot":"fxharness_bot"})
}
pub fn custom_icons(kind: Option<&str>) -> Vec<Value> {
    ICONS
        .iter()
        .filter(|v| kind.is_none_or(|k| v["kind"] == k))
        .cloned()
        .collect()
}
pub fn selected_model(model: &Value) -> Value {
    json!({"text":format!("Model changed to\n\n<b>{}</b>",html(model["name"].as_str().or(model["value"].as_str()).unwrap_or(""))),"reply_markup":{"inline_keyboard":[]}})
}
pub fn reply_style_picker(current: crate::types::OutputMode) -> Value {
    let modes = [
        ("final", "Final", "Send the answer when the turn finishes"),
        (
            "live",
            "Live",
            "Show live status, then stream the final answer",
        ),
        (
            "detailed",
            "Detailed",
            "Stream the answer and tool activity as they happen",
        ),
    ];
    let lines = modes
        .iter()
        .map(|(mode, name, hint)| {
            if *mode == current.as_str() {
                format!("✓ <b>{name}</b> — {hint}")
            } else {
                format!("· {name} — {hint}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    json!({"text":format!("<b>Reply style</b>\n\n{lines}"),"reply_markup":super::format_menu(current)})
}
fn compact(number: u64) -> String {
    let (value, suffix) = if number >= 1_000_000_000 {
        (number as f64 / 1e9, "B")
    } else if number >= 1_000_000 {
        (number as f64 / 1e6, "M")
    } else if number >= 1000 {
        (number as f64 / 1e3, "K")
    } else {
        return number.to_string();
    };
    format!(
        "{}{suffix}",
        format!("{value:.2}")
            .trim_end_matches('0')
            .trim_end_matches('.')
    )
}
fn model_name(model: &str) -> String {
    model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .split('-')
        .map(|part| match part.to_lowercase().as_str() {
            "claude" => "Claude".into(),
            "deepseek" => "DeepSeek".into(),
            "fast" => "Fast".into(),
            "gemini" => "Gemini".into(),
            "glm" => "GLM".into(),
            "gpt" => "GPT".into(),
            "kimi" => "Kimi".into(),
            "pro" => "Pro".into(),
            _ => {
                if part.len() > 1
                    && part.as_bytes()[0].is_ascii_alphabetic()
                    && part.as_bytes()[1..].iter().all(u8::is_ascii_digit)
                {
                    part.to_uppercase()
                } else {
                    let mut chars = part.chars();
                    chars
                        .next()
                        .map(|first| format!("{}{}", first.to_uppercase(), chars.as_str()))
                        .unwrap_or_default()
                }
            }
        })
        .collect::<Vec<String>>()
        .join(" ")
}
pub fn cost_report(report: &Value) -> Value {
    let totals = &report["totals"];
    let period = report["period"].as_str().unwrap_or("24h");
    let label = match period {
        "7d" => "7 days",
        "30d" => "30 days",
        _ => "24 hours",
    };
    let mut text = format!(
        "**Usage**\n\n_Last {label}_\n\n**\\${:.2} spent** across **{} requests**\n\n**{} tokens** processed\n\n**Token breakdown**\n\n- Input: **{}**\n- Output: **{}**\n- Cache read: **{}**\n- Reasoning: **{}**",
        totals["spend"].as_f64().unwrap_or(0.),
        totals["request_count"].as_u64().unwrap_or(0),
        compact(totals["total_tokens"].as_u64().unwrap_or(0)),
        compact(totals["input_tokens"].as_u64().unwrap_or(0)),
        compact(totals["output_tokens"].as_u64().unwrap_or(0)),
        compact(totals["cache_read_tokens"].as_u64().unwrap_or(0)),
        compact(totals["reasoning_tokens"].as_u64().unwrap_or(0))
    );
    if let Some(models) = report["models"].as_array().filter(|a| !a.is_empty()) {
        text.push_str("\n\n| Model | Cost | Tokens |\n| :--- | ---: | ---: |\n");
        for m in models {
            text.push_str(&format!(
                "| {} | \\${:.2} | {} |\n",
                model_name(m["model"].as_str().unwrap_or(""))
                    .replace('\\', "\\\\")
                    .replace('|', "\\|")
                    .replace('\n', " "),
                m["totals"]["spend"].as_f64().unwrap_or(0.),
                compact(m["totals"]["total_tokens"].as_u64().unwrap_or(0))
            ));
        }
    }
    json!({"rich_message":serde_json::to_value(crate::markdown::render(&text).unwrap()).unwrap(),"reply_markup":{"inline_keyboard":[([( "24h","24 hours"),("7d","7 days"),("30d","30 days")].map(|(p,l)|json!({"text":l,"callback_data":if p==period{"cost:n".into()}else{format!("cost:{p}")}})))]}})
}
