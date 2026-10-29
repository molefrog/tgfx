mod controls;
pub use controls::*;
// Telegram transport and presentation. Raw JSON preserves new Bot API updates.
mod delivery;
mod normalize;
use crate::types::{BotIdentity, Route};
use anyhow::{Result, bail};
pub use delivery::*;
use frankenstein::{AsyncTelegramApi, client_reqwest::Bot};
pub use normalize::*;
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};

#[derive(Debug, Clone)]
pub struct TelegramError {
    pub description: String,
    pub code: Option<u16>,
    pub retry_after: Option<u64>,
}
impl std::fmt::Display for TelegramError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.description)
    }
}
impl std::error::Error for TelegramError {}
impl TelegramError {
    pub fn retryable(&self) -> bool {
        self.retry_after.is_some() || self.code.is_none_or(|n| n == 429 || n >= 500)
    }
}
#[derive(Clone)]
pub struct TelegramApi {
    bot: Bot,
    http: reqwest::Client,
    token: Arc<String>,
    root: Arc<String>,
    file_root: Arc<String>,
}
impl TelegramApi {
    pub fn new(token: &str, base_url: Option<&str>) -> Result<Self> {
        if token.trim().is_empty() {
            bail!("Telegram token is empty")
        }
        let root = base_url
            .map(str::to_owned)
            .or_else(|| std::env::var("TGFX_API_ROOT").ok())
            .or_else(|| std::env::var("TGFX_INTERNAL_TELEGRAM_API_ROOT").ok())
            .unwrap_or_else(|| "https://api.telegram.org".into())
            .trim_end_matches('/')
            .to_owned();
        let url = format!("{root}/bot{token}");
        let file_root = std::env::var("TGFX_INTERNAL_TELEGRAM_FILE_ROOT")
            .unwrap_or_else(|_| format!("{root}/file/bot{token}"));
        Ok(Self {
            bot: Bot::builder()
                .api_url(url)
                .client(
                    reqwest::Client::builder()
                        .timeout(Duration::from_secs(70))
                        .build()?,
                )
                .build(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(70))
                .build()?,
            token: Arc::new(token.into()),
            root: Arc::new(root),
            file_root: Arc::new(file_root),
        })
    }
    fn redact(&self, text: &str) -> String {
        text.replace(self.token.as_str(), "[REDACTED]")
    }
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let response: Value =
            self.bot
                .request(method, Some(&params))
                .await
                .map_err(|e| match e {
                    frankenstein::Error::Api(api) => TelegramError {
                        description: self
                            .redact(&format!("Telegram {method}: {}", api.description)),
                        code: Some(api.error_code as u16),
                        retry_after: api.parameters.and_then(|p| p.retry_after).map(u64::from),
                    },
                    other => TelegramError {
                        description: self.redact(&other.to_string()),
                        code: None,
                        retry_after: None,
                    },
                })?;
        self.result(method, response)
    }
    fn result(&self, method: &str, response: Value) -> Result<Value> {
        if response["ok"] == false {
            return Err(TelegramError {
                description: self.redact(&format!(
                    "Telegram {method}: {}",
                    response["description"].as_str().unwrap_or("request failed")
                )),
                code: response["error_code"].as_u64().map(|n| n as u16),
                retry_after: response["parameters"]["retry_after"].as_u64(),
            }
            .into());
        }
        Ok(response.get("result").cloned().unwrap_or(response))
    }
    pub async fn upload(
        &self,
        method: &str,
        params: Value,
        field: &str,
        path: &Path,
    ) -> Result<Value> {
        self.upload_bytes(
            method,
            params,
            field,
            path.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("upload"),
            tokio::fs::read(path).await?,
        )
        .await
    }
    pub async fn upload_bytes(
        &self,
        method: &str,
        params: Value,
        field: &str,
        name: &str,
        bytes: Vec<u8>,
    ) -> Result<Value> {
        let mut form = reqwest::multipart::Form::new();
        if let Some(map) = params.as_object() {
            for (k, v) in map {
                if !v.is_null() {
                    form = form.text(
                        k.clone(),
                        v.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| v.to_string()),
                    );
                }
            }
        }
        form = form.part(
            field.to_owned(),
            reqwest::multipart::Part::bytes(bytes).file_name(name.to_owned()),
        );
        let response = self
            .http
            .post(format!("{}/bot{}/{method}", self.root, self.token))
            .multipart(form)
            .send()
            .await
            .map_err(|e| TelegramError {
                description: self.redact(&e.to_string()),
                code: None,
                retry_after: None,
            })?;
        let value = response.json::<Value>().await.map_err(|e| TelegramError {
            description: self.redact(&e.to_string()),
            code: None,
            retry_after: None,
        })?;
        self.result(method, value)
    }
    pub async fn get_me(&self) -> Result<BotIdentity> {
        let v = self.call("getMe", json!({})).await?;
        Ok(BotIdentity {
            id: crate::types::decimal(&v["id"])
                .ok_or_else(|| anyhow::anyhow!("Telegram bot identity missing ID"))?,
            username: v["username"].as_str().map(str::to_owned),
            display_name: [v["first_name"].as_str(), v["last_name"].as_str()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" "),
        })
    }
    pub async fn get_updates(&self, offset: i64, timeout: u32) -> Result<Vec<Value>> {
        let v=self.call("getUpdates",json!({"offset":offset,"timeout":timeout,"allowed_updates":["message","edited_message","callback_query","poll_answer","chat_join_request","my_chat_member","stopped_message_generation"]})).await?;
        Ok(serde_json::from_value(v)?)
    }
    pub async fn send_text(&self, route: &Route, text: &str) -> Result<Value> {
        let mut p = route_params(route);
        p["text"] = json!(text);
        self.call("sendMessage", p).await
    }
    pub async fn send_rich(&self, route: &Route, rich: Value) -> Result<Value> {
        let mut p = route_params(route);
        p["rich_message"] = rich;
        self.call("sendRichMessage", p).await
    }
    pub async fn draft(&self, route: &Route, id: i64, rich: Value) -> Result<Value> {
        let mut p = route_params(route);
        p["draft_id"] = json!(id);
        p["rich_message"] = rich;
        p["can_stop"] = json!(true);
        self.call("sendRichMessageDraft", p).await
    }
    pub async fn download(&self, file_id: &str) -> Result<(String, reqwest::Response)> {
        let v = self.call("getFile", json!({"file_id":file_id})).await?;
        let path = v["file_path"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Telegram did not return a downloadable file path"))?;
        if path.starts_with('/') || path.split('/').any(|s| s == "..") {
            bail!("Invalid Telegram file path")
        };
        let response = self
            .http
            .get(format!("{}/{path}", self.file_root))
            .send()
            .await
            .map_err(|e| anyhow::anyhow!(self.redact(&e.to_string())))?;
        Ok((path.into(), response))
    }
}
pub fn route_params(route: &Route) -> Value {
    let mut p = json!({"chat_id":route.chat_id});
    if route.topic_id != "0" {
        p["message_thread_id"] = json!(route.topic_id.parse::<i64>().unwrap_or(0));
    }
    p
}
pub fn admin_capabilities(member: &Value) -> std::collections::HashSet<String> {
    let creator = member["status"] == "creator";
    [
        ("pins", "can_pin_messages"),
        ("topics", "can_manage_topics"),
        ("delete_messages", "can_delete_messages"),
        ("moderation", "can_restrict_members"),
        ("join_requests", "can_invite_users"),
    ]
    .into_iter()
    .filter(|(_, field)| creator || (member["status"] == "administrator" && member[*field] == true))
    .map(|(name, _)| name.into())
    .collect()
}
