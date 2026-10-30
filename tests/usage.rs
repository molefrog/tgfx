use serde_json::json;
use tgfx::fx::usage::{ContextUsage, gateway_spend, parse_usage};

#[test]
fn subscription_and_unavailable_reports_never_become_zero_dollar_costs() {
    for source in ["grok", "codex", "ai_gateway"] {
        for status in ["ready", "unavailable", "fetching", "failed"] {
            let report = json!({"kind":"usage","schema_version":2,"source":source,
                "period":"month","status":status,"totals":{"spend":0}});
            let parsed = parse_usage(&report.to_string()).unwrap();
            assert_eq!(
                gateway_spend(&parsed),
                (source == "ai_gateway" && status == "ready").then_some(0.)
            );
        }
    }
    for spend in [json!(null), json!(-1), json!("6.94")] {
        assert_eq!(
            gateway_spend(
                &json!({"source":"ai_gateway","status":"ready","totals":{"spend":spend}})
            ),
            None
        );
    }
    for invalid in ["{}", r#"{"kind":"usage","error":"not signed in"}"#] {
        assert!(parse_usage(invalid).is_err());
    }
}

#[test]
fn context_requires_an_explicit_usage_update_with_a_known_capacity() {
    assert_eq!(
        ContextUsage::from_update(&json!({"sessionUpdate":"usage_update","used":0,"size":256000})),
        Some(ContextUsage {
            used: 0,
            size: 256000
        })
    );
    for update in [
        json!({"sessionUpdate":"usage_update","used":1,"size":0}),
        json!({"sessionUpdate":"usage_update","used":1}),
        json!({"sessionUpdate":"usage_update","used":-1,"size":100}),
        json!({"sessionUpdate":"other","used":1,"size":100}),
    ] {
        assert_eq!(ContextUsage::from_update(&update), None);
    }
}

#[test]
fn usage_bar_handles_unknown_empty_full_and_over_capacity_context() {
    use tgfx::telegram::usage_report;
    let unknown = usage_report("openai/<model>", None, None);
    assert!(unknown["text"].as_str().unwrap().contains("&lt;model&gt;"));
    assert!(!unknown["text"].as_str().unwrap().contains("0.0%"));
    assert!(!unknown["text"].as_str().unwrap().contains("Gateway"));
    for (used, expected, percent) in [
        (0, "░".repeat(20), "0.0%"),
        (50, "█".repeat(10) + &"░".repeat(10), "50.0%"),
        (100, "█".repeat(20), "100.0%"),
        (120, "█".repeat(20), "120.0%"),
    ] {
        let view = usage_report("model", Some(ContextUsage { used, size: 100 }), Some(6.94));
        let text = view["text"].as_str().unwrap();
        assert!(text.contains(&format!("<code>{expected}</code>")));
        assert!(text.contains(percent));
        assert!(text.contains("$6.94 this month"));
    }
}
