use serde_json::Value;
#[path = "support/presentation.rs"]
mod presentation;

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
    usage_presentation => "cost_report",
    selected_model_presentation => "selected_model",
    model_pagination_and_icons => "model_picker_icons",
}

#[test]
fn catalogs_have_unique_identities_and_human_tool_descriptions() {
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
