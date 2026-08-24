import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { TgfxConfig } from "./types";

const decimalId = z.string().regex(/^-?\d+$/, "must be a decimal Telegram ID");
const rendererSchema = z.object({
  mode: z.enum(["streaming", "final"]).default("streaming"),
  collapseTools: z.boolean().default(true),
  updateEveryMs: z.number().int().min(500).max(10_000).default(800),
});

const strictSchema = z.object({
  version: z.literal(1),
  activeBotId: decimalId,
  access: z.object({
    userIds: z.array(decimalId).default([]),
    chatIds: z.array(decimalId).default([]),
  }).refine((value) => value.userIds.length + value.chatIds.length > 0, {
    message: "at least one allowed user or chat is required",
  }),
  approvals: z.object({ chatId: decimalId, topicId: decimalId.default("0") }),
  renderer: rendererSchema.default({
    mode: "streaming",
    collapseTools: true,
    updateEveryMs: 800,
  }),
}) satisfies z.ZodType<TgfxConfig>;

// Configs written before the approvals rename carry `controlChat` (and possibly
// a static `admin` profile, which is now derived live from Telegram rights).
// They migrate in memory here and adopt the current shape on their next save.
export const configSchema = z.preprocess((raw) => {
  if (raw && typeof raw === "object" && !("approvals" in raw) && "controlChat" in raw) {
    const { controlChat, admin: _legacyAdmin, ...rest } = raw as Record<string, unknown>;
    return { ...rest, approvals: controlChat };
  }
  return raw;
}, strictSchema);

export type WorkspacePaths = {
  workspace: string;
  directory: string;
  config: string;
  database: string;
  files: string;
};

export function workspacePaths(workspace = process.cwd()): WorkspacePaths {
  const canonical = resolve(workspace);
  const directory = join(canonical, ".tgfx");
  return {
    workspace: canonical,
    directory,
    config: join(directory, "config.json"),
    database: join(directory, "state.sqlite"),
    files: join(directory, "files"),
  };
}

export function userStateDirectory(): string {
  return process.env.TGFX_STATE_DIR
    ? resolve(process.env.TGFX_STATE_DIR)
    : join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "tgfx");
}

function userConfigDirectory(): string {
  return process.env.TGFX_CONFIG_DIR
    ? resolve(process.env.TGFX_CONFIG_DIR)
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "tgfx");
}

export async function loadConfig(paths: WorkspacePaths): Promise<TgfxConfig | undefined> {
  try {
    const raw = await readFile(paths.config, "utf8");
    return configSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid ${paths.config}: ${z.prettifyError(error)}`, { cause: error });
    }
    throw error;
  }
}

export async function saveConfig(paths: WorkspacePaths, config: TgfxConfig): Promise<void> {
  const validated = configSchema.parse(config);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const temporary = `${paths.config}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, paths.config);
}

/**
 * Serializes read-modify-write config edits across processes with a small
 * advisory lock, so a CLI edit and the running process's own rare write
 * (supergroup migration) cannot clobber each other. A lock older than five
 * seconds is treated as leftover from a crash and taken over.
 */
export async function updateConfig(
  paths: WorkspacePaths,
  mutate: (config: TgfxConfig | undefined) => TgfxConfig | undefined | Promise<TgfxConfig | undefined>,
): Promise<TgfxConfig | undefined> {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  const lockPath = join(paths.directory, "config.write.lock");
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(lockPath).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > 5_000) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error("another tgfx process is editing the configuration; try again");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    // Returning undefined from `mutate` aborts without writing.
    const next = await mutate(await loadConfig(paths));
    if (next) await saveConfig(paths, next);
    return next;
  } finally {
    await rm(lockPath, { force: true });
  }
}

export async function pruneWorkspaceFiles(paths: WorkspacePaths, maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  let entries: string[];
  try { entries = await readdir(paths.files); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    const path = join(paths.files, name);
    const info = await lstat(path);
    if (info.mtimeMs >= cutoff) continue;
    // `lstat` deliberately avoids following a malicious symlink outside .tgfx.
    await rm(path, { recursive: info.isDirectory(), force: true });
  }
}

export type BotIndexRecord = {
  botId: string;
  workspace: string;
};

export async function findBotIndex(botId: string): Promise<BotIndexRecord | undefined> {
  const path = join(userConfigDirectory(), "bots.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(parsed)) return undefined;
    return parsed.find((entry): entry is BotIndexRecord =>
      entry && typeof entry === "object"
      && entry.botId === botId
      && typeof entry.workspace === "string"
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function updateBotIndex(record: BotIndexRecord): Promise<void> {
  const path = join(userConfigDirectory(), "bots.json");
  let entries: BotIndexRecord[] = [];
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (Array.isArray(parsed)) entries = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = entries.filter((entry) => entry.botId !== record.botId);
  next.push(record);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
