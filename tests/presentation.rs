use serde_json::{Value, json};
use tgfx::{fx::projector::Projector, types::OutputMode};
#[path = "support/presentation.rs"]
mod presentation;

#[test]
fn toolbox_previews_show_the_target_instead_of_raw_arguments() {
    for (input, target, title) in [
        (
            json!({"search":"find invoices","limit":5}),
            "find invoices",
            "Finding",
        ),
        (json!({"search":"", "server":"github"}), "github", "Finding"),
        (
            json!({"open":"invoicing","kind":"skill"}),
            "invoicing",
            "skill",
        ),
        (
            json!({"open":"github","kind":"mcp_server"}),
            "github",
            "server",
        ),
        (
            json!({"open":"mcp_github_search","kind":"tool"}),
            "mcp_github_search",
            "instructions",
        ),
    ] {
        let d = tgfx::fx::tools::describe_tool("toolbox", "Opening", "other", &input);
        assert_eq!(d.argument, target);
        assert!(d.title.contains(title));
    }
}

#[test]
fn internal_discovery_stays_hidden_after_completion_and_does_not_change_status() {
    let mut p = Projector::new();
    p.set_now(0);
    assert_eq!(
        p.apply(&json!({
            "sessionUpdate":"tool_call", "toolCallId":"discover", "name":"toolbox",
            "title":"Searching toolbox", "status":"in_progress", "rawInput":{"search":"invoices"},
            "_meta":{"fx":{"toolCall":{"internal":true}}}
        })),
        "none"
    );
    p.set_now(3000);
    assert_eq!(p.status(), "Thinking…");
    p.apply(
        &json!({"sessionUpdate":"tool_call_update", "toolCallId":"discover", "status":"completed"}),
    );
    for mode in [OutputMode::Live, OutputMode::Detailed, OutputMode::Final] {
        for done in [false, true] {
            let rich = p.rich(mode, done).to_string();
            assert!(!rich.contains("toolbox"));
            assert!(!rich.contains("invoices"));
        }
        assert!(!p.plain_final(mode).contains("invoices"));
    }
    assert!(p.tool_states()[0].internal);
}

#[test]
fn mcp_metadata_keeps_action_labels_and_service_icons_across_updates() {
    let mut p = Projector::new();
    p.set_icons([("telegram".into(), "12345".into())].into());
    // FX has already unwrapped toolbox run; the identity need not be inferred
    // from the advertised (potentially renamed) tool name.
    p.apply(&json!({
        "sessionUpdate":"tool_call", "toolCallId":"run", "name":"opaque_tool_name",
        "title":"Telegram", "status":"in_progress", "rawInput":{"reaction":"eyes"},
        "_meta":{"fx":{"toolCall":{"internal":false,"mcp":{"server":"telegram","tool":"set_reaction"}}}}
    }));
    p.apply(&json!({"sessionUpdate":"tool_call_update", "toolCallId":"run", "status":"completed"}));
    let rich = p.rich(OutputMode::Detailed, true).to_string();
    assert!(rich.contains("Reacting"));
    assert!(rich.contains("12345"));
    assert!(!rich.contains("opaque_tool_name"));
    assert_eq!(p.status(), "Using Telegram…");
}

#[test]
fn late_internal_metadata_removes_an_already_visible_row() {
    let mut p = Projector::new();
    p.apply(&json!({"sessionUpdate":"tool_call", "toolCallId":"a", "name":"toolbox", "rawInput":{"open":"github"}}));
    assert!(
        p.rich(OutputMode::Detailed, false)
            .to_string()
            .contains("github")
    );
    assert_eq!(
        p.apply(&json!({
            "sessionUpdate":"tool_call_update", "toolCallId":"a", "status":"completed",
            "_meta":{"fx":{"toolCall":{"internal":true}}}
        })),
        "tool"
    );
    assert!(
        !p.rich(OutputMode::Detailed, true)
            .to_string()
            .contains("github")
    );
}

// These outcomes passed the original behavior assertions before their test
// harness was removed. They are inputs and expected wire output, not a runtime.
fn check(operation: &str) {
    let mut count = 0;
    for (line, source) in include_str!("fixtures/presentation.jsonl")
        .lines()
        .enumerate()
    {
        let case: Value = serde_json::from_str(source).unwrap();
        if case["input"]["op"] != operation {
            continue;
        }
        count += 1;
        let mut actual = presentation::render(&case["input"]).unwrap();
        let mut expected = case["expected"].clone();
        if operation == "normalize" {
            normalize_references(&mut actual, &mut Default::default());
            normalize_references(&mut expected, &mut Default::default());
        }
        assert_eq!(
            actual,
            expected,
            "presentation case {}: {}",
            line + 1,
            case["input"]
        );
    }
    assert!(count > 0, "No cases for {operation}");
}

// Generated references must stay distinct and correctly linked, but their UUIDs vary.
fn normalize_references(value: &mut Value, refs: &mut std::collections::HashMap<String, String>) {
    match value {
        Value::String(s) => {
            if let Some((prefix, id)) = s.split_once('_')
                && ["usr", "chat", "unknown", "msg", "ctx", "att"].contains(&prefix)
                && uuid::Uuid::parse_str(id).is_ok()
            {
                let replacement = format!("{prefix}_{}", refs.len());
                *s = refs.entry(s.clone()).or_insert(replacement).clone();
            }
        }
        Value::Array(values) => values
            .iter_mut()
            .for_each(|v| normalize_references(v, refs)),
        Value::Object(values) => values
            .values_mut()
            .for_each(|v| normalize_references(v, refs)),
        _ => {}
    }
}

macro_rules! cases {
    ($($name:ident => $op:literal),* $(,)?) => {$(
        #[test]
        fn $name() { check($op); }
    )*};
}
cases! {
    markdown_streaming_and_rich_blocks => "markdown",
    projector_ordering_and_visibility => "projector",
    tool_descriptions_and_arguments => "tools",
    inbound_message_normalization => "normalize",
    message_envelopes => "envelope",
    access_rules => "authorized",
    invocation_rules => "invoke",
    command_addressing => "command",
    group_migration => "migration",
    confirmation_buttons => "session_confirmation",
    usage_validation => "parse_usage",
    usage_presentation => "usage_report",
    selected_model_presentation => "selected_model",
    model_pagination_and_icons => "model_picker_icons",
}

#[test]
fn catalogs_have_unique_identities_and_human_tool_descriptions() {
    assert!(tgfx::fx::projector::default_icons().contains_key("tool:toolbox"));
    let icons = tgfx::telegram::custom_icons(None);
    for field in ["id", "image", "customEmojiId"] {
        let values = icons
            .iter()
            .map(|v| v[field].to_string())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(values.len(), icons.len(), "Duplicate {field}");
    }
    for category in ["provider", "mcp", "tool"] {
        assert!(!tgfx::telegram::custom_icons(Some(category)).is_empty());
    }
    for name in tgfx::fx::tools::FX_TOOL_NAMES {
        let description =
            tgfx::fx::tools::describe_tool(name, "", "", &serde_json::json!({"action":"run"}));
        assert!(!description.title.is_empty());
        assert!(!description.title.contains('_'));
        if name != "mcp_select_tool" {
            assert!(
                description
                    .activity
                    .is_some_and(|activity| tgfx::fx::tools::ACTIVITY_ORDER.contains(&activity))
            );
        }
    }
    assert!(tgfx::fx::usage::parse_usage("{}").is_err());
}
