use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextUsage {
    pub used: u64,
    pub size: u64,
}

impl ContextUsage {
    pub fn from_update(update: &Value) -> Option<Self> {
        if update["sessionUpdate"] != "usage_update" {
            return None;
        }
        let usage = Self {
            used: update["used"].as_u64()?,
            size: update["size"].as_u64()?,
        };
        (usage.size > 0).then_some(usage)
    }
}

pub fn parse_usage(output: &str) -> Result<Value> {
    let report: Value = serde_json::from_str(output).context("fx usage returned invalid JSON")?;
    if report["kind"] != "usage"
        || report["schema_version"] != 2
        || !matches!(report["period"].as_str(), Some("today" | "7d" | "month"))
        || !report["source"].is_string()
        || !matches!(
            report["status"].as_str(),
            Some("ready" | "unavailable" | "fetching" | "failed")
        )
    {
        bail!("fx usage returned an incomplete report")
    }
    Ok(report)
}

/// A subscription's zero-filled totals do not represent dollar spending.
pub fn gateway_spend(report: &Value) -> Option<f64> {
    if report["source"] != "ai_gateway" || report["status"] != "ready" {
        return None;
    }
    report["totals"]["spend"]
        .as_f64()
        .filter(|spend| spend.is_finite() && *spend >= 0.)
}

pub async fn read(binary: &str, workspace: &Path) -> Result<Value> {
    let report = parse_usage(
        &super::preflight::run(binary, &["usage", "--period", "month", "--json"], workspace)
            .await?,
    )?;
    if report["period"] != "month" {
        bail!("fx usage returned the wrong period")
    }
    Ok(report)
}
