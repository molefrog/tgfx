import { redactSecrets } from "../secrets";

export type FxDoctorReport = {
  fail_count: number;
  warn_count: number;
  model: string;
  auth: string;
  workspace: string;
  checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string }>;
};

export function parseFxDoctor(output: string): FxDoctorReport {
  let value: unknown;
  try { value = JSON.parse(output); }
  catch (error) { throw new Error("fx doctor returned invalid JSON.", { cause: error }); }
  if (!value || typeof value !== "object") throw new Error("fx doctor returned an invalid report.");
  const report = value as Partial<FxDoctorReport>;
  if (typeof report.fail_count !== "number"
    || typeof report.warn_count !== "number"
    || typeof report.model !== "string"
    || typeof report.auth !== "string"
    || typeof report.workspace !== "string"
    || !Array.isArray(report.checks)) {
    throw new Error("fx doctor returned an incomplete report.");
  }
  return report as FxDoctorReport;
}

async function run(binary: string, args: string[], workspace: string): Promise<string> {
  const process = Bun.spawn([binary, ...args], {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  });
  const completed = Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  const [stdout, stderr, exitCode] = await Promise.race([
    completed,
    Bun.sleep(15_000).then(() => {
      process.kill();
      throw new Error(`fx ${args.join(" ")} did not finish within 15 seconds`);
    }),
  ]);
  if (exitCode !== 0) {
    throw new Error(redactSecrets((stderr || stdout).trim() || `fx exited with status ${exitCode}`));
  }
  return stdout.trim();
}

export async function inspectFx(binary: string, workspace: string): Promise<{
  version: string; report: FxDoctorReport;
}> {
  const [version, doctor] = await Promise.all([
    run(binary, ["--version"], workspace),
    run(binary, ["doctor", "--json"], workspace),
  ]);
  const report = parseFxDoctor(doctor);
  if (report.fail_count > 0) {
    const failures = report.checks
      .filter((check) => check.status === "fail")
      .map((check) => `${check.name}: ${check.detail}`)
      .join("; ");
    throw new Error(`fx is not ready${failures ? ` · ${failures}` : ""}`);
  }
  return { version, report };
}
