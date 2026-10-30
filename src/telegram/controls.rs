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
        json!({"text":format!("Choose a model for the bot. Current model: <b>{}</b>",html(&current_label)),"parse_mode":"HTML","reply_markup":{"inline_keyboard":rows}}),
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

fn config_value(option: &Value) -> String {
    option["currentValue"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| option["currentValue"].to_string())
}

fn select_options(option: &Value) -> Vec<Value> {
    fn flatten(options: &Value, out: &mut Vec<Value>) {
        for option in options.as_array().into_iter().flatten() {
            if option["value"].is_string() {
                out.push(option.clone());
            } else {
                flatten(&option["options"], out);
            }
        }
    }
    let mut out = vec![];
    flatten(&option["options"], &mut out);
    out
}

fn supports_toggle(option: &Value) -> bool {
    option["type"] == "boolean"
        || ["false", "true"]
            .iter()
            .all(|value| select_options(option).iter().any(|o| o["value"] == *value))
}

/// Each choice carries the exact ACP writes, including disabling both speed lanes.
pub fn model_setting_choices(config: &[Value], panel: &str) -> Vec<Value> {
    if panel == "e" {
        return config
            .iter()
            .find(|o| o["id"] == "effort")
            .map(select_options)
            .unwrap_or_default()
            .into_iter()
            .map(|o| {
                let value = o["value"].as_str().unwrap_or_default();
                let name = match value {
                    "auto" => "Auto",
                    "xhigh" => "Extra High",
                    "high" => "High",
                    "medium" => "Medium",
                    "low" => "Low",
                    "minimal" => "Minimal",
                    "none" => "None",
                    "max" => "Max",
                    _ => o["name"].as_str().unwrap_or(value),
                };
                json!({"name":name,"value":value,"changes":[["effort",value]]})
            })
            .collect();
    }
    if panel != "f" {
        return vec![];
    }
    let toggles = config
        .iter()
        .filter(|o| (o["id"] == "fast" || o["id"] == "ultrafast") && supports_toggle(o))
        .collect::<Vec<_>>();
    if toggles.is_empty() {
        return vec![];
    }
    let mut choices = vec![
        json!({"name":"Regular Speed","value":"regular","changes":toggles.iter().map(|o|json!([o["id"],"false"])).collect::<Vec<_>>()}),
    ];
    for (id, name) in [("fast", "⚡ Fast"), ("ultrafast", "⚡⚡ Ultrafast")] {
        if toggles.iter().any(|o| o["id"] == id) {
            choices.push(json!({"name":name,"value":id,"changes":[[id,"true"]]}));
        }
    }
    choices
}

fn current_setting(config: &[Value], panel: &str) -> String {
    if panel == "e" {
        return config
            .iter()
            .find(|o| o["id"] == "effort")
            .map(config_value)
            .unwrap_or_default();
    }
    for id in ["ultrafast", "fast"] {
        if config
            .iter()
            .any(|o| o["id"] == id && config_value(o) == "true")
        {
            return id.into();
        }
    }
    "regular".into()
}

pub fn model_settings_summary(config: &[Value]) -> Option<String> {
    let mut labels = vec![];
    for panel in ["e", "f"] {
        let current = current_setting(config, panel);
        let choices = model_setting_choices(config, panel);
        if let Some(name) = choices
            .iter()
            .find(|choice| choice["value"] == current)
            .and_then(|choice| choice["name"].as_str())
        {
            labels.push(if panel == "e" {
                format!("{name} Effort")
            } else {
                name.into()
            });
        }
    }
    (!labels.is_empty()).then(|| labels.join(" · "))
}

