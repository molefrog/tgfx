//! Route-scoped Telegram MCP service and revocable Unix broker.
pub mod broker;
pub mod files;
mod server;
pub use broker::{McpLease, TelegramMcpBroker, proxy};
pub use server::{McpEnvironment, TelegramMcp, serve};

/// Reusable integration instructions, attached to new Telegram FX sessions.
pub const TELEGRAM_GUIDELINES: &str = include_str!("guidelines.md");
