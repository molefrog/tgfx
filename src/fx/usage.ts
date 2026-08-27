import { redactSecrets } from "../secrets";

export const FX_USAGE_PERIODS = ["24h", "7d", "30d"] as const;
export type FxUsagePeriod = typeof FX_USAGE_PERIODS[number];

export type FxUsageTotals = {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  request_count: number;
  spend: number;
};

export type FxUsageReport = {
  kind: "usage";
  schema_version: number;
  period: FxUsagePeriod;
  totals: FxUsageTotals;
  models: Array<{ model: string; totals: FxUsageTotals }>;
};

export function isFxUsagePeriod(value: string): value is FxUsagePeriod {
  return FX_USAGE_PERIODS.includes(value as FxUsagePeriod);
}

function isTotals(value: unknown): value is FxUsageTotals {
  if (!value || typeof value !== "object") return false;
  const totals = value as Record<string, unknown>;
  return [
    "total_tokens", "input_tokens", "output_tokens", "cache_read_tokens",
    "cache_write_tokens", "reasoning_tokens", "request_count", "spend",
  ].every((field) => typeof totals[field] === "number" && Number.isFinite(totals[field]));
}

export function parseFxUsage(output: string): FxUsageReport {
  let value: unknown;
  try { value = JSON.parse(output); }
  catch (error) { throw new Error("fx usage returned invalid JSON.", { cause: error }); }
  if (!value || typeof value !== "object") throw new Error("fx usage returned an invalid report.");
  const report = value as Record<string, unknown>;
  if (report.kind !== "usage"
    || typeof report.schema_version !== "number"
    || typeof report.period !== "string"
    || !isFxUsagePeriod(report.period)
    || !isTotals(report.totals)
    || !Array.isArray(report.models)
    || !report.models.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const model = entry as Record<string, unknown>;
      return typeof model.model === "string" && isTotals(model.totals);
    })) {
    throw new Error("fx usage returned an incomplete report.");
  }
  return report as FxUsageReport;
}

export async function readFxUsage(
  binary: string,
  workspace: string,
  period: FxUsagePeriod,
): Promise<FxUsageReport> {
  const child = Bun.spawn([binary, "usage", "--period", period, "--json"], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  });
  const completed = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      child.kill();
      reject(new Error("fx usage did not finish within 15 seconds"));
    }, 15_000);
  });
  let result: Awaited<typeof completed>;
  try { result = await Promise.race([completed, timedOut]); }
  finally { if (timeout) clearTimeout(timeout); }
  const [stdout, stderr, exitCode] = result;
  if (exitCode !== 0) {
    throw new Error(redactSecrets((stderr || stdout).trim() || `fx usage exited with status ${exitCode}`));
  }
  return parseFxUsage(stdout);
}
