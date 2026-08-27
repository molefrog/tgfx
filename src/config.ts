import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { TgfxConfig } from "./types";

const decimalId = z.string().regex(/^-?\d+$/, "must be a decimal Telegram ID");
const draftInterval = z.number().int().min(200).max(10_000).default(250)
  // 800ms was the fixed-loop default before draft commits became adaptive.
  .transform((value) => value === 800 ? 250 : value);
const rendererSchema = z.object({
  mode: z.enum(["streaming", "final"]).default("streaming"),
  collapseTools: z.boolean().default(true),
  expandStreamingTools: z.boolean().default(false),
  updateEveryMs: draftInterval,
});

export const configSchema = z.object({
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
    expandStreamingTools: false,
    updateEveryMs: 250,
  }),
}) satisfies z.ZodType<TgfxConfig>;

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
