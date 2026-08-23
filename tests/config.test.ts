import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, loadConfig, pruneWorkspaceFiles, saveConfig, workspacePaths } from "../src/config";
import { redactSecrets } from "../src/secrets";
import type { TgfxConfig } from "../src/types";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function config(): TgfxConfig {
  return {
    version: 1,
    activeBotId: "123456",
    access: { userIds: ["42"], chatIds: [] },
    controlChat: { chatId: "42", topicId: "0" },
    renderer: { mode: "streaming", collapseTools: true, updateEveryMs: 800 },
    admin: { chatIds: [], capabilities: [] },
  };
}

describe("workspace config", () => {
  test("round-trips without storing a bot token", async () => {
    const root = mkdtempSync(join(tmpdir(), "tgfx-config-"));
    temporary.push(root);
    const paths = workspacePaths(root);
    await saveConfig(paths, config());
    expect(await loadConfig(paths)).toEqual(config());
    expect(await Bun.file(paths.config).text()).not.toContain("token");
  });

  test("requires an allowlist and decimal Telegram IDs", () => {
    expect(() => configSchema.parse({ ...config(), access: { userIds: [], chatIds: [] } })).toThrow();
    expect(() => configSchema.parse({ ...config(), activeBotId: "@bot" })).toThrow();
  });

  test("redacts tokens both standalone and inside Bot API file URLs", () => {
    const token = `123456789:${"A".repeat(30)}`;
    expect(redactSecrets(`token=${token}`)).toBe("token=[redacted Telegram token]");
    expect(redactSecrets(`https://api.telegram.org/file/bot${token}/photo.jpg`))
      .toBe("https://api.telegram.org/file/bot[redacted Telegram token]/photo.jpg");
  });

  test("prunes only expired files inside the workspace runtime directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "tgfx-files-"));
    temporary.push(root);
    const paths = workspacePaths(root);
    const old = join(paths.files, "old-context");
    const fresh = join(paths.files, "fresh-context");
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(old, "file.txt"), "old");
    writeFileSync(join(fresh, "file.txt"), "fresh");
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(old, oldTime, oldTime);
    await pruneWorkspaceFiles(paths, 5_000);
    expect(existsSync(old)).toBeFalse();
    expect(existsSync(fresh)).toBeTrue();
  });
});
