import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { TgfxConfig } from "./types";

const decimalId = z.string().regex(/^-?\d+$/, "must be a decimal Telegram ID");
const draftInterval = z.number().int().min(200).max(10_000);
const coreConfigSchema = z.object({
  version: z.literal(1),
  activeBotId: decimalId,
  access: z.object({
    userIds: z.array(decimalId).default([]),
    chatIds: z.array(decimalId).default([]),
  }).refine((value) => value.userIds.length + value.chatIds.length > 0, {
    message: "at least one allowed user or chat is required",
  }),
  approvals: z.object({ chatId: decimalId, topicId: decimalId.default("0") }),
});
const storedConfigSchema = coreConfigSchema.extend({
  streaming: z.boolean().optional(),
  expandStreamingTools: z.boolean().optional(),
  updateEveryMs: draftInterval.optional(),
  customIcons: z.boolean().optional(),
});

export const configSchema = coreConfigSchema.extend({
  streaming: z.boolean().default(true),
  expandStreamingTools: z.boolean().default(true),
  updateEveryMs: draftInterval.default(250),
  customIcons: z.boolean().default(true),
}) satisfies z.ZodType<TgfxConfig>;

/**
 * Everything shared across projects lives under one fx-convention directory:
 *
 *   ~/.fx/telegram/config.json       machine-wide defaults
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
    streaming: z.boolean().optional(),
    expandStreamingTools: z.boolean().optional(),
    updateEveryMs: z.number().int().min(200).max(10_000).optional(),
    customIcons: z.boolean().optional(),
  }).default({}),
});

export type GlobalConfig = z.infer<typeof globalSchema>;

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
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
  return globalSchema.parse({});
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  await writePrivateJson(join(tgfxHome(), "config.json"), globalSchema.parse(config));
}

async function loadStoredConfig(paths: ProjectPaths): Promise<z.infer<typeof storedConfigSchema> | undefined> {
  let raw: string;
  try {
    raw = await readFile(paths.config, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return storedConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid ${paths.config}: ${z.prettifyError(error)}`, { cause: error });
    }
    throw error;
  }
}

export async function loadConfig(paths: ProjectPaths): Promise<TgfxConfig | undefined> {
  const stored = await loadStoredConfig(paths);
  if (!stored) return undefined;
  const { defaults } = await loadGlobalConfig();
  return configSchema.parse({ ...defaults, ...stored });
}

const SETTING_KEYS = ["streaming", "expandStreamingTools", "updateEveryMs", "customIcons"] as const;

export async function saveConfig(
  paths: ProjectPaths,
  config: TgfxConfig,
  options: { preserveInheritedSettings?: boolean } = {},
): Promise<void> {
  const validated = configSchema.parse(config);
  if (!options.preserveInheritedSettings) {
    await writePrivateJson(paths.config, validated);
    return;
  }
  const current = await loadStoredConfig(paths);
  const { streaming, expandStreamingTools, updateEveryMs, customIcons, ...core } = validated;
  const settings = { streaming, expandStreamingTools, updateEveryMs, customIcons };
  const persisted: Record<string, unknown> = { ...core };
  for (const key of SETTING_KEYS) {
    if (current && Object.hasOwn(current, key)) persisted[key] = settings[key];
  }
  await writePrivateJson(paths.config, storedConfigSchema.parse(persisted));
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
