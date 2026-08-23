import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

export function safeName(value: string): string {
  return basename(value).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 160) || "attachment";
}

export async function safeDownloadPath(root: string, contextRef: string, filename: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(contextRef)) throw new Error("Invalid attachment context reference.");
  const expectedRoot = resolve(root);
  await mkdir(expectedRoot, { recursive: true, mode: 0o700 });
  await chmod(expectedRoot, 0o700);
  if ((await lstat(expectedRoot)).isSymbolicLink()) {
    throw new Error("The tgfx attachment directory must not be a symbolic link.");
  }
  const actualRoot = await realpath(expectedRoot);
  const expectedDirectory = join(expectedRoot, contextRef);
  await mkdir(expectedDirectory, { recursive: true, mode: 0o700 });
  await chmod(expectedDirectory, 0o700);
  if ((await lstat(expectedDirectory)).isSymbolicLink()) {
    throw new Error("The attachment context directory must not be a symbolic link.");
  }
  const actualDirectory = await realpath(expectedDirectory);
  if (actualDirectory !== join(actualRoot, contextRef) || !actualDirectory.startsWith(`${actualRoot}${sep}`)) {
    throw new Error("The attachment context directory escaped .tgfx/files.");
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
    0o600,
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
