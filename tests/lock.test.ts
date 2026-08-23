import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config";
import { acquireRuntimeLock } from "../src/lock";

const temporary: string[] = [];
const originalState = process.env.TGFX_STATE_DIR;
afterEach(() => {
  if (originalState === undefined) delete process.env.TGFX_STATE_DIR;
  else process.env.TGFX_STATE_DIR = originalState;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("runtime lock", () => {
  test("allows one process per bot and releases cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "tgfx-lock-"));
    temporary.push(root);
    process.env.TGFX_STATE_DIR = join(root, "user-state");
    const first = await acquireRuntimeLock(workspacePaths(join(root, "workspace-a")), "100");
    await expect(acquireRuntimeLock(workspacePaths(join(root, "workspace-b")), "100"))
      .rejects.toThrow("already running");
    await first();
    await first();
    const second = await acquireRuntimeLock(workspacePaths(join(root, "workspace-b")), "100");
    await second();
  });
});
