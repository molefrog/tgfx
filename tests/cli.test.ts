import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { botPaths, loadConfig, projectPaths, saveConfig, type ProjectPaths } from "../src/config";
import { StateStore } from "../src/state";
import { acquireRuntimeLock } from "../src/lock";
import { FakeTelegram } from "./fixtures/fake-telegram";
import { replyPolicy } from "../src/telegram/reply-policy";

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
  test("history can report and clear one chat while preserving another", async () => {
    const paths = await workspace();
    const state = new StateStore(botPaths("100").database, paths.workspace);
    state.history.recordBot("100:-9:0", "1", "group decision");
    state.history.recordBot("100:42:0", "1", "DM decision");
    state.close();
    const before = await tgfx(["history", "--json"], { cwd: paths.workspace });
    expect(JSON.parse(before.stdout)).toHaveLength(2);
    const cleared = await tgfx(["history", "clear", "--chat", "-9"], { cwd: paths.workspace });
    expect(cleared.exitCode).toBe(0);
    const after = await tgfx(["history", "--json"], { cwd: paths.workspace });
    expect(JSON.parse(after.stdout).map((s: { route: string }) => s.route)).toEqual(["100:42:0"]);
  });

  test("allow saves reply defaults without granting access or pairing", async () => {
    const paths = await workspace();
    const before = (await loadConfig(paths))!.access;
    const result = await tgfx(["allow", "--dm", "mention", "--groups", "all"], { cwd: paths.workspace });
    expect(result.exitCode).toBe(0);
    const config = (await loadConfig(paths))!;
    expect(config).toMatchObject({ access: before, dmReply: "mention", groupReply: "all" });
  });

  test("allow updates an existing group's reply policy without duplicating the grant", async () => {
    const paths = await workspace();
    await tgfx(["allow", "-9", "--reply", "mention"], { cwd: paths.workspace });
    const updated = await tgfx(["allow", "-9", "--reply", "all"], { cwd: paths.workspace });
    expect(updated.exitCode).toBe(0);
    expect(await loadConfig(paths)).toMatchObject({ access: { chatIds: ["-9"] }, chatReplies: { "-9": "all" } });
  });

  test("allow inherit resumes the group default and preserves other overrides", async () => {
    const paths = await workspace();
    await tgfx(["allow", "-9", "-10", "--reply", "all"], { cwd: paths.workspace });
    const inherited = await tgfx(["allow", "-9", "--inherit"], { cwd: paths.workspace });
    expect(inherited.exitCode).toBe(0);
    const config = (await loadConfig(paths))!;
    expect(config.chatReplies).toEqual({ "-10": "all" });
    expect(replyPolicy(config, { chatId: "-9", chatKind: "group" })).toBe("mention");
  });

  test("allow preserves an existing reply policy when no policy flag is given", async () => {
    const paths = await workspace();
    await tgfx(["allow", "-9", "--reply", "all"], { cwd: paths.workspace });
    await tgfx(["allow", "-9"], { cwd: paths.workspace });
    expect((await loadConfig(paths))?.chatReplies?.["-9"]).toBe("all");
  });

  test.each([
    ["allow", "--groups", "all", "-9"],
    ["allow", "-9", "--reply", "direct"],
    ["allow", "-9", "--inherit"],
    ["allow", "42", "--reply", "mention", "--inherit"],
  ].map((args) => ({ args })))("invalid policy arguments leave access unchanged: %j", async ({ args }) => {
    const paths = await workspace();
    const before = await Bun.file(paths.config).text();
    expect((await tgfx(args, { cwd: paths.workspace })).exitCode).toBe(1);
    expect(await Bun.file(paths.config).text()).toBe(before);
  });

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

  test("an already running bot reports its holder once without a goodbye or polling", async () => {
    const paths = await workspace();
    const binary = join(paths.workspace, "fx");
    await Bun.write(binary, [
      `#!${process.execPath}`,
      'if (process.argv[2] === "--version") console.log("0.0.8");',
      'else if (process.argv[2] === "doctor" && process.argv[3] === "--json") {',
      '  console.log(JSON.stringify({ fail_count: 0, warn_count: 0, model: "test", auth: "ready", workspace: process.cwd(), checks: [] }));',
      '} else process.exit(1);',
      "",
    ].join("\n"));
    await chmod(binary, 0o755);
    const release = await acquireRuntimeLock("100", paths.workspace);
    const telegram = new FakeTelegram();
    try {
      const result = await tgfx([], {
        cwd: paths.workspace,
        env: {
          FX_BINARY: binary,
          TELEGRAM_BOT_TOKEN: "100:cli-test-token",
          TGFX_INTERNAL_TELEGRAM_API_ROOT: telegram.url,
        },
      });
      const output = result.stdout + result.stderr;
      expect(result.exitCode).toBe(1);
      expect(output.match(/already running/g)).toHaveLength(1);
      expect(result.stderr).toContain(String(process.pid));
      expect(result.stderr).toContain(paths.workspace);
      expect(output).not.toContain("bye!");
      expect(telegram.calls("getUpdates")).toHaveLength(0);
    } finally {
      await release();
      await telegram.stop();
    }
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
