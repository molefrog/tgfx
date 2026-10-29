//! Route-scoped Telegram MCP service and revocable Unix broker.
pub mod broker;
pub mod files;
mod server;
pub use broker::{McpLease, TelegramMcpBroker, proxy};
pub use server::{McpEnvironment, TelegramMcp, serve};
