import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  botPaths,
  configSchema,
  loadConfig,
  loadGlobalConfig,
  migrateLegacyWorkspace,
  projectPaths,
  pruneBotFiles,
  saveConfig,
  saveGlobalConfig,
} from "../src/config";
import { StateStore } from "../src/state";
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
    renderer: { mode: "streaming", expandStreamingTools: true, updateEveryMs: 250 },
    modelPicker: { customIcons: true },
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

  test("migrates the old fixed-loop interval to the optimistic adaptive default", () => {
    expect(configSchema.parse({
      ...config(),
      renderer: { ...config().renderer, updateEveryMs: 800 },
    }).renderer.updateEveryMs).toBe(250);
    expect(configSchema.parse({
      ...config(),
      renderer: { ...config().renderer, updateEveryMs: 1_000 },
    }).renderer.updateEveryMs).toBe(1_000);
  });

  test("keeps streaming tool groups expanded by default", () => {
    const renderer = configSchema.parse({
      ...config(),
      renderer: { mode: "streaming", updateEveryMs: 250 },
    }).renderer;
    expect(renderer.expandStreamingTools).toBeTrue();
  });

  test("enables model picker icons by default and allows disabling them", () => {
    const { modelPicker: _modelPicker, ...legacy } = config();
    expect(configSchema.parse(legacy).modelPicker.customIcons).toBeTrue();
    expect(configSchema.parse({
      ...config(),
      modelPicker: { customIcons: false },
    }).modelPicker.customIcons).toBeFalse();
  });

  test("fills missing project sections from global defaults, but the project wins", async () => {
    const root = isolate("tgfx-defaults-");
    await saveGlobalConfig({
      version: 1,
      defaults: {
        renderer: { mode: "final", expandStreamingTools: false, updateEveryMs: 500 },
        modelPicker: { customIcons: false },
      },
      bots: [],
    });
    const paths = projectPaths(root);
    const { renderer: _renderer, modelPicker: _modelPicker, ...bare } = config();
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.config, JSON.stringify(bare));
    const inherited = await loadConfig(paths);
    expect(inherited?.renderer.mode).toBe("final");
    expect(inherited?.modelPicker?.customIcons).toBeFalse();
    writeFileSync(paths.config, JSON.stringify({ ...bare, renderer: { mode: "streaming" } }));
    expect((await loadConfig(paths))?.renderer.mode).toBe("streaming");
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

  test("moves a legacy .tgfx workspace into the shared home layout once", async () => {
    const root = isolate("tgfx-migrate-");
    const legacy = join(root, ".tgfx");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "config.json"), JSON.stringify(config()));
    const legacyState = new StateStore(join(legacy, "state.sqlite"));
    legacyState.ensurePollState("123456");
    legacyState.advanceCursor("123456", 9);
    legacyState.close();

    const paths = projectPaths(root);
    expect(await migrateLegacyWorkspace(paths)).toContain("123456");
    expect(await loadConfig(paths)).toEqual(config());
    expect(existsSync(legacy)).toBeFalse();
    const migrated = new StateStore(botPaths("123456").database);
    try {
      expect(migrated.nextOffset("123456")).toBe(9);
    } finally { migrated.close(); }
    expect((await loadGlobalConfig()).bots).toEqual([{ botId: "123456", workspace: root }]);
    expect(await migrateLegacyWorkspace(paths)).toBeUndefined();
  });
});
