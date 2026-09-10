import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tgfxHome } from "./config";

const SERVICE = "dev.tgfx";

function name(botId: string): string {
  return `telegram:${botId}`;
}

function tokenPath(botId: string): string {
  if (!/^\d+$/.test(botId)) throw new Error("Invalid bot ID");
  return join(tgfxHome(), "tokens", `${botId}.token`);
}

async function readTokenFile(botId: string): Promise<string | undefined> {
  try {
    return await readFile(tokenPath(botId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeTokenFile(botId: string, token: string): Promise<string> {
  const path = tokenPath(botId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, token, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

export async function getBotToken(botId: string): Promise<string | undefined> {
  const local = await readTokenFile(botId);
  if (local !== undefined) return local || undefined;
  try {
    return (await Bun.secrets.get({ service: SERVICE, name: name(botId) })) ?? undefined;
  } catch (error) {
    // A headless Linux host may have no libsecret, session bus, or login keyring.
    if (process.platform !== "linux") throw error;
    return undefined;
  }
}

/** Returns the path when the token was saved in the private file fallback. */
export async function setBotToken(botId: string, token: string): Promise<string | undefined> {
  if (await readTokenFile(botId) !== undefined) return writeTokenFile(botId, token);
  try {
    await Bun.secrets.set({ service: SERVICE, name: name(botId), value: token });
  } catch (error) {
    if (process.platform !== "linux") throw error;
    return writeTokenFile(botId, token);
  }
}

export async function deleteBotToken(botId: string): Promise<boolean> {
  const local = await readTokenFile(botId);
  if (local !== undefined) {
    // Keep an empty file so an older keyring token cannot reappear after removal.
    await writeTokenFile(botId, "");
    return Boolean(local);
  }
  try {
    return await Bun.secrets.delete({ service: SERVICE, name: name(botId) });
  } catch (error) {
    if (process.platform !== "linux") throw error;
    await writeTokenFile(botId, "");
    return false;
  }
}

export async function botTokenSource(botId: string): Promise<string> {
  return await readTokenFile(botId) !== undefined
    ? `token file · ${tokenPath(botId)}`
    : "OS credential store";
}

export function tokenFromEnvironment(): string | undefined {
  const value = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return value || undefined;
}

export function redactSecrets(message: string): string {
  return message.replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, "[redacted Telegram token]");
}
