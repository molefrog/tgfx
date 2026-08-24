import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runCli(command: "routes" | "admin", initialized = false) {
  const workspace = await mkdtemp(join(tmpdir(), "tgfx-cli-"));
  temporary.push(workspace);
  const fxLog = join(workspace, "fx-called");
  const fxBinary = join(workspace, "fx");
  await writeFile(fxBinary, `#!/bin/sh\necho called >> ${JSON.stringify(fxLog)}\nexit 1\n`);
  await chmod(fxBinary, 0o700);

  if (initialized) {
    await mkdir(join(workspace, ".tgfx"));
    await writeFile(join(workspace, ".tgfx", "config.json"), JSON.stringify({
      version: 1,
      activeBotId: "100",
      access: { userIds: ["42"], chatIds: [] },
      controlChat: { chatId: "42", topicId: "0" },
      renderer: { mode: "streaming", collapseTools: true, updateEveryMs: 800 },
      admin: { chatIds: [], capabilities: [] },
    }));
  }

  const child = Bun.spawn([process.execPath, resolve("src/index.ts"), command], {
    cwd: workspace,
    env: {
      ...process.env,
      FX_BINARY: fxBinary,
      TGFX_CONFIG_DIR: join(workspace, "user-config"),
      TGFX_STATE_DIR: join(workspace, "user-state"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let fxCalled = false;
  try { fxCalled = (await readFile(fxLog, "utf8")).includes("called"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { exitCode, stdout, stderr, fxCalled };
}

describe("tgfx CLI dispatch", () => {
  test("routes prints and exits without starting tgfx", async () => {
    const result = await runCli("routes");
    expect(result).toMatchObject({ exitCode: 0, stdout: "No routes yet.\n", stderr: "", fxCalled: false });
  });

  test("admin prints and exits without starting tgfx", async () => {
    const result = await runCli("admin", true);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ chatIds: [], capabilities: [] });
    expect(result.fxCalled).toBe(false);
  });
});
