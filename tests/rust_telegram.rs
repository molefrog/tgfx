use axum::{
    Json, Router,
    extract::{Path, State},
    routing::post,
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tgfx::{telegram::*, types::*};
use tokio::sync::Notify;
#[derive(Clone, Default)]
struct Mock {
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    notify: Arc<Notify>,
    rich_failure: bool,
}
async fn endpoint(
    State(mock): State<Mock>,
    Path(method): Path<String>,
    body: axum::body::Bytes,
) -> (axum::http::StatusCode, Json<Value>) {
    let v = serde_json::from_slice(&body).unwrap_or(json!({"multipart":true}));
    mock.calls.lock().unwrap().push((method.clone(), v));
    mock.notify.notify_waiters();
    if mock.rich_failure && method == "sendRichMessage" {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({"ok":false,"error_code":400,"description":"rich rejected"})),
        );
    }
    let result = match method.as_str() {
        "getMe" => json!({"id":123,"first_name":"Test","username":"test_bot"}),
        "getUpdates" => json!([{"update_id":1,"unknown_future_update":{"text":"new schema"}}]),
        "getStickerSet" => {
            json!({"name":"pack","title":"Pack","sticker_type":"regular","stickers":[]})
        }
        "getChatMember" => {
            json!({"status":"administrator","can_pin_messages":true,"can_manage_topics":true,"can_delete_messages":true,"can_restrict_members":true,"can_invite_users":true})
        }
        "sendPoll" => json!({"message_id":11,"poll":{"id":"poll-1"}}),
        "sendMessage" | "sendRichMessage" | "sendDocument" | "sendPhoto" | "sendVoice"
        | "sendVideoNote" | "sendSticker" => json!({"message_id":10}),
        _ => json!(true),
    };
    (
        axum::http::StatusCode::OK,
        Json(json!({"ok":true,"result":result})),
    )
}
async fn mock(failure: bool) -> (Mock, TelegramApi, tokio::task::JoinHandle<()>) {
    let mock = Mock {
        rich_failure: failure,
        ..Default::default()
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let api = TelegramApi::new("123:TEST", Some(&url)).unwrap();
    let router = Router::new()
        .route("/bot123:TEST/{method}", post(endpoint))
        .with_state(mock.clone());
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (mock, api, task)
}
fn bot() -> BotIdentity {
    BotIdentity {
        id: "123".into(),
        username: Some("test_bot".into()),
        display_name: "Test".into(),
    }
}
#[test]
fn normalization_retains_media_location_reply_forward_and_anonymous_identity() {
    let mut m = json!({"message_id":12,"date":100,"chat":{"id":-100,"type":"supergroup"},"message_thread_id":2,"from":{"id":99,"is_bot":true},"sender_chat":{"id":-100,"title":"Anonymous admin"},"caption":"caption","forward_origin":{"type":"hidden_user","sender_user_name":"Source"},"media_group_id":"album","venue":{"title":"Office","address":"Road","location":{"latitude":1,"longitude":2}},"reply_to_message":{"message_id":11,"from":{"id":5,"first_name":"User"},"text":"previous"}});
    for k in [
        "voice",
        "audio",
        "video",
        "animation",
        "document",
        "sticker",
        "video_note",
    ] {
        m[k] = json!({"file_id":k,"file_unique_id":format!("u-{k}"),"width":512,"height":512,"length":100,"duration":2,"set_name":"pack","emoji":"🦀"})
    }
    m["photo"] =
        json!([{"file_id":"small","file_unique_id":"s"},{"file_id":"large","file_unique_id":"l"}]);
    let update = json!({"update_id":7,"message":m});
    let normalized =
        normalize_with_lookup(&update, &bot(), |_, id| Some(format!("known-{id}"))).unwrap();
    assert_eq!(normalized.attachments.len(), 8);
    assert_eq!(normalized.attachments[0].file_id, "large");
    assert_eq!(normalized.sender.kind, "chat");
    assert_eq!(normalized.route.topic_id, "2");
    assert_eq!(
        normalized.reply.as_ref().unwrap()["message_ref"],
        "known-11"
    );
    let envelope = to_envelope(&normalized, true);
    assert_eq!(envelope["telegram_message"]["forwarded"], true);
    assert_eq!(envelope["telegram_message"]["location"]["latitude"], 1);
    assert!(envelope["telegram_message"]["session_bootstrap"].is_string());
}
#[test]
fn mentions_use_utf16_offsets_and_commands_ignore_other_bots() {
    let update = json!({"update_id":1,"message":{"message_id":1,"date":0,"chat":{"id":-1,"type":"group"},"from":{"id":1,"first_name":"User"},"text":"🦀 @test_bot hello","entities":[{"type":"mention","offset":3,"length":9}]}});
    let m = normalize(&update, &bot()).unwrap();
    assert!(should_invoke_agent(&m, &bot(), "mention"));
    assert!(
        !command_from_text(Some("/stop@other_bot"), Some("test_bot"))
            .unwrap()
            .addressed
    );
    assert!(normalize(&json!({"update_id":1,"message":{"message_id":1,"chat":{"id":1},"contact":{"phone_number":"x"}}}),&bot()).is_none());
}
#[tokio::test]
async fn raw_updates_and_sticker_sets_accept_future_schema() {
    let (_, api, task) = mock(false).await;
    assert!(api.get_updates(0, 0).await.unwrap()[0]["unknown_future_update"].is_object());
    assert_eq!(
        api.call("getStickerSet", json!({"name":"pack"}))
            .await
            .unwrap()["name"],
        "pack"
    );
    assert_eq!(api.get_me().await.unwrap().id, "123");
    task.abort();
}
#[tokio::test]
async fn rich_failure_splits_plain_without_losing_unicode() {
    let (mock, api, task) = mock(true).await;
    let route = Route::new("123", "42", "0", "private");
    let text = "🦀".repeat(5000);
    let sent = deliver(&api, &route, json!({"blocks":[]}), &text)
        .await
        .unwrap();
    assert!(sent.len() > 1);
    let calls = mock.calls.lock().unwrap();
    let parts = calls
        .iter()
        .filter(|(m, _)| m == "sendMessage")
        .map(|(_, p)| p["text"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(parts.concat(), text);
    assert!(parts.iter().all(|s| s.encode_utf16().count() <= 4000));
    task.abort();
}
#[test]
fn draft_limiter_shares_flood_penalty_and_rolling_budget() {
    let mut limiter = PeerDraftLimiter::default();
    for i in 0..18 {
        limiter.record_attempt(i * 250)
    }
    assert!(limiter.next_allowed_at(4500, false) >= 5000);
    limiter.record_flood(5000, 3000);
    assert!(limiter.next_allowed_at(5100, true) >= 8000);
    limiter.record_success();
}
#[tokio::test]
async fn draft_offers_coalesce_to_latest_and_stop_promptly() {
    let (mock, api, server) = mock(false).await;
    let stream = DraftStream::start(
        api,
        Route::new("123", "42", "0", "private"),
        9,
        Arc::new(Mutex::new(PeerDraftLimiter::default())),
    );
    for i in 0..100 {
        stream.offer(json!({"blocks":[{"type":"paragraph","text":format!("frame-{i}")}]}))
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let notified = mock.notify.notified();
            if mock.calls.lock().unwrap().iter().any(|(m, v)| {
                m == "sendRichMessageDraft" && v["rich_message"]["blocks"][0]["text"] == "frame-99"
            }) {
                break;
            }
            notified.await
        }
    })
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(1), stream.stop())
        .await
        .unwrap();
    let calls = mock.calls.lock().unwrap();
    assert!(
        calls
            .iter()
            .filter(|(m, _)| m == "sendRichMessageDraft")
            .count()
            < 10
    );
    server.abort();
}
#[tokio::test]
async fn deferred_drafts_render_only_the_latest_frame_after_rate_limit() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let (mock, api, server) = mock(false).await;
    let limiter = Arc::new(Mutex::new(PeerDraftLimiter::default()));
    limiter.lock().unwrap().record_flood(0, 3_600_000);
    let stream = DraftStream::start(
        api,
        Route::new("123", "42", "0", "private"),
        11,
        limiter.clone(),
    );
    let renders = Arc::new(AtomicUsize::new(0));
    for i in 0..100 {
        let renders = renders.clone();
        stream.offer_lazy(move || {
            renders.fetch_add(1, Ordering::Relaxed);
            json!({"blocks":[{"type":"paragraph","text":format!("discard-{i}")}]})
        });
        tokio::task::yield_now().await;
    }
    assert_eq!(renders.load(Ordering::Relaxed), 0);
    *limiter.lock().unwrap() = PeerDraftLimiter::default();
    let final_renders = renders.clone();
    stream.offer_lazy(move || {
        final_renders.fetch_add(1, Ordering::Relaxed);
        json!({"blocks":[{"type":"paragraph","text":"latest"}]})
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let notified = mock.notify.notified();
            if mock.calls.lock().unwrap().iter().any(|(method, value)| {
                method == "sendRichMessageDraft"
                    && value["rich_message"]["blocks"][0]["text"] == "latest"
            }) {
                break;
            }
            notified.await;
        }
    })
    .await
    .unwrap();
    stream.stop().await;
    assert_eq!(renders.load(Ordering::Relaxed), 1);
    server.abort();
}
#[test]
fn sticker_conversion_enforces_dimensions_and_size() {
    let image = image::RgbaImage::from_pixel(1200, 200, image::Rgba([255, 0, 0, 255]));
    let mut source = std::io::Cursor::new(vec![]);
    image
        .write_to(&mut source, image::ImageFormat::Png)
        .unwrap();
    let bytes = tgfx::sticker::webp(source.get_ref()).unwrap();
    assert!(bytes.len() <= 512 * 1024);
    let decoded = image::load_from_memory(&bytes).unwrap();
    assert_eq!(decoded.width(), 512);
    assert!(decoded.height() < 512);
}
#[test]
fn rich_controls_and_icons_match_frankenstein_schema() {
    use frankenstein::rich_message::InputRichMessage;
    for action in ["clear", "compact"] {
        serde_json::from_value::<InputRichMessage>(session_confirmation(action, "interaction"))
            .unwrap();
    }
    let span = custom_icon("provider", "spacexai", "❌", true);
    assert!(span.get("alternative_text").is_some());
    serde_json::from_value::<InputRichMessage>(
        json!({"blocks":[{"type":"paragraph","text":[span]}]}),
    )
    .unwrap();
    let report = json!({"period":"24h","totals":{"spend":1.0,"request_count":3,"total_tokens":100},"models":[]});
    serde_json::from_value::<InputRichMessage>(cost_report(&report)["rich_message"].clone())
        .unwrap();
}
#[tokio::test]
async fn continuous_stream_updates_do_not_postpone_commits() {
    let (mock, api, server) = mock(false).await;
    let stream = Arc::new(DraftStream::start(
        api,
        Route::new("123", "42", "0", "private"),
        10,
        Arc::new(Mutex::new(PeerDraftLimiter::default())),
    ));
    let sender = stream.clone();
    let producer = tokio::spawn(async move {
        let mut counter = 0;
        let mut interval = tokio::time::interval(Duration::from_millis(5));
        loop {
            interval.tick().await;
            sender
                .offer(json!({"blocks":[{"type":"paragraph","text":format!("frame-{counter}")}]}));
            counter += 1;
        }
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let notified = mock.notify.notified();
            if mock
                .calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, _)| m == "sendRichMessageDraft")
                .count()
                >= 3
            {
                break;
            }
            notified.await
        }
    })
    .await
    .unwrap();
    producer.abort();
    let _ = producer.await;
    Arc::try_unwrap(stream).ok().unwrap().stop().await;
    server.abort();
}

