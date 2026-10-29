use super::{TelegramApi, TelegramError};
use crate::types::Route;
use anyhow::Result;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::watch, time::Instant};
use tokio_util::sync::CancellationToken;
#[derive(Debug, Default)]
pub struct PeerDraftLimiter {
    attempts: VecDeque<u64>,
    blocked_until: u64,
    penalty: u64,
}
impl PeerDraftLimiter {
    pub fn next_allowed_at(&mut self, now: u64, immediate: bool) -> u64 {
        while self
            .attempts
            .front()
            .is_some_and(|n| now >= 30000 && *n <= now - 30000)
        {
            self.attempts.pop_front();
        }
        let mut at = now.max(self.blocked_until);
        if !immediate && let Some(last) = self.attempts.back() {
            at = at.max(last + 250 + self.penalty)
        }
        for (window, limit) in [(5000, 18), (30000, 36)] {
            let relevant = self
                .attempts
                .iter()
                .filter(|t| at < window || **t > at - window)
                .copied()
                .collect::<Vec<_>>();
            if relevant.len() >= limit {
                at = at.max(relevant[relevant.len() - limit] + window)
            }
        }
        if self.attempts.len() >= 10
            && let (Some(first), Some(last)) = (self.attempts.front(), self.attempts.back())
        {
            let remaining = 36usize.saturating_sub(self.attempts.len()).max(1) as u64;
            let gap = (first + 30000)
                .saturating_sub(at)
                .div_ceil(remaining)
                .max(834);
            at = at.max(last + gap + self.penalty)
        }
        at
    }
    pub fn record_attempt(&mut self, now: u64) {
        self.attempts.push_back(now)
    }
    pub fn record_success(&mut self) {
        self.penalty = self.penalty.saturating_sub(25)
    }
    pub fn record_flood(&mut self, now: u64, retry_ms: u64) {
        self.blocked_until = self.blocked_until.max(now + retry_ms.max(1000));
        self.penalty = if self.penalty == 0 {
            100
        } else {
            (self.penalty * 3).div_ceil(2).min(1000)
        }
    }
}
pub type SharedDraftLimiter = Arc<Mutex<PeerDraftLimiter>>;
#[derive(Clone)]
enum DraftFrame {
    Rich(Value),
    Deferred(Arc<dyn Fn() -> Value + Send + Sync>),
}
/// Offers never await Telegram. Deferred frames render only when ready to send.
pub struct DraftStream {
    sender: watch::Sender<Option<DraftFrame>>,
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl DraftStream {
    pub fn start(api: TelegramApi, route: Route, id: i64, limiter: SharedDraftLimiter) -> Self {
        let (sender, mut receiver) = watch::channel(None::<DraftFrame>);
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let task = tokio::spawn(async move {
            static EPOCH: std::sync::LazyLock<std::time::Instant> =
                std::sync::LazyLock::new(std::time::Instant::now);
            let now = || EPOCH.elapsed().as_millis() as u64;
            let mut committed = None;
            let mut pending = None;
            let mut pending_since = 0;
            let mut errors = 0;
            let mut first = true;
            let mut keepalive = Instant::now() + Duration::from_secs(20);
            loop {
                if pending.is_none() {
                    tokio::select! {_ =stop.cancelled()=>break,r=receiver.changed()=>{if r.is_err(){break}pending=receiver.borrow_and_update().clone();},_=tokio::time::sleep_until(keepalive),if committed.is_some()=>{pending=committed.clone().map(DraftFrame::Rich);}}
                    pending_since = now();
                }
                if pending.is_none() {
                    continue;
                }
                if matches!(&pending, Some(DraftFrame::Rich(frame)) if Some(frame) == committed.as_ref())
                    && Instant::now() < keepalive
                {
                    pending = None;
                    continue;
                }
                let allowed = limiter
                    .lock()
                    .unwrap()
                    .next_allowed_at(now().max(pending_since + if first { 0 } else { 40 }), first);
                tokio::select! {_=stop.cancelled()=>break,r=receiver.changed()=>{if r.is_err(){break}pending=receiver.borrow_and_update().clone();continue},_=tokio::time::sleep(Duration::from_millis(allowed.saturating_sub(now())))=>{}}
                let Some(frame) = pending.take() else {
                    continue;
                };
                let frame = match frame {
                    DraftFrame::Rich(frame) => frame,
                    DraftFrame::Deferred(render) => render(),
                };
                if committed.as_ref() == Some(&frame) && Instant::now() < keepalive {
                    continue;
                }
                limiter.lock().unwrap().record_attempt(now());
                let sent = tokio::select! {_=stop.cancelled()=>break,result=api.draft(&route,id,frame.clone())=>result};
                match sent {
                    Ok(_) => {
                        first = false;
                        errors = 0;
                        committed = Some(frame);
                        keepalive = Instant::now() + Duration::from_secs(20);
                        limiter.lock().unwrap().record_success()
                    }
                    Err(e) => {
                        let typed = e.downcast_ref::<TelegramError>();
                        if typed.is_none_or(TelegramError::retryable) {
                            let retry = typed.and_then(|t| t.retry_after).unwrap_or(1) * 1000;
                            limiter.lock().unwrap().record_flood(now(), retry);
                            pending = Some(DraftFrame::Rich(frame));
                        } else {
                            errors += 1;
                            if errors >= 3 {
                                break;
                            }
                        }
                        tracing::warn!(error=%e,"draft update failed");
                    }
                }
            }
        });
        Self {
            sender,
            cancel,
            task: Some(task),
        }
    }
    pub fn offer(&self, rich: Value) {
        let _ = self.sender.send(Some(DraftFrame::Rich(rich)));
    }
    pub fn offer_lazy(&self, render: impl Fn() -> Value + Send + Sync + 'static) {
        let _ = self
            .sender
            .send(Some(DraftFrame::Deferred(Arc::new(render))));
    }
    pub async fn stop(mut self) {
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}
impl Drop for DraftStream {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}
pub fn split_text(text: &str, limit: usize) -> Vec<String> {
    let mut result = vec![];
    let mut remaining = text;
    while remaining.encode_utf16().count() > limit {
        let mut length = 0;
        let mut boundary = 0;
        for (i, c) in remaining.char_indices() {
            if length + c.len_utf16() > limit {
                break;
            }
            length += c.len_utf16();
            boundary = i + c.len_utf8();
        }
        let prefix = &remaining[..boundary];
        let half = boundary / 2;
        let split = prefix
            .rfind("\n\n")
            .filter(|n| *n >= half)
            .or_else(|| prefix.rfind('\n').filter(|n| *n >= half))
            .or_else(|| prefix.rfind(' ').filter(|n| *n >= half))
            .unwrap_or(boundary);
        result.push(remaining[..split].trim_end().to_owned());
        remaining = remaining[split..].trim_start();
    }
    if !remaining.is_empty() || result.is_empty() {
        result.push(remaining.into())
    }
    result
}
pub async fn retry_call(api: &TelegramApi, method: &str, params: Value) -> Result<Value> {
    let delays = [1, 2, 4, 8, 16, 30, 30, 30];
    for attempt in 0..=delays.len() {
        match api.call(method, params.clone()).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                let typed = e.downcast_ref::<TelegramError>();
                if attempt == delays.len() || typed.is_some_and(|t| !t.retryable()) {
                    return Err(e);
                }
                let seconds = typed.and_then(|t| t.retry_after).unwrap_or(delays[attempt]);
                tokio::time::sleep(Duration::from_secs(seconds)).await;
            }
        }
    }
    unreachable!()
}
/// Complete final answer with bounded transient retries and lossless plain fallback.
pub async fn deliver(
    api: &TelegramApi,
    route: &Route,
    rich: Value,
    text: &str,
) -> Result<Vec<Value>> {
    let mut params = super::route_params(route);
    params["rich_message"] = rich;
    match retry_call(api, "sendRichMessage", params).await {
        Ok(v) => Ok(vec![v]),
        Err(rich_error) => {
            tracing::warn!(error=%rich_error,"rich reply failed; using plain text");
            let mut sent = vec![];
            for part in split_text(text, 4000) {
                let mut p = super::route_params(route);
                p["text"] = json!(part);
                sent.push(retry_call(api, "sendMessage", p).await?)
            }
            Ok(sent)
        }
    }
}
pub fn format_menu(output: crate::types::OutputMode) -> Value {
    json!({"inline_keyboard":([[("answer","Final answer"),("report","Final with activity")],[("progress","Live answer"),("live","Live with activity")]].map(|row|row.map(|(mode,label)|json!({"text":format!("{}{}",if mode==output.as_str(){"✓ "}else{""},label),"callback_data":format!("fmt:{mode}")}))))})
}
