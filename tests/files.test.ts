import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSendableFile, safeDownloadPath, safeName, writeResponseLimited } from "../src/mcp/files";

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

  test("shares downloads for group reading without granting write access", async () => {
    const previous = process.env.TGFX_SHARED_FILES;
    const previousMask = process.umask(0o077);
    process.env.TGFX_SHARED_FILES = "1";
    try {
      const directory = await root();
      const files = join(directory, "files");
      const path = await safeDownloadPath(files, "ctx_shared", "readable.txt");
      await writeResponseLimited(new Response("hello"), path, 10);
      expect((await stat(files)).mode & 0o7777).toBe(0o2750);
      expect((await stat(join(files, "ctx_shared"))).mode & 0o7777).toBe(0o2750);
      expect((await stat(path)).mode & 0o777).toBe(0o640);
    } finally {
      process.umask(previousMask);
      if (previous === undefined) delete process.env.TGFX_SHARED_FILES;
      else process.env.TGFX_SHARED_FILES = previous;
    }
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

async function uploadRoots() {
  const directory = await root();
  const roots = { workspace: join(directory, "work"), home: join(directory, "private"), files: join(directory, "downloads") };
  await Promise.all(Object.values(roots).map((path) => mkdir(path)));
  for (const key of ["workspace", "home", "files"] as const) roots[key] = await realpath(roots[key]);
  return { directory, roots };
}

test("reads bounded upload bytes from workspace and downloads", async () => {
  const { roots } = await uploadRoots();
  await writeFile(join(roots.workspace, "answer.txt"), "hello");
  await writeFile(join(roots.files, "photo.bin"), "data");
  expect(new TextDecoder().decode((await readSendableFile("answer.txt", roots, 5)).bytes)).toBe("hello");
  expect((await readSendableFile(join(roots.files, "photo.bin"), roots, 5)).bytes.length).toBe(4);
  await expect(readSendableFile("answer.txt", roots, 4)).rejects.toThrow("limit");
});

test("upload aliases cannot expose private state or files outside the workspace", async () => {
  const { directory, roots } = await uploadRoots();
  for (const [name, target] of [["token", join(roots.home, "token")], ["outside", join(directory, "outside")]] as const) {
    await writeFile(target, "private");
    await symlink(target, join(roots.workspace, name));
    await expect(readSendableFile(name, roots, 100)).rejects.toThrow();
  }
  await mkdir(join(roots.workspace, ".fx", "telegram"), { recursive: true });
  await writeFile(join(roots.workspace, ".fx", "telegram", "state"), "private");
  await expect(readSendableFile(".fx/telegram/state", roots, 100)).rejects.toThrow("Private");
});
