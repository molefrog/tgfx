import { version } from "../../package.json";

/**
 * Terminal voice for the tgfx CLI.
 *
 * Two rules hold everywhere: primary command output (the access map, doctor
 * checks, JSON) goes to stdout; everything conversational — banners, prompts,
 * progress, errors, hints — goes to stderr. That keeps `tgfx access --json | jq`
 * clean and lets the MCP stdio subcommand share a binary with the terminal UI.
 */

export const VERSION: string = version;

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

export function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1);
      diagonal = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, substitution);
    }
  }
  return previous[b.length]!;
}

export function suggestion(input: string, candidates: readonly string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of candidates) {
    const distance = levenshtein(input.toLowerCase(), candidate);
    if (distance <= 2 && (!best || distance < best.distance)) best = { name: candidate, distance };
  }
  return best?.name;
}

/**
 * A strict flag parser: every token must be a declared flag or, where allowed,
 * a positional argument. Unknown flags are errors, not surprises. Booleans are
 * tri-state — absent flags stay undefined so config defaults can apply.
 */
export function parseArgs(
  tokens: string[],
  spec: {
    flags?: Record<string, "boolean" | "string">;
    positionals?: boolean;
  },
): { flags: Record<string, string | boolean>; positionals: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const declared = spec.flags ?? {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
      const kind = declared[name];
      if (!kind) throw new CliError(`unknown flag --${name}`, "run tgfx --help to see what is supported");
      if (kind === "boolean") {
        if (equals !== -1) throw new CliError(`--${name} does not take a value`);
        flags[name] = true;
      } else {
        const value = equals === -1 ? tokens[++index] : token.slice(equals + 1);
        if (value === undefined || (equals === -1 && value.startsWith("--"))) {
          throw new CliError(`--${name} needs a value`);
        }
        flags[name] = value;
      }
    } else if (spec.positionals) {
      positionals.push(token);
    } else {
      throw new CliError(`unexpected argument "${token}"`, "run tgfx --help to see what is supported");
    }
  }
  return { flags, positionals };
}

export function helpText(): string {
  const line = (usage: string, description: string) =>
    `  ${cyan(usage.padEnd(28))} ${dim(description)}`;
  return [
    `${bold("tgfx")} ${dim(`${VERSION} — run a local fx agent through one Telegram bot`)}`,
    "",
    line("tgfx", "run fx in this folder (sets up on first run)"),
    line("tgfx access", "who can talk to fx, where it's admin, who approves"),
    line("tgfx allow <id…>", "add users or chats to the allowlist"),
    line("tgfx deny <id…>", "remove them"),
    line("tgfx approvals <chat>[/topic]", "route approval cards to a chat"),
    line("tgfx auth [--remove]", "add, rotate, or remove the bot token"),
    line("tgfx doctor", "deep diagnostics: token, chats, rights, fx"),
    "",
    `  ${dim("run flags:")}  --model <id> · --streaming/--no-streaming · --collapse-tools/--no-collapse-tools`,
    `  ${dim("global:")}     --json · --no-color · --debug · --help · --version`,
    "",
  ].join("\n");
}
