import { Database } from "bun:sqlite";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CliError } from "./cli/ui";
import { botPaths } from "./config";

type LockInfo = {
  pid: number;
  botId: string;
  workspace: string;
  startedAt: string;
};

function busy(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || /database is locked/i.test(message);
}

async function holderHint(path: string): Promise<string> {
  try {
    const info = JSON.parse(await readFile(path, "utf8")) as LockInfo;
    return `pid ${info.pid} · ${info.workspace}`;
  } catch {
    return "";
  }
}

/**
 * One tgfx process per bot, machine-wide. The lock is a dedicated SQLite file
 * held in exclusive locking mode: the kernel drops the underlying advisory
 * lock the instant the process dies, so a crash can never leave a stale lock
 * and no pid-liveness heuristics are needed. The state database itself stays
 * unlocked because the per-route MCP servers are separate processes sharing it.
 */
export async function acquireRuntimeLock(botId: string, workspace: string): Promise<() => Promise<void>> {
  const paths = botPaths(botId);
  await mkdir(dirname(paths.lock), { recursive: true, mode: 0o700 });
  await chmod(dirname(paths.lock), 0o700);
  const db = new Database(paths.lock, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    // An INSERT always writes, so this both takes and keeps the exclusive lock;
    // a no-op statement could skip the write and leave the file unlocked.
    db.exec("CREATE TABLE IF NOT EXISTS holder (id INTEGER PRIMARY KEY, pid INTEGER)");
    db.exec(`INSERT OR REPLACE INTO holder (id, pid) VALUES (1, ${process.pid})`);
  } catch (error) {
    db.close();
    if (!busy(error)) throw error;
    throw new CliError(`tgfx is already running for bot ${botId}`, await holderHint(paths.lockInfo));
  }
  await chmod(paths.lock, 0o600).catch(() => undefined);
  const info: LockInfo = { pid: process.pid, botId, workspace, startedAt: new Date().toISOString() };
  // Diagnostics only: the locked database is unreadable to the loser, so the
  // "already running" message reads this sidecar instead.
  await writeFile(paths.lockInfo, `${JSON.stringify(info)}\n`, { mode: 0o600 }).catch(() => undefined);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    db.close();
    await unlink(paths.lockInfo).catch(() => undefined);
  };
}
