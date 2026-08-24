import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userStateDirectory, type WorkspacePaths } from "./config";

type LockRecord = {
  pid: number;
  botId: string;
  workspace: string;
  startedAt: string;
  lockId: string;
};

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireFile(path: string, record: LockRecord): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        let current: LockRecord | undefined;
        try { current = JSON.parse(await readFile(path, "utf8")); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (!current || current.lockId !== record.lockId) return;
        await unlink(path).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let current: LockRecord | undefined;
      try { current = JSON.parse(await readFile(path, "utf8")); } catch { /* stale */ }
      if (current && processExists(current.pid)) {
        throw new Error(
          `tgfx is already running for bot ${record.botId} (pid ${current.pid}, workspace ${current.workspace})`,
        );
      }
      await unlink(path).catch(() => undefined);
    }
  }
  throw new Error(`Unable to acquire ${path}`);
}

export async function acquireRuntimeLock(paths: WorkspacePaths, botId: string): Promise<() => Promise<void>> {
  const record: LockRecord = {
    pid: process.pid,
    botId,
    workspace: paths.workspace,
    startedAt: new Date().toISOString(),
    lockId: crypto.randomUUID(),
  };
  const releaseBot = await acquireFile(join(userStateDirectory(), "locks", `${botId}.lock`), record);
  try {
    const releaseWorkspace = await acquireFile(join(paths.directory, "runtime.lock"), record);
    return async () => {
      await releaseWorkspace();
      await releaseBot();
    };
  } catch (error) {
    await releaseBot();
    throw error;
  }
}
