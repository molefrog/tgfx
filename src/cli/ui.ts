import { parseArgs as parseNodeArgs } from "node:util";
import { VERSION } from "../version";

/**
 * Terminal voice for the tgfx CLI.
 *
 * Two rules hold everywhere: primary command output (the access map, doctor
 * checks, JSON) goes to stdout; everything conversational — banners, prompts,
 * progress, errors, hints — goes to stderr. That keeps `tgfx access --json | jq`
 * clean and lets the MCP stdio subcommand share a binary with the terminal UI.
 */

export { VERSION };

function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== "0";
  return Boolean(process.stderr.isTTY);
}

function paint(code: string, text: string): string {
  return colorEnabled() ? `\u001B[${code}m${text}\u001B[0m` : text;
}

export const dim = (text: string): string => paint("2", text);
export const bold = (text: string): string => paint("1", text);
export const red = (text: string): string => paint("31", text);
export const green = (text: string): string => paint("32", text);
export const yellow = (text: string): string => paint("33", text);
export const cyan = (text: string): string => paint("36", text);

/** The one-line banner: a plain wordmark, no exotic glyphs in the terminal. */
export function banner(): void {
  process.stderr.write(`${bold("tgfx")} ${dim(VERSION)}\n`);
}

export function ok(message: string): void {
  process.stderr.write(`${green("✓")} ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${yellow("!")} ${message}\n`);
}

/** An error users act on: one line of symptom, then optionally one line of fix. */
export class CliError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "CliError";
    if (hint) this.hint = hint;
  }
}

export function printError(error: unknown, debug: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${red("✗")} ${message}\n`);
  if (error instanceof CliError && error.hint) {
    process.stderr.write(`  ${dim(error.hint)}\n`);
  }
  if (debug && error instanceof Error && error.stack) {
    process.stderr.write(`${dim(error.stack)}\n`);
    for (let cause = error.cause; cause instanceof Error; cause = cause.cause) {
      process.stderr.write(`${dim(`caused by: ${cause.stack ?? cause.message}`)}\n`);
    }
  }
}

/** Flags every command accepts; the dispatcher acts on them before parsing. */
const GLOBAL_FLAGS: Record<string, "boolean"> = { "no-color": "boolean", debug: "boolean" };

export function parseArgs(
  tokens: string[],
  spec: {
    flags?: Record<string, "boolean" | "string">;
    positionals?: boolean;
  },
): { flags: Record<string, string | boolean>; positionals: string[] } {
  const declared = { ...GLOBAL_FLAGS, ...spec.flags };
  const prefix = "tgfx-negative:";
  const args = tokens.map((token) => /^-\d+(?:\/\d+)?$/.test(token) ? `${prefix}${token}` : token);
  let parsed;
  try {
    parsed = parseNodeArgs({
      args,
      strict: true,
      allowPositionals: Boolean(spec.positionals),
      options: Object.fromEntries(Object.entries(declared).map(([name, type]) => [name, { type }])),
    });
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), "run tgfx --help to see what is supported");
  }
  const restore = (value: string): string => value.startsWith(prefix) ? value.slice(prefix.length) : value;
  const flags = Object.fromEntries(Object.entries(parsed.values).map(([name, value]) => [
    name,
    typeof value === "string" ? restore(value) : value,
  ])) as Record<string, string | boolean>;
  for (const [name, type] of Object.entries(declared)) {
    if (type === "string" && flags[name] === "") throw new CliError(`--${name} needs a value`);
  }
  return { flags, positionals: parsed.positionals.map(restore) };
}

export function helpText(): string {
  const line = (usage: string, description: string) =>
    `  ${cyan(usage.padEnd(30))} ${dim(description)}`;
  return [
    `${bold("tgfx")} ${dim(`${VERSION} — run a local fx agent through one Telegram bot`)}`,
    "",
    line("tgfx", "run fx in this folder (sets up on first run)"),
    line("tgfx --yolo", "run with FX permission checks disabled"),
    line("tgfx access", "who can talk to fx, who approves, saved sessions"),
    line("tgfx allow <id…>", "add users or chats to the allowlist"),
    line("tgfx deny <id…>", "remove them"),
    line("tgfx approvals <chat>[/topic]", "route approval cards to a chat"),
    line("tgfx auth [--remove]", "add, rotate, or remove the bot token"),
    line("tgfx doctor", "deep diagnostics: token, chats, rights, fx"),
    "",
    `  ${dim("run flags:")}  --model <id> · --yolo · --streaming/--no-streaming · --no-icons`,
    `  ${dim("global:")}     --json · --no-color · --debug · --help · --version`,
    "",
  ].join("\n");
}
