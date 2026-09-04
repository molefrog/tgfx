import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configSchema,
  loadConfig,
  projectPaths,
  pruneBotFiles,
  saveConfig,
  saveGlobalConfig,
} from "../src/config";
import type { TgfxConfig } from "../src/types";

const temporary: string[] = [];
const originalHome = process.env.TGFX_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.TGFX_HOME;
  else process.env.TGFX_HOME = originalHome;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function isolate(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(root);
  process.env.TGFX_HOME = join(root, "home");
  return root;
}

function config(): TgfxConfig {
  return {
    version: 1,
    activeBotId: "123456",
    access: { userIds: ["42"], chatIds: [] },
    approvals: { chatId: "42", topicId: "0" },
    output: "live",
    customIcons: true,
  };
}

/** The identity half of a config, as a project file stores it before any override. */
function bare(): Omit<TgfxConfig, "output" | "customIcons"> {
  const { output: _output, customIcons: _icons, ...rest } = config();
  return rest;
}

describe("workspace config", () => {
  test("lives under the tgfx home, named after the folder, and never stores a bot token", async () => {
    const root = isolate("tgfx-config-");
    const workspace = join(root, "my project");
    const paths = projectPaths(workspace);
    await saveConfig(paths, config());
    expect(await loadConfig(paths)).toEqual(config());
    expect(paths.config).toMatch(/\/home\/projects\/my-project-[0-9a-f]{12}\.json$/);
    expect(projectPaths(join(root, "other")).config).not.toBe(paths.config);
    const written = await Bun.file(paths.config).text();
    expect(written).toContain(`"workspace": ${JSON.stringify(workspace)}`);
    expect(written).not.toContain("token");
    expect(existsSync(join(workspace, ".fx"))).toBeFalse();
  });

  test("requires an allowlist and decimal Telegram IDs", () => {
    expect(() => configSchema.parse({ ...config(), access: { userIds: [], chatIds: [] } })).toThrow();
    expect(() => configSchema.parse({ ...config(), activeBotId: "@bot" })).toThrow();
  });

  test("accepts only a known output mode", () => {
    expect(configSchema.parse({ ...config(), output: "answer" }).output).toBe("answer");
    expect(() => configSchema.parse({ ...config(), output: "loud" })).toThrow();
  });

  test("defaults omitted settings: live output, icons on", () => {
    const parsed = configSchema.parse(bare());
    expect(parsed.output).toBe("live");
    expect(parsed.customIcons).toBeTrue();
    expect(configSchema.parse({ ...config(), customIcons: false }).customIcons).toBeFalse();
  });

  test("fills missing project settings from global defaults, but the project wins", async () => {
    const root = isolate("tgfx-defaults-");
    await saveGlobalConfig({ version: 1, defaults: { output: "report", customIcons: false } });
    const paths = projectPaths(root);
    mkdirSync(join(process.env.TGFX_HOME!, "projects"), { recursive: true });
    writeFileSync(paths.config, JSON.stringify(bare()));
    const inherited = await loadConfig(paths);
    expect(inherited?.output).toBe("report");
    expect(inherited?.customIcons).toBeFalse();
    writeFileSync(paths.config, JSON.stringify({ ...bare(), output: "answer" }));
    expect((await loadConfig(paths))?.output).toBe("answer");
  });

  test("keeps inherited settings out of the project file on create and update", async () => {
    const root = isolate("tgfx-inherited-defaults-");
    const paths = projectPaths(root);
    await saveGlobalConfig({ version: 1, defaults: { output: "report", customIcons: false } });
    await saveConfig(paths, config());
    const created = JSON.parse(await Bun.file(paths.config).text());
    expect(created.output).toBeUndefined();
    expect(created.customIcons).toBeUndefined();
    const resolved = (await loadConfig(paths))!;
    expect(resolved.output).toBe("report");
    resolved.access.userIds.push("43");
    await saveConfig(paths, resolved);
    await saveGlobalConfig({ version: 1, defaults: { output: "live", customIcons: true } });
    const updated = (await loadConfig(paths))!;
    expect(updated.access.userIds).toEqual(["42", "43"]);
    expect(updated.output).toBe("live");
    expect(updated.customIcons).toBeTrue();
  });

  test("makes a setting the project's own when asked, leaving the rest inherited", async () => {
    const root = isolate("tgfx-take-over-");
    const paths = projectPaths(root);
    await saveGlobalConfig({ version: 1, defaults: { output: "report", customIcons: false } });
    await saveConfig(paths, config(), { output: "progress" });
    const stored = JSON.parse(await Bun.file(paths.config).text());
    expect(stored.output).toBe("progress");
    expect(stored.customIcons).toBeUndefined();
    await saveGlobalConfig({ version: 1, defaults: { output: "answer", customIcons: true } });
    const loaded = (await loadConfig(paths))!;
    expect(loaded.output).toBe("progress");
    expect(loaded.customIcons).toBeTrue();
  });

  test("keeps a project's own override across saves", async () => {
    const root = isolate("tgfx-override-");
    const paths = projectPaths(root);
    mkdirSync(join(process.env.TGFX_HOME!, "projects"), { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ ...bare(), output: "progress" }));
    const loaded = (await loadConfig(paths))!;
    loaded.approvals = { chatId: "-100", topicId: "0" };
    await saveConfig(paths, loaded);
    const stored = JSON.parse(await Bun.file(paths.config).text());
    expect(stored.output).toBe("progress");
    expect(stored.customIcons).toBeUndefined();
    expect((await loadConfig(paths))?.approvals.chatId).toBe("-100");
  });

  test("merges overlapping setting saves without losing either override", async () => {
    const paths = projectPaths(isolate("tgfx-concurrent-settings-"));
    const initial = config();
    await saveConfig(paths, initial);
    await Promise.all([
      saveConfig(paths, { ...initial, output: "answer" }, { output: "answer" }),
      saveConfig(paths, { ...initial, customIcons: false }, { customIcons: false }),
    ]);
    const saved = (await loadConfig(paths))!;
    expect(saved.output).toBe("answer");
    expect(saved.customIcons).toBeFalse();
  });

  test("a failed save does not block a later save", async () => {
    const paths = projectPaths(isolate("tgfx-retry-settings-"));
    mkdirSync(paths.config, { recursive: true });
    await expect(saveConfig(paths, config())).rejects.toThrow();
    rmSync(paths.config, { recursive: true });
    await saveConfig(paths, config(), { output: "answer" });
    expect((await loadConfig(paths))?.output).toBe("answer");
  });

  test("prunes only expired entries inside the bot files directory", async () => {
    const root = isolate("tgfx-files-");
    const files = join(root, "files");
    const old = join(files, "old-context");
    const fresh = join(files, "fresh-context");
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(old, "file.txt"), "old");
    writeFileSync(join(fresh, "file.txt"), "fresh");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(old, oldTime, oldTime);
    await pruneBotFiles(files, 5_000);
    expect(existsSync(old)).toBeFalse();
    expect(existsSync(fresh)).toBeTrue();
  });
});
