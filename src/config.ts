import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
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
  expandStreamingTools: z.boolean().default(true),
  updateEveryMs: draftInterval,
});
const modelPickerSchema = z.object({
  customIcons: z.boolean().default(true),
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
    expandStreamingTools: true,
    updateEveryMs: 250,
  }),
  modelPicker: modelPickerSchema.default({ customIcons: true }),
}) satisfies z.ZodType<TgfxConfig>;

/**
 * Everything shared across projects lives under one fx-convention directory:
 *
 *   ~/.fx/telegram/config.json       defaults + bot registry
 *   ~/.fx/telegram/state/<bot>.db    per-bot journal (one writer, held by the lock)
 *   ~/.fx/telegram/state/<bot>.lock  SQLite exclusive-mode process lock
 *   ~/.fx/telegram/files/<bot>/      attachment downloads
 *
 * A project carries only its override config at ./.fx/telegram/config.json.
 */
export function tgfxHome(): string {
  return process.env.TGFX_HOME
    ? resolve(process.env.TGFX_HOME)
    : join(homedir(), ".fx", "telegram");
}

export type ProjectPaths = {
  workspace: string;
  directory: string;
  config: string;
};

export type BotPaths = {
  database: string;
  lock: string;
  lockInfo: string;
  files: string;
};

export type WorkspacePaths = ProjectPaths & BotPaths;

export function projectPaths(workspace = process.cwd()): ProjectPaths {
  const canonical = resolve(workspace);
  const directory = join(canonical, ".fx", "telegram");
  return { workspace: canonical, directory, config: join(directory, "config.json") };
}

export function botPaths(botId: string): BotPaths {
  const state = join(tgfxHome(), "state");
  return {
    database: join(state, `${botId}.db`),
    lock: join(state, `${botId}.lock`),
    lockInfo: join(state, `${botId}.info.json`),
    files: join(tgfxHome(), "files", botId),
  };
}

export function workspacePaths(botId: string, workspace = process.cwd()): WorkspacePaths {
  return { ...projectPaths(workspace), ...botPaths(botId) };
}

const globalSchema = z.object({
  version: z.literal(1).default(1),
  defaults: z.object({
    renderer: rendererSchema.optional(),
    modelPicker: modelPickerSchema.optional(),
  }).default({}),
  bots: z.array(z.object({ botId: decimalId, workspace: z.string() })).default([]),
});

export type GlobalConfig = z.infer<typeof globalSchema>;
export type BotRecord = GlobalConfig["bots"][number];

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function legacyBotIndexPath(): string {
  const base = process.env.TGFX_CONFIG_DIR
    ? resolve(process.env.TGFX_CONFIG_DIR)
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "tgfx");
  return join(base, "bots.json");
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  const path = join(tgfxHome(), "config.json");
  try {
    return globalSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof z.ZodError) {
        throw new Error(`Invalid ${path}: ${z.prettifyError(error)}`, { cause: error });
      }
      throw error;
    }
  }
  // First run on this layout: fold the legacy bots.json index into the registry.
  try {
    const parsed = JSON.parse(await readFile(legacyBotIndexPath(), "utf8"));
    if (Array.isArray(parsed)) return globalSchema.parse({ bots: parsed });
  } catch {
    // The legacy index is best-effort input; a missing or malformed file starts fresh.
  }
  return globalSchema.parse({});
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  await writePrivateJson(join(tgfxHome(), "config.json"), globalSchema.parse(config));
}

export async function registerBot(record: BotRecord): Promise<void> {
  const config = await loadGlobalConfig();
  config.bots = [...config.bots.filter((entry) => entry.botId !== record.botId), record];
  await saveGlobalConfig(config);
}

export async function loadConfig(paths: ProjectPaths): Promise<TgfxConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(paths.config, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const { defaults } = await loadGlobalConfig();
    if (parsed && typeof parsed === "object") {
      if (parsed.renderer === undefined && defaults.renderer) parsed.renderer = defaults.renderer;
      if (parsed.modelPicker === undefined && defaults.modelPicker) parsed.modelPicker = defaults.modelPicker;
    }
    return configSchema.parse(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid ${paths.config}: ${z.prettifyError(error)}`, { cause: error });
    }
    throw error;
  }
}

export async function saveConfig(paths: ProjectPaths, config: TgfxConfig): Promise<void> {
  await writePrivateJson(paths.config, configSchema.parse(config));
}

export async function pruneBotFiles(files: string, maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  let entries: string[];
  try { entries = await readdir(files); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of entries) {
    const path = join(files, name);
    const info = await lstat(path);
    if (info.mtimeMs >= cutoff) continue;
    // `lstat` deliberately avoids following a malicious symlink outside the files directory.
    await rm(path, { recursive: info.isDirectory(), force: true });
  }
}

/**
 * One-shot move from the pre-0.2 layout (workspace-local `.tgfx/`) into the
 * shared `~/.fx/telegram` layout. Config and journal move; downloaded files are
 * transient (seven-day retention) and are dropped with the old directory.
 */
export async function migrateLegacyWorkspace(paths: ProjectPaths): Promise<string | undefined> {
  const legacyDirectory = join(paths.workspace, ".tgfx");
  const legacyConfig = join(legacyDirectory, "config.json");
  if (existsSync(paths.config) || !existsSync(legacyConfig)) return undefined;
  const config = configSchema.parse(JSON.parse(await readFile(legacyConfig, "utf8")));
  const bot = botPaths(config.activeBotId);
  const legacyDatabase = join(legacyDirectory, "state.sqlite");
  if (!existsSync(bot.database) && existsSync(legacyDatabase)) {
    await mkdir(dirname(bot.database), { recursive: true, mode: 0o700 });
    await chmod(dirname(bot.database), 0o700);
    // VACUUM INTO folds the WAL in and leaves a single clean file at the new path.
    const source = new Database(legacyDatabase, { readonly: true });
    try {
      source.exec(`VACUUM INTO '${bot.database.replaceAll("'", "''")}'`);
    } finally {
      source.close();
    }
    await chmod(bot.database, 0o600);
  }
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  await rename(legacyConfig, paths.config);
  await rm(legacyDirectory, { recursive: true, force: true });
  await registerBot({ botId: config.activeBotId, workspace: paths.workspace });
  return `moved bot ${config.activeBotId} state from .tgfx to ${tgfxHome()}`;
}