/// One summary button opens the supported effort and speed choices together.
pub fn model_menu(
    config: &[Value],
    id: &str,
    provider: Option<usize>,
    page: usize,
    panel: Option<&str>,
    icons: bool,
) -> Option<Value> {
    let model = config.iter().find(|o| o["id"] == "model")?;
    let options = select_options(model);
    let mut view = model_picker(&options, &config_value(model), id, provider, page, icons)?;
    let speed = current_setting(config, "f");
    let badge = match speed.as_str() {
        "fast" => " ⚡",
        "ultrafast" => " ⚡⚡",
        _ => "",
    };
    if !badge.is_empty()
        && model_setting_choices(config, "f")
            .iter()
            .any(|choice| choice["value"] == speed)
    {
        view["text"] = json!(format!(
            "{}{badge}",
            view["text"].as_str().unwrap_or_default()
        ));
    }
    let summary = model_settings_summary(config);
    if panel.is_some() && summary.is_some() {
        let mut rows = vec![];
        for panel in ["e", "f"] {
            let current = current_setting(config, panel);
            let buttons = model_setting_choices(config, panel)
                .iter()
                .enumerate()
                .map(|(index, choice)| {
                    json!({"text":format!("{}{}",if choice["value"]==current{"✓ "}else{""},choice["name"].as_str().unwrap_or_default()),"callback_data":format!("model:{id}:a.{panel}.{index}")})
                })
                .collect::<Vec<_>>();
            rows.extend(
                buttons
                    .chunks(if panel == "f" { 3 } else { 2 })
                    .map(|row| json!(row)),
            );
        }
        rows.push(json!([{"text":"‹ Models","callback_data":format!("model:{id}:b")},{"text":"Close","callback_data":format!("model:{id}:x")}]));
        let title = match (
            model_setting_choices(config, "e").is_empty(),
            model_setting_choices(config, "f").is_empty(),
        ) {
            (false, false) => "Effort and speed",
            (false, true) => "Reasoning effort",
            _ => "Response speed",
        };
        view["text"] = json!(format!(
            "<b>{title}</b>\n\n{}",
            html(summary.as_deref().unwrap())
        ));
        view["reply_markup"]["inline_keyboard"] = json!(rows);
    } else if let Some(summary) = summary {
        let rows = view["reply_markup"]["inline_keyboard"].as_array_mut()?;
        rows.insert(rows.len().saturating_sub(1), json!([{"text":format!("{summary} ›"),"callback_data":format!("model:{id}:c.settings")} ]));
    }
    Some(view)
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
    json!({"text":format!("Changed model to <b>{}</b>",html(model["name"].as_str().or(model["value"].as_str()).unwrap_or(""))),"reply_markup":{"inline_keyboard":[]}})
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
        format!(
            "{value:.precision$}",
            precision = if suffix == "K" { 1 } else { 2 }
        )
        .trim_end_matches('0')
        .trim_end_matches('.')
    )
}
/// A fixed-width, fractional Unicode bar keeps small context percentages visible.
fn context_bar(usage: crate::fx::usage::ContextUsage) -> String {
    const FRACTIONS: [char; 8] = ['░', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
    let size = u128::from(usage.size);
    let units = ((u128::from(usage.used.min(usage.size)) * 160 + size / 2) / size) as usize;
    (0..20)
        .map(|cell| {
            let filled = units.saturating_sub(cell * 8);
            if filled >= 8 {
                '█'
            } else {
                FRACTIONS[filled]
            }
        })
        .collect()
}

pub fn usage_report(
    model: &str,
    context: Option<crate::fx::usage::ContextUsage>,
    spend: Option<f64>,
) -> Value {
    let model = model.rsplit('/').next().unwrap_or(model);
    let mut text = format!("<b>{}</b>\n\n", html(model));
    if let Some(context) = context.filter(|context| context.size > 0) {
        text.push_str(&format!(
            "Context  <code>{}</code>  {:.1}%\n{} / {} tokens",
            context_bar(context),
            context.used as f64 / context.size as f64 * 100.,
            compact(context.used),
            compact(context.size),
        ));
    } else {
        text.push_str("Context usage is not available yet.");
    }
    if let Some(spend) = spend.filter(|spend| spend.is_finite() && *spend >= 0.) {
        text.push_str(&format!("\n\nGateway spend · ${spend:.2} this month"));
    }
    json!({"text":text,"parse_mode":"HTML"})
}
