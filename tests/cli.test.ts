import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, projectPaths, saveConfig, type ProjectPaths } from "../src/config";
import { FakeTelegram } from "./fixtures/fake-telegram";

const temporary: string[] = [];
afterEach(async () => {
  delete process.env.TGFX_HOME;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type CliResult = { exitCode: number; stdout: string; stderr: string };

async function tgfx(args: string[], options: { cwd: string; env?: Record<string, string> } = { cwd: process.cwd() }): Promise<CliResult> {
  const isolated = await mkdtemp(join(tmpdir(), "tgfx-cli-home-"));
  temporary.push(isolated);
  const child = Bun.spawn([process.execPath, resolve("src/index.ts"), ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      TGFX_HOME: process.env.TGFX_HOME ?? join(isolated, "home"),
      TELEGRAM_BOT_TOKEN: "",
      ...options.env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function workspace(): Promise<ProjectPaths> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tgfx-cli-ws-")));
  temporary.push(root);
  process.env.TGFX_HOME = join(root, "tgfx-home");
  const paths = projectPaths(root);
  await saveConfig(paths, {
    version: 1,
    activeBotId: "100",
    access: { userIds: ["42"], chatIds: [] },
    approvals: { chatId: "42", topicId: "0" },
    output: "live", customIcons: true,
  });
  return paths;
}

describe("tgfx CLI", () => {
  test("a mistyped command errors instead of starting the bot", async () => {
    const root = await mkdtemp(join(tmpdir(), "tgfx-cli-typo-"));
    temporary.push(root);
    const result = await tgfx(["acess"], { cwd: root });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown command "acess"');
    expect(result.stderr).toContain("tgfx --help");
  });

  test("--help lists the command surface and exits cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "tgfx-cli-help-"));
    temporary.push(root);
    const result = await tgfx(["--help"], { cwd: root });
    expect(result.exitCode).toBe(0);
    for (const command of ["tgfx access", "tgfx allow", "tgfx deny", "tgfx approvals", "tgfx auth", "tgfx doctor"]) {
      expect(result.stderr).toContain(command);
    }
    expect(result.stderr).toContain("--yolo");
  });

  test("an uninitialized workspace produces a one-line hint, never a stack trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "tgfx-cli-uninit-"));
    temporary.push(root);
    const result = await tgfx(["access"], { cwd: root });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("isn't set up yet");
    expect(result.stderr).toContain("run tgfx once");
    expect(result.stderr).not.toContain("    at ");
  });

  test("unknown flags are rejected, not ignored", async () => {
    const paths = await workspace();
    const result = await tgfx(["access", "--jsn"], { cwd: paths.workspace });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unknown option '--jsn'");
  });

  test("allow infers users from positive and chats from negative IDs", async () => {
    const paths = await workspace();
    const result = await tgfx(["allow", "-1002255001", "7"], { cwd: paths.workspace });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("allowed chat -1002255001");
    expect(result.stderr).toContain("everyone in this chat");
    expect(result.stderr).toContain("allowed user 7");
    expect(result.stderr).toContain("restart tgfx to apply");
    const config = await loadConfig(paths);
    expect(config?.access.chatIds).toEqual(["-1002255001"]);
    expect(config?.access.userIds).toEqual(["42", "7"]);
  });

  test("allow --chat forces a positive ID onto the chat list", async () => {
    const paths = await workspace();
    const result = await tgfx(["allow", "555", "--chat"], { cwd: paths.workspace });
    expect(result.exitCode).toBe(0);
    const config = await loadConfig(paths);
    expect(config?.access.chatIds).toEqual(["555"]);
    expect(config?.access.userIds).toEqual(["42"]);
  });

  test("global flags are accepted on every command", async () => {
    const paths = await workspace();
    const result = await tgfx(["access", "--no-color", "--debug"], { cwd: paths.workspace });
    expect(result.exitCode).toBe(0);
  });

  test("allow canonicalizes IDs before storing them", async () => {
    const paths = await workspace();
    const result = await tgfx(["allow", "007"], { cwd: paths.workspace });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("allowed user 7");
    const config = await loadConfig(paths);
    expect(config?.access.userIds).toEqual(["42", "7"]);
  });

  test("allow without IDs outside a terminal explains instead of prompting", async () => {
    const paths = await workspace();
    const result = await tgfx(["allow"], { cwd: paths.workspace });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("at least one Telegram");
    expect(result.stderr).toContain("QR");
    expect((await loadConfig(paths))?.access.userIds).toEqual(["42"]);
  });

  test("--output accepts only a known mode", async () => {
    const paths = await workspace();
    const result = await tgfx(["--output", "loud"], { cwd: paths.workspace });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not an output mode");
    expect(result.stderr).toContain("progress");
  });

  test("an empty flag value is rejected", async () => {
    const paths = await workspace();
    const result = await tgfx(["--model="], { cwd: paths.workspace });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--model needs a value");
  });

  test("deny reports both grants when an id was allowed as user and chat", async () => {
    const paths = await workspace();
    await tgfx(["allow", "77"], { cwd: paths.workspace });
    await tgfx(["allow", "77", "--chat"], { cwd: paths.workspace });
    const result = await tgfx(["deny", "77"], { cwd: paths.workspace });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("removed user 77");
    expect(result.stderr).toContain("removed chat 77");
    const config = await loadConfig(paths);
    expect(config?.access.userIds).toEqual(["42"]);
    expect(config?.access.chatIds).toEqual([]);
  });

  test("deny removes principals but refuses to empty the allowlist", async () => {
    const paths = await workspace();
    await tgfx(["allow", "7"], { cwd: paths.workspace });
    const removed = await tgfx(["deny", "7"], { cwd: paths.workspace });
    expect(removed.exitCode).toBe(0);
    expect(removed.stderr).toContain("removed user 7");
    const refused = await tgfx(["deny", "42"], { cwd: paths.workspace });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("allowlist cannot be empty");
    const config = await loadConfig(paths);
    expect(config?.access.userIds).toEqual(["42"]);
  });

  test("access --json reports the whole trust model on stdout", async () => {
    const paths = await workspace();
    const result = await tgfx(["access", "--json"], { cwd: paths.workspace });
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.bot).toBe("100");
    expect(report.access).toEqual([{ id: "42", kind: "user" }]);
    expect(report.approvals).toEqual({ chatId: "42", topicId: "0" });
  });

  test("approvals shows the destination without needing a token", async () => {
    const paths = await workspace();
    const result = await tgfx(["approvals"], { cwd: paths.workspace });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("approvals → 42");
  });

  test("approvals validates and saves a chat/topic target", async () => {
    const paths = await workspace();
    const telegram = new FakeTelegram();
    try {
      const result = await tgfx(["approvals", "-100987/55"], {
        cwd: paths.workspace,
        env: {
          TELEGRAM_BOT_TOKEN: "100:cli-test-token",
          TGFX_INTERNAL_TELEGRAM_API_ROOT: telegram.url,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("approvals go to -100987/55");
      expect(telegram.calls("getChat")).toHaveLength(1);
    } finally {
      await telegram.stop();
    }
    const config = await loadConfig(paths);
    expect(config?.approvals).toEqual({ chatId: "-100987", topicId: "55" });
  });
});
