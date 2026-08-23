import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeDownloadPath, safeName, writeResponseLimited } from "../src/mcp/files";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "tgfx-files-"));
  temporary.push(value);
  return value;
}

describe("Telegram attachment files", () => {
  test("sanitizes names and writes a bounded response without overwriting", async () => {
    const directory = await root();
    expect(safeName("../../hello world.txt")).toBe("hello_world.txt");
    const path = await safeDownloadPath(join(directory, "files"), "ctx_abc", "../answer.txt");
    expect(await writeResponseLimited(new Response("hello"), path, 10)).toBe(5);
    expect(await readFile(path, "utf8")).toBe("hello");
    await expect(writeResponseLimited(new Response("again"), path, 10)).rejects.toThrow();
  });

  test("removes a partial file when a streamed response crosses the size limit", async () => {
    const directory = await root();
    const path = await safeDownloadPath(join(directory, "files"), "ctx_abc", "large.bin");
    await expect(writeResponseLimited(new Response("123456"), path, 5)).rejects.toThrow("20 MB limit");
    await expect(readFile(path)).rejects.toThrow();
  });

  test("rejects a symlinked context directory", async () => {
    const directory = await root();
    const files = join(directory, "files");
    const outside = join(directory, "outside");
    await writeFile(outside, "not a directory");
    await symlink(outside, join(files, "ctx_escape")).catch(async () => {
      // The parent must exist on platforms that do not create it for symlink().
      const { mkdir } = await import("node:fs/promises");
      await mkdir(files, { recursive: true });
      await symlink(outside, join(files, "ctx_escape"));
    });
    await expect(safeDownloadPath(files, "ctx_escape", "file.txt")).rejects.toThrow();
  });
});
