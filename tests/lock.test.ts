import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireRuntimeLock } from "../src/lock";

const temporary: string[] = [];
const originalHome = process.env.TGFX_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.TGFX_HOME;
  else process.env.TGFX_HOME = originalHome;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function isolatedHome(): string {
  const root = mkdtempSync(join(tmpdir(), "tgfx-lock-"));
  temporary.push(root);
  process.env.TGFX_HOME = join(root, "home");
  return root;
}

describe("runtime lock", () => {
  test("allows one process per bot and releases cleanly", async () => {
    const root = isolatedHome();
    const first = await acquireRuntimeLock("100", join(root, "workspace-a"));
    await expect(acquireRuntimeLock("100", join(root, "workspace-b")))
      .rejects.toThrow("already running");
    await first();
    await first();
    const second = await acquireRuntimeLock("100", join(root, "workspace-b"));
    await second();
  });

  test("names the current holder when refusing a second process", async () => {
    const root = isolatedHome();
    const release = await acquireRuntimeLock("100", join(root, "workspace-a"));
    try {
      await expect(acquireRuntimeLock("100", join(root, "workspace-b")))
        .rejects.toMatchObject({ hint: expect.stringContaining("workspace-a") });
    } finally {
      await release();
    }
  });

  test("locks bots independently", async () => {
    const root = isolatedHome();
    const first = await acquireRuntimeLock("100", join(root, "workspace-a"));
    const second = await acquireRuntimeLock("200", join(root, "workspace-a"));
    await first();
    await second();
  });

  test("the kernel releases a killed holder's lock without cleanup heuristics", async () => {
    const root = isolatedHome();
    const holder = join(root, "holder.ts");
    writeFileSync(holder, [
      `import { acquireRuntimeLock } from ${JSON.stringify(resolve("src/lock.ts"))};`,
      'await acquireRuntimeLock("100", "/holder-workspace");',
      'console.log("locked");',
      "await Bun.sleep(60_000);",
    ].join("\n"));
    const child = Bun.spawn([process.execPath, holder], {
      env: { ...process.env, TGFX_HOME: process.env.TGFX_HOME! },
      stdout: "pipe",
      stderr: "inherit",
    });
    try {
      const reader = child.stdout.getReader();
      let output = "";
      while (!output.includes("locked")) {
        const next = await reader.read();
        if (next.done) throw new Error("holder exited before locking");
        output += new TextDecoder().decode(next.value);
      }
      await expect(acquireRuntimeLock("100", join(root, "workspace-b")))
        .rejects.toThrow("already running");
      child.kill("SIGKILL");
      await child.exited;
      const reclaimed = await acquireRuntimeLock("100", join(root, "workspace-b"));
      await reclaimed();
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });
});
