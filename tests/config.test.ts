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
    streaming: true,
    expandStreamingTools: true,
    updateEveryMs: 250,
    customIcons: true,
  };
}

describe("workspace config", () => {
  test("round-trips without storing a bot token", async () => {
    const root = isolate("tgfx-config-");
    const paths = projectPaths(root);
    await saveConfig(paths, config());
    expect(await loadConfig(paths)).toEqual(config());
    expect(paths.config).toBe(join(root, ".fx", "telegram", "config.json"));
    expect(await Bun.file(paths.config).text()).not.toContain("token");
  });

  test("requires an allowlist and decimal Telegram IDs", () => {
    expect(() => configSchema.parse({ ...config(), access: { userIds: [], chatIds: [] } })).toThrow();
    expect(() => configSchema.parse({ ...config(), activeBotId: "@bot" })).toThrow();
  });

  test("validates the renderer update interval", () => {
    expect(configSchema.parse({ ...config(), updateEveryMs: 800 }).updateEveryMs).toBe(800);
    expect(() => configSchema.parse({ ...config(), updateEveryMs: 100 })).toThrow();
  });

  test("defaults omitted settings: streaming on, tools expanded, icons on", () => {
    const {
      streaming: _streaming, expandStreamingTools: _expand, customIcons: _icons, ...bare
    } = config();
    const parsed = configSchema.parse(bare);
    expect(parsed.streaming).toBeTrue();
    expect(parsed.expandStreamingTools).toBeTrue();
    expect(parsed.customIcons).toBeTrue();
    expect(configSchema.parse({ ...config(), customIcons: false }).customIcons).toBeFalse();
  });

  test("fills missing project settings from global defaults, but the project wins", async () => {
    const root = isolate("tgfx-defaults-");
    await saveGlobalConfig({
      version: 1,
      defaults: { streaming: false, customIcons: false, updateEveryMs: 500 },
    });
    const paths = projectPaths(root);
    const {
      streaming: _streaming, expandStreamingTools: _expand,
      updateEveryMs: _interval, customIcons: _icons, ...bare
    } = config();
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.config, JSON.stringify(bare));
    const inherited = await loadConfig(paths);
    expect(inherited?.streaming).toBeFalse();
    expect(inherited?.customIcons).toBeFalse();
    expect(inherited?.updateEveryMs).toBe(500);
    expect(inherited?.expandStreamingTools).toBeTrue();
    writeFileSync(paths.config, JSON.stringify({ ...bare, streaming: true }));
    expect((await loadConfig(paths))?.streaming).toBeTrue();
  });

  test("keeps inherited settings out of the project config on create and update", async () => {
    const root = isolate("tgfx-inherited-defaults-");
    const paths = projectPaths(root);
    await saveGlobalConfig({ version: 1, defaults: { streaming: false, customIcons: false } });
    await saveConfig(paths, config(), { preserveInheritedSettings: true });
    const created = JSON.parse(await Bun.file(paths.config).text());
    expect(created.streaming).toBeUndefined();
    expect(created.customIcons).toBeUndefined();
    const resolved = (await loadConfig(paths))!;
    expect(resolved.streaming).toBeFalse();
    resolved.access.userIds.push("43");
    await saveConfig(paths, resolved, { preserveInheritedSettings: true });
    await saveGlobalConfig({ version: 1, defaults: { streaming: true, customIcons: true } });
    expect((await loadConfig(paths))?.streaming).toBeTrue();
    expect((await loadConfig(paths))?.customIcons).toBeTrue();
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
