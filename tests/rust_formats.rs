use clap::ValueEnum;
use serde_json::{Value, json};
use tgfx::{
    fx::Projector,
    telegram::reply_style_picker,
    types::{Config, OutputMode, Route},
};

fn config() -> Config {
    serde_json::from_value(json!({
        "version": 1, "activeBotId": "100",
        "access": {"userIds": ["42"], "chatIds": []},
        "approvals": {"chatId": "42"}
    }))
    .unwrap()
}

#[test]
fn picker_has_three_styles_and_marks_only_the_current_choice() {
    let modes = OutputMode::value_variants();
    assert_eq!(modes.len(), 3);
    for &current in modes {
        let picker = reply_style_picker(current);
        let buttons: Vec<&Value> = picker["reply_markup"]["inline_keyboard"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|row| row.as_array().unwrap())
            .collect();
        assert_eq!(buttons.len(), 3);
        assert_eq!(
            buttons
                .iter()
                .filter(|b| b["text"].as_str().unwrap().starts_with('✓'))
                .count(),
            1
        );
        for (&mode, button) in modes.iter().zip(buttons) {
            assert_eq!(button["callback_data"], format!("fmt:{mode}"));
            assert_eq!(
                button["text"].as_str().unwrap().starts_with('✓'),
                mode == current
            );
            assert_eq!(mode.to_string().parse::<OutputMode>().unwrap(), mode);
        }
    }
    assert!("report".parse::<OutputMode>().is_err());
}

#[test]
fn dm_choices_override_the_default_only_for_their_chat() {
    let mut c = config();
    assert_eq!(c.output, OutputMode::Live);
    c.chat_formats.insert("42".into(), OutputMode::Final);
    c.chat_formats.insert("43".into(), OutputMode::Detailed);
    for (chat, expected) in [
        ("42", OutputMode::Final),
        ("43", OutputMode::Detailed),
        ("44", OutputMode::Live),
    ] {
        assert_eq!(
            c.output_for(&Route::new("100", chat, "0", "private")),
            expected
        );
    }
    c.output = OutputMode::Detailed;
    assert_eq!(
        c.output_for(&Route::new("100", "42", "0", "private")),
        OutputMode::Final
    );
    assert_eq!(
        c.output_for(&Route::new("100", "44", "0", "private")),
        OutputMode::Detailed
    );
}

#[test]
fn group_routes_always_use_final() {
    let mut c = config();
    c.output = OutputMode::Detailed;
    for kind in ["group", "supergroup"] {
        for topic in ["0", "17"] {
            assert_eq!(
                c.output_for(&Route::new("100", "-9", topic, kind)),
                OutputMode::Final
            );
        }
    }
}

#[test]
fn live_shows_tool_status_then_streams_only_the_answer() {
    let mut projector = Projector::new();
    projector.apply(&json!({
        "sessionUpdate": "tool_call", "toolCallId": "read-1",
        "name": "read_file", "title": "read_file", "kind": "read",
        "status": "in_progress", "rawInput": {"path": "README.md"}
    }));
    let working = projector.rich(OutputMode::Live, false);
    assert_eq!(working["blocks"][0]["type"], "thinking");
    assert!(working.to_string().to_lowercase().contains("read"));
    projector.apply(&json!({
        "sessionUpdate": "tool_call_update", "toolCallId": "read-1",
        "status": "completed"
    }));
    projector.apply(&json!({
        "sessionUpdate": "agent_message_chunk",
        "content": {"type": "text", "text": "The answer"}
    }));
    let streaming = projector.rich(OutputMode::Live, false).to_string();
    assert!(streaming.contains("The answer"));
    assert!(!streaming.contains("details"));
    assert_eq!(projector.plain_final(OutputMode::Live), "The answer");
}
