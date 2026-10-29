use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::path::Path;
pub const PERIODS: [&str; 3] = ["24h", "7d", "30d"];
fn totals(v: &Value) -> bool {
    [
        "total_tokens",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "reasoning_tokens",
        "request_count",
        "spend",
    ]
    .iter()
    .all(|k| v[*k].as_f64().is_some_and(f64::is_finite))
}
pub fn parse_usage(output: &str) -> Result<Value> {
    let v: Value = serde_json::from_str(output).context("fx usage returned invalid JSON")?;
    if v["kind"] != "usage"
        || !v["schema_version"].is_number()
        || !v["period"].as_str().is_some_and(|p| PERIODS.contains(&p))
        || !totals(&v["totals"])
        || !v["models"].as_array().is_some_and(|a| {
            a.iter()
                .all(|x| x["model"].is_string() && totals(&x["totals"]))
        })
    {
        bail!("fx usage returned an incomplete report.")
    };
    Ok(v)
}
pub async fn read_usage(binary: &str, cwd: &Path, period: &str) -> Result<Value> {
    if !PERIODS.contains(&period) {
        bail!("Usage period must be 24h, 7d, or 30d")
    };
    parse_usage(
        &super::preflight::run(binary, &["usage", "--period", period, "--json"], cwd).await?,
    )
}

pub async fn read(binary: &str, workspace: &Path, period: &str) -> Result<Value> {
    read_usage(binary, workspace, period).await
}
