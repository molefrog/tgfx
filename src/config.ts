import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { OUTPUT_MODES, type TgfxConfig } from "./types";

const decimalId = z.string().regex(/^-?\d+$/, "must be a decimal Telegram ID");
const settingsSchema = z.object({
  output: z.enum(OUTPUT_MODES),
  customIcons: z.boolean(),
});
const coreSchema = z.object({
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
/** A project file: identity plus only the settings that override the defaults. */
const storedConfigSchema = coreSchema.extend(settingsSchema.partial().shape);
const globalSchema = z.object({
  version: z.literal(1).default(1),
  defaults: settingsSchema.partial().default({}),
});

export const configSchema = coreSchema.extend({
  output: settingsSchema.shape.output.default("live"),
  customIcons: settingsSchema.shape.customIcons.default(true),
}) satisfies z.ZodType<TgfxConfig>;

export type GlobalConfig = z.infer<typeof globalSchema>;

/**
 * Everything lives under one fx-convention directory; a workspace stays clean:
 *
 *   ~/.fx/telegram/config.json           machine-wide defaults for the settings
 *   ~/.fx/telegram/projects/<name>.json  one file per workspace: bot, allowlist,
 *                                        approvals, and any setting it overrides
 *   ~/.fx/telegram/state/<bot>.db        per-bot journal (one writer, held by the lock)
 *   ~/.fx/telegram/state/<bot>.lock      SQLite exclusive-mode process lock
 *   ~/.fx/telegram/files/<bot>/          attachment downloads
 */
export function tgfxHome(): string {
  return process.env.TGFX_HOME
    ? resolve(process.env.TGFX_HOME)
    : join(homedir(), ".fx", "telegram");
}

export type ProjectPaths = {
  workspace: string;
  config: string;
};

export type BotPaths = {
  database: string;
  lock: string;
  lockInfo: string;
  files: string;
};

export type WorkspacePaths = ProjectPaths & BotPaths;

/** The project file is named after the folder, made unique by a hash of its full path. */
export function projectPaths(workspace = process.cwd()): ProjectPaths {
  const canonical = resolve(workspace);
  const slug = basename(canonical).replace(/[^\w.-]+/gu, "-") || "root";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return { workspace: canonical, config: join(tgfxHome(), "projects", `${slug}-${hash}.json`) };
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

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** The parsed file, or undefined when it does not exist. */
async function readJson<T extends z.ZodType>(path: string, schema: T): Promise<z.output<T> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid ${path}: ${z.prettifyError(error)}`, { cause: error });
    }
    throw error;
  }
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  return await readJson(join(tgfxHome(), "config.json"), globalSchema) ?? globalSchema.parse({});
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  await writePrivateJson(join(tgfxHome(), "config.json"), globalSchema.parse(config));
}

type StoredConfig = z.infer<typeof storedConfigSchema>;

function storedRecord(paths: ProjectPaths, stored: StoredConfig): Record<string, unknown> {
  const { version, activeBotId, access, approvals, ...settings } = stored;
  return { version, workspace: paths.workspace, activeBotId, access, approvals, ...settings };
}

export async function loadConfig(paths: ProjectPaths): Promise<TgfxConfig | undefined> {
  const stored = await readJson(paths.config, storedConfigSchema);
  if (!stored) return undefined;
  const { defaults } = await loadGlobalConfig();
  return configSchema.parse({ ...defaults, ...stored });
}

/**
 * Writes the project's identity. Settings stay where they came from: a key the
 * project file already overrides is kept up to date, everything else keeps
 * inheriting the machine-wide defaults.
 */
export async function saveConfig(paths: ProjectPaths, config: TgfxConfig): Promise<void> {
  const { output, customIcons, ...core } = configSchema.parse(config);
  const current = await readJson(paths.config, storedConfigSchema);
  const settings: Record<string, unknown> = { output, customIcons };
  const persisted: Record<string, unknown> = { ...core };
  for (const key of Object.keys(settingsSchema.shape)) {
    if (current && Object.hasOwn(current, key)) persisted[key] = settings[key];
  }
  await writePrivateJson(paths.config, storedRecord(paths, storedConfigSchema.parse(persisted)));
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
