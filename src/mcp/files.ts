import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

export function safeName(value: string): string {
  return basename(value).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 160) || "attachment";
}

export async function safeDownloadPath(root: string, contextRef: string, filename: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(contextRef)) throw new Error("Invalid attachment context reference.");
  const expectedRoot = resolve(root);
  const mode = process.env.TGFX_SHARED_FILES === "1" ? 0o2750 : 0o700;
  await mkdir(expectedRoot, { recursive: true, mode });
  if ((await lstat(expectedRoot)).isSymbolicLink()) {
    throw new Error("The tgfx attachment directory must not be a symbolic link.");
  }
  await chmod(expectedRoot, mode);
  const actualRoot = await realpath(expectedRoot);
  const expectedDirectory = join(expectedRoot, contextRef);
  await mkdir(expectedDirectory, { recursive: true, mode });
  if ((await lstat(expectedDirectory)).isSymbolicLink()) {
    throw new Error("The attachment context directory must not be a symbolic link.");
  }
  await chmod(expectedDirectory, mode);
  const actualDirectory = await realpath(expectedDirectory);
  if (actualDirectory !== join(actualRoot, contextRef) || !actualDirectory.startsWith(`${actualRoot}${sep}`)) {
    throw new Error("The attachment context directory escaped the tgfx files directory.");
  }
  return join(actualDirectory, safeName(filename));
}

export async function writeResponseLimited(response: Response, path: string, maxBytes: number): Promise<number> {
  if (!response.ok) throw new Error(`Telegram attachment download failed (${response.status}).`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("Downloaded attachment exceeded the 20 MB limit.");
  }
  if (!response.body) throw new Error("Telegram returned an empty attachment response.");
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    process.env.TGFX_SHARED_FILES === "1" ? 0o640 : 0o600,
  );
  let total = 0;
  let complete = false;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel("attachment size limit exceeded");
        throw new Error("Downloaded attachment exceeded the 20 MB limit.");
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const written = await handle.write(value, offset, value.byteLength - offset);
        offset += written.bytesWritten;
      }
      total += value.byteLength;
    }
    complete = true;
    return total;
  } finally {
    await handle.close();
    if (!complete) await unlink(path).catch(() => undefined);
  }
}

/** Validate the opened inode, not a path the agent can swap before upload. */
export async function readSendableFile(
  raw: string, roots: { workspace: string; files: string; home: string }, maxBytes: number,
): Promise<{ path: string; bytes: Uint8Array }> {
  const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);
  const validate = (path: string) => {
    if (inside(path, roots.files)) return;
    if (inside(path, roots.home) || inside(path, resolve(roots.workspace, ".fx", "telegram"))) {
      throw new Error("Private tgfx runtime files cannot be sent.");
    }
    if (!inside(path, roots.workspace)) {
      throw new Error("Only files inside the current workspace or its Telegram downloads may be sent.");
    }
  };
  const path = await realpath(resolve(roots.workspace, raw));
  validate(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Only a regular workspace file may be sent.");
    // Linux is the supported separate-user runtime. /proc resolves the file
    // descriptor even if a writable ancestor was replaced after realpath().
    if (process.platform === "linux") validate(await realpath(`/proc/self/fd/${handle.fd}`));
    else {
      validate(await realpath(path));
      const current = await stat(path);
      if (current.dev !== info.dev || current.ino !== info.ino) throw new Error("The upload file changed while opening.");
    }
    if (info.size > maxBytes) throw new Error("This file exceeds Telegram's upload limit.");
    const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > info.size) throw new Error("The upload file grew while reading.");
    return { path, bytes: bytes.subarray(0, length) };
  } finally { await handle.close(); }
}