#[test]
fn model_menu_only_offers_supported_settings_and_marks_the_active_choice() {
    let mut config = vec![
        json!({"id":"model","currentValue":"grok-4.7","options":[{"value":"grok-4.7","name":"Grok"}]}),
        json!({"id":"effort","currentValue":"auto","options":[{"group":"Thinking","options":[{"value":"auto","name":"default"},{"value":"high","name":"high"}]}]}),
        json!({"id":"fast","type":"select","currentValue":"true","options":[{"value":"false","name":"off"},{"value":"true","name":"on"}]}),
    ];
    let view = model_menu(&config, "id", Some(0), 0, None, false).unwrap();
    let rows = view["reply_markup"]["inline_keyboard"].as_array().unwrap();
    assert_eq!(rows[rows.len() - 2][0]["text"], "Effort · Default ›");
    assert_eq!(rows[rows.len() - 2][1]["text"], "Speed · Fast ›");
    let speed = model_menu(&config, "id", Some(0), 0, Some("f"), false).unwrap();
    assert_eq!(
        speed["reply_markup"]["inline_keyboard"][0]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        speed["reply_markup"]["inline_keyboard"][0][1]["text"],
        "✓ Fast"
    );
    assert_eq!(
        model_setting_choices(&config, "f")[0]["changes"],
        json!([["fast", "false"]])
    );
    config.truncate(1);
    assert!(model_setting_choices(&config, "f").is_empty());
    assert!(model_setting_choices(&config, "e").is_empty());
}
