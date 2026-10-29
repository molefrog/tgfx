import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { OUTPUT_MODES, REPLY_POLICIES, type TgfxConfig } from "./types";

const decimalId = z.string().regex(/^-?\d+$/, "must be a decimal Telegram ID");
const settingsSchema = z.object({
  output: z.enum(OUTPUT_MODES),
  customIcons: z.boolean(),
  dmReply: z.enum(REPLY_POLICIES),
  groupReply: z.enum(REPLY_POLICIES),
  chatReplies: z.record(decimalId, z.enum(REPLY_POLICIES)),
  memory: z.object({ enabled: z.boolean().default(true), file: z.string().min(1).default("MEMORY.md") }),
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
  defaults: settingsSchema.omit({ chatReplies: true }).partial().default({}),
});

export const configSchema = coreSchema.extend({
  output: settingsSchema.shape.output.default("live"),
  customIcons: settingsSchema.shape.customIcons.default(true),
  dmReply: settingsSchema.shape.dmReply.default("all"),
  groupReply: settingsSchema.shape.groupReply.default("mention"),
  chatReplies: settingsSchema.shape.chatReplies.default({}),
  memory: settingsSchema.shape.memory.optional(),
}) satisfies z.ZodType<TgfxConfig>;

export type GlobalConfig = z.infer<typeof globalSchema>;

export function assertAccessPolicyWritable(): void {
  if (process.env.TGFX_POLICY_FILE) {
    throw new Error("Telegram access is managed by TGFX_POLICY_FILE; edit that policy as its owner");
  }
}

/** Optional operator-owned identity and access policy, separate from mutable preferences. */
async function loadPolicy(): Promise<z.infer<typeof coreSchema> | undefined> {
  const path = process.env.TGFX_POLICY_FILE;
  if (!path) return undefined;
  const policy = await readJson(resolve(path), coreSchema);
  if (!policy) throw new Error(`Required Telegram policy file is missing: ${path}`);
  return policy;
}

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
    files: process.env.TGFX_FILES_DIR
      ? join(resolve(process.env.TGFX_FILES_DIR), botId)
      : join(tgfxHome(), "files", botId),
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

const pendingWrites = new Map<string, Promise<void>>();

function serializeWrite(path: string, write: () => Promise<void>): Promise<void> {
  const task = (pendingWrites.get(path) ?? Promise.resolve()).catch(() => undefined).then(write);
  pendingWrites.set(path, task);
  return task.finally(() => {
    if (pendingWrites.get(path) === task) pendingWrites.delete(path);
  });
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
  const path = join(tgfxHome(), "config.json");
  const parsed = globalSchema.parse(config);
  await serializeWrite(path, () => writePrivateJson(path, parsed));
}

type StoredConfig = z.infer<typeof storedConfigSchema>;
export type ProjectSettings = z.input<typeof settingsSchema>;

function storedRecord(paths: ProjectPaths, stored: StoredConfig): Record<string, unknown> {
  const { version, activeBotId, access, approvals, ...settings } = stored;
  return { version, workspace: paths.workspace, activeBotId, access, approvals, ...settings };
}

export async function loadConfig(paths: ProjectPaths): Promise<TgfxConfig | undefined> {
  const stored = await readJson(paths.config, storedConfigSchema);
  const policy = await loadPolicy();
  if (!stored && !policy) return undefined;
  if (stored && policy && stored.activeBotId !== policy.activeBotId) {
    throw new Error("Telegram policy and workspace bot identities differ");
  }
  const { defaults } = await loadGlobalConfig();
  return configSchema.parse({ ...defaults, ...stored, ...policy });
}

/**
 * Writes the project's identity. Settings stay where they came from: a key the
 * project file already overrides is kept up to date, everything else keeps
 * inheriting the machine-wide defaults. `overrides` names settings the project
 * takes over from now on, as when they are changed in the terminal view.
 */
export async function saveConfig(
  paths: ProjectPaths,
  config: TgfxConfig,
  overrides: Partial<ProjectSettings> = {},
): Promise<void> {
  const { output, customIcons, dmReply, groupReply, chatReplies, memory, ...core } = configSchema.parse(config);
  const policy = await loadPolicy();
  if (policy && JSON.stringify(coreSchema.parse(core)) !== JSON.stringify(policy)) {
    throw new Error("Telegram access is managed by TGFX_POLICY_FILE; edit that policy as its owner");
  }
  const changes = { ...overrides };
  await serializeWrite(paths.config, async () => {
    const current = await readJson(paths.config, storedConfigSchema);
    const settings = { output, customIcons, dmReply, groupReply, chatReplies, memory, ...changes };
    const persisted: Record<string, unknown> = { ...core };
    for (const key of Object.keys(settingsSchema.shape) as Array<keyof ProjectSettings>) {
      if (Object.hasOwn(changes, key)) persisted[key] = settings[key];
      else if (current && Object.hasOwn(current, key)) {
        persisted[key] = Object.keys(changes).length ? current[key] : settings[key];
      }
    }
    await writePrivateJson(paths.config, storedRecord(paths, storedConfigSchema.parse(persisted)));
  });
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
