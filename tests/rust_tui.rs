use ratatui::{Terminal, backend::TestBackend};
use tgfx::{
    tui::{StatusView, UiCommand},
    types::Config,
};
fn config() -> Config {
    serde_json::from_value(serde_json::json!({"version":1,"activeBotId":"100","access":{"userIds":["42"],"chatIds":["-1"]},"approvals":{"chatId":"42"}})).unwrap()
}
#[test]
fn real_status_events_render_unicode_queue_and_approval() {
    let mut view = StatusView::new(&config(), "bot".into(), false);
    view.apply(&serde_json::json!({"type":"turn","state":"started","route":{"key":"100:-1:19","chat":"MOI 👋"},"who":"Алексей"}));
    view.apply(&serde_json::json!({"type":"queue","route":{"key":"100:-1:19","chat":"MOI 👋"},"waiting":3}));
    let mut terminal = Terminal::new(TestBackend::new(90, 18)).unwrap();
    terminal.draw(|f| view.draw(f)).unwrap();
    let output = format!("{:?}", terminal.backend().buffer());
    assert!(output.contains("MOI"));
    assert!(output.contains("Алексей"));
    assert!(output.contains("+3 waiting"));
}
#[test]
fn format_is_not_a_terminal_control() {
    use crossterm::event::KeyCode;
    let mut view = StatusView::new(&config(), "bot".into(), false);
    assert!(view.key(KeyCode::Char('f')).is_none());
    assert!(!view.reply_menu);
    let mut terminal = Terminal::new(TestBackend::new(90, 18)).unwrap();
    terminal.draw(|f| view.draw(f)).unwrap();
    assert!(!format!("{:?}", terminal.backend().buffer()).contains("format"));
}
#[test]
fn reply_controls_still_support_select_and_cancel() {
    use crossterm::event::KeyCode;
    let mut view = StatusView::new(&config(), "bot".into(), false);
    view.key(KeyCode::Char('r'));
    view.key(KeyCode::Down);
    assert!(view.key(KeyCode::Esc).is_none());
    assert!(!view.reply_menu);
    view.key(KeyCode::Char('r'));
    view.key(KeyCode::Tab);
    view.key(KeyCode::Char('2'));
    assert!(matches!(
        view.key(KeyCode::Enter),
        Some(UiCommand::Reply { target, policy: Some(policy) })
            if target == "groups" && policy == "mention"
    ));
    assert!(matches!(
        view.key(KeyCode::Char('p')),
        Some(UiCommand::Paused(true))
    ));
}
#[test]
fn narrow_viewports_and_logs_are_bounded_and_redacted() {
    let mut view = StatusView::new(&config(), "bot".into(), true);
    for _ in 0..300 {
        view.apply(&serde_json::json!({"event":"log","message":"123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}));
    }
    assert_eq!(view.logs.len(), 200);
    assert!(!view.logs[0].contains("AAAA"));
    for (w, h) in [(20, 5), (50, 12), (120, 30)] {
        let mut terminal = Terminal::new(TestBackend::new(w, h)).unwrap();
        terminal.draw(|f| view.draw(f)).unwrap();
    }
}
#[test]
fn no_color_renders_with_terminal_default_colors() {
    let mut view = StatusView::new(&config(), "bot".into(), false);
    view.no_color = true;
    let mut terminal = Terminal::new(TestBackend::new(90, 18)).unwrap();
    terminal.draw(|f| view.draw(f)).unwrap();
    assert!(
        terminal
            .backend()
            .buffer()
            .content
            .iter()
            .all(|c| c.fg == ratatui::style::Color::Reset && c.bg == ratatui::style::Color::Reset)
    );
}
