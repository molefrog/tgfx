#!/usr/bin/env bun
import { confirm, isCancel, note, password, select, spinner, text } from "@clack/prompts";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TgfxApp, type TgfxLogEvent } from "./app";
import { StatusStore, type StatusEvent } from "./status";
import {
  botPaths,
  loadConfig,
  projectPaths,
  saveConfig,
  type ProjectPaths,
  type WorkspacePaths,
} from "./config";
import { acquireRuntimeLock } from "./lock";
import { runTelegramMcpServer } from "./mcp/server";
import { deleteBotToken, getBotToken, setBotToken, tokenFromEnvironment } from "./secrets";
import { StateStore } from "./state";
import { adminCapabilitiesForMember, createTelegramApi, type TelegramApi } from "./telegram/api";
import { privatePairingFromUpdate, type PrivatePairing } from "./telegram/pairing";
import { isOutputMode, OUTPUT_MODES, type BotIdentity, type TgfxConfig } from "./types";
import { inspectFx } from "./fx/preflight";
import { terminalQrCode } from "./cli/qr";
import {
  banner,
  bold,
  CliError,
  dim,
  green,
  helpText,
  ok,
  parseArgs,
  printError,
  red,
  VERSION,
  warn,
  yellow,
} from "./cli/ui";

const STDERR = { output: process.stderr };

const DECIMAL_ID = /^-?\d+$/;

function cancelled(value: unknown): asserts value is Exclude<typeof value, symbol> {
  if (isCancel(value)) {
    warn("setup cancelled");
    process.exit(1);
  }
}

function requireInteractive(purpose: string): void {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new CliError(
      `${purpose} needs an interactive terminal`,
      "run tgfx once in a terminal, or set TELEGRAM_BOT_TOKEN for non-interactive use",
    );
  }
}

async function requireConfig(paths: ProjectPaths): Promise<TgfxConfig> {
  const config = await loadConfig(paths);
  if (!config) throw new CliError("this folder isn't set up yet", "run tgfx once to connect a bot");
  return config;
}

async function requireToken(config: TgfxConfig): Promise<string> {
  const token = tokenFromEnvironment() ?? await getBotToken(config.activeBotId);
  if (!token) throw new CliError("the Telegram bot token is missing", "run tgfx auth to add it");
  return token;
}

/** A decimal Telegram ID in canonical form: no leading zeros, no negative zero. */
function canonicalId(raw: string): string {
  const id = raw.trim();
  if (!DECIMAL_ID.test(id)) throw new CliError(`"${raw}" is not a decimal Telegram ID`);
  return String(BigInt(id));
}

async function validateToken(token: string): Promise<{ telegram: TelegramApi; bot: BotIdentity }> {
  const telegram = createTelegramApi(token);
  const me = await telegram.getMe();
  return {
    telegram,
    bot: {
      id: String(me.id),
      ...(me.username ? { username: me.username } : {}),
      displayName: [me.first_name, me.last_name].filter(Boolean).join(" ") || me.username || String(me.id),
    },
  };
}

async function askForToken(): Promise<string> {
  requireInteractive("adding a bot token");
  const value = await password({
    message: "Telegram bot token",
    validate: (input) => (input ?? "").includes(":") ? undefined : "Paste the token from @BotFather",
    ...STDERR,
  });
  cancelled(value);
  return String(value).trim();
}

async function pairPrivateOwner(bot: BotIdentity, telegram: TelegramApi): Promise<PrivatePairing> {
  if (!bot.username) {
    throw new CliError(
      "this bot has no public username, so Telegram deep-link pairing is unavailable",
      "give the bot a username in @BotFather, or enter Telegram IDs manually",
    );
  }
  const webhook = await telegram.getWebhookInfo();
  if (webhook.url) {
    throw new CliError(
      `this bot still has a webhook configured (${webhook.url})`,
      "remove the webhook so tgfx can use long polling",
    );
  }

  const payload = `tgfx_${randomBytes(8).toString("hex")}`;
  const url = `https://t.me/${bot.username}?start=${payload}`;
  const qrCode = terminalQrCode(url);
  const backlog = await telegram.getUpdates(-1, 0);
  let offset = (backlog.at(-1)?.update_id ?? -1) + 1;
  note(
    `${qrCode}\n\n${url}\n\nScan the QR code or open the link, then press Start. The link expires when setup exits.`,
    "Connect your Telegram account",
    STDERR,
  );
  const progress = spinner(STDERR);
  progress.start("Waiting for you to press Start…");
  const deadline = Date.now() + 2 * 60_000;
  try {
    while (Date.now() < deadline) {
      const updates = await telegram.getUpdates(offset, 10);
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        const pairing = privatePairingFromUpdate(update, payload);
        if (pairing) {
          progress.stop(`Connected ${pairing.displayName}${pairing.username ? ` (@${pairing.username})` : ""}`);
          return pairing;
        }
      }
    }
  } catch (error) {
    progress.stop("Pairing failed");
    throw error;
  }
  progress.stop("Pairing timed out");
  throw new CliError("no matching /start message arrived within two minutes", "run tgfx again to retry");
}

type Principal = { kind: "user" | "chat"; id: string };

/** Ask for one user or chat ID by hand, as in first-run setup. */
async function askPrincipal(): Promise<Principal> {
  const selected = await select({
    message: "Which Telegram identity may use it?",
    options: [
      { value: "user", label: "One Telegram user" },
      { value: "chat", label: "One group or private chat" },
    ],
    ...STDERR,
  });
  cancelled(selected);
  const kind = selected as Principal["kind"];
  if (kind === "chat") {
    note(
      "Every human or anonymous chat-as-sender identity in this chat can invoke fx. Messages from other bots remain ignored.",
      "Chat-wide access",
      STDERR,
    );
  }
  const answer = await text({
    message: kind === "user" ? "Allowed Telegram user ID" : "Allowed Telegram chat ID",
    placeholder: "123456789",
    validate: (input) => DECIMAL_ID.test((input ?? "").trim()) ? undefined : "Enter a decimal Telegram ID",
    ...STDERR,
  });
  cancelled(answer);
  return { kind, id: canonicalId(String(answer)) };
}

/**
 * Pick who to allow when `tgfx allow` gets no IDs: pair an account over a
 * deep link, or type an ID. Pairing polls the bot, so it needs the runtime
 * lock; a running tgfx would otherwise fight it for updates.
 */
async function pickPrincipal(paths: ProjectPaths, config: TgfxConfig): Promise<Principal> {
  const method = await select({
    message: "Who should be allowed?",
    options: [
      { value: "pair", label: "Connect a Telegram account", hint: "scan a QR code" },
      { value: "manual", label: "Enter a Telegram ID", hint: "users, groups, and channels" },
    ],
    ...STDERR,
  });
  cancelled(method);
  if (method === "manual") return askPrincipal();
  const { bot, telegram } = await validateToken(await requireToken(config));
  if (bot.id !== config.activeBotId) {
    throw new CliError(
      `this folder is configured for bot ${config.activeBotId}, but the stored token belongs to ${bot.id}`,
      "run tgfx auth to switch bots",
    );
  }
  let release: () => Promise<void>;
  try {
    release = await acquireRuntimeLock(bot.id, paths.workspace);
  } catch (error) {
    if (!/already running/.test(error instanceof Error ? error.message : "")) throw error;
    throw new CliError(
      "tgfx is running, so pairing cannot poll the bot",
      "stop tgfx first, or run tgfx allow <id> with the account's Telegram ID",
    );
  }
  try {
    const pairing = await pairPrivateOwner(bot, telegram);
    const state = new StateStore(botPaths(bot.id).database);
    try {
      state.ensurePollState(bot.id);
      state.advanceCursor(bot.id, pairing.updateId + 1);
    } finally { state.close(); }
    await telegram.sendText(pairing.chatId, `You can now talk to fx in ${paths.workspace}.`);
    return { kind: "user", id: pairing.userId };
  } finally {
    await release();
  }
}

/** Add one principal to the allowlist in memory; reports and returns false when already there. */
function grant(config: TgfxConfig, { kind, id }: Principal): boolean {
  const list = kind === "chat" ? config.access.chatIds : config.access.userIds;
  if (list.includes(id)) {
    warn(`${kind} ${id} is already allowed`);
    return false;
  }
  list.push(id);
  ok(`allowed ${kind} ${id}${kind === "chat" && Number(id) < 0 ? dim(" · everyone in this chat can invoke fx") : ""}`);
  return true;
}

async function createConfig(paths: ProjectPaths, bot: BotIdentity, telegram: TelegramApi): Promise<TgfxConfig> {
  requireInteractive("first-run setup");
  const setup = await select({
    message: "Who may use this workspace bot?",
    options: [
      { value: "pair", label: "Connect my Telegram account", hint: "recommended" },
      { value: "manual", label: "Enter Telegram IDs manually", hint: "groups and advanced setup" },
    ],
    ...STDERR,
  });
  cancelled(setup);
  let principalKind: "user" | "chat" = "user";
  let identifier: string;
  let approvalsChatId: string;
  let pairedUpdateId: number | undefined;
  if (setup === "pair") {
    const pairing = await pairPrivateOwner(bot, telegram);
    identifier = pairing.userId;
    approvalsChatId = pairing.chatId;
    pairedUpdateId = pairing.updateId;
  } else {
    ({ kind: principalKind, id: identifier } = await askPrincipal());
    const approvalsAnswer = await text({
      message: "Approvals chat ID (approval cards and failure notices)",
      initialValue: identifier,
      validate: (input) => DECIMAL_ID.test((input ?? "").trim()) ? undefined : "Enter a decimal Telegram ID",
      ...STDERR,
    });
    cancelled(approvalsAnswer);
    approvalsChatId = String(approvalsAnswer).trim();
    if (principalKind === "chat" && approvalsChatId === identifier) {
      note(
        "Every allowed member of this approvals chat can press permission and administrator approval buttons.",
        "Approval policy",
        STDERR,
      );
    }
  }
  const config: TgfxConfig = {
    version: 1,
    activeBotId: bot.id,
    access: {
      userIds: principalKind === "user" ? [identifier] : [],
      chatIds: principalKind === "chat" ? [identifier] : [],
    },
    approvals: { chatId: approvalsChatId, topicId: "0" },
    output: "live",
    customIcons: true,
  };
  await telegram.sendText(
    config.approvals.chatId,
    `tgfx connected to ${paths.workspace}. This chat receives approval cards and delivery-failure notices.`,
  );
  await saveConfig(paths, config);
  if (pairedUpdateId !== undefined) {
    const state = new StateStore(botPaths(bot.id).database);
    try {
      state.ensurePollState(bot.id);
      state.advanceCursor(bot.id, pairedUpdateId + 1);
    } finally { state.close(); }
  }
  return (await loadConfig(paths))!;
}

/** Config and token when both are already on disk, so a run can skip setup and prompts. */
async function knownWorkspace(project: ProjectPaths): Promise<{ config: TgfxConfig; token: string } | undefined> {
  const config = await loadConfig(project);
  if (!config) return undefined;
  const token = tokenFromEnvironment() ?? await getBotToken(config.activeBotId);
  return token ? { config, token } : undefined;
}

async function runtime(project: ProjectPaths, options: {
  json?: boolean;
  known?: { config: TgfxConfig; token: string };
  /** Startup progress for the live view; each step reports before and after. */
  boot?: (event: Extract<StatusEvent, { type: "boot" }>) => void;
} = {}): Promise<{
  paths: WorkspacePaths; config: TgfxConfig; token: string; telegram: TelegramApi; bot: BotIdentity;
  fxBinary: string; release: () => Promise<void>;
}> {
  const boot = options.boot ?? (() => undefined);
  const step = async <T,>(name: "fx" | "telegram" | "lock", work: () => Promise<T>, done: (value: T) => string | undefined) => {
    boot({ step: name, state: "running", type: "boot" });
    try {
      const value = await work();
      const detail = done(value);
      boot({ step: name, state: "done", type: "boot", ...(detail ? { detail } : {}) });
      return value;
    } catch (error) {
      boot({ step: name, state: "failed", type: "boot", detail: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  const fxBinary = process.env.FX_BINARY ?? "fx";
  await step("fx", () => inspectFx(fxBinary, project.workspace), (report) => report.report.model);
  let config = options.known?.config ?? await loadConfig(project);
  let token = options.known?.token ?? tokenFromEnvironment();
  let prompted = false;
  if (!token && config) token = await getBotToken(config.activeBotId);
  if (options.json && (!config || !token)) {
    throw new CliError(
      "this workspace is not initialized",
      "run tgfx once without --json to finish interactive setup",
    );
  }
  if (!token) { token = await askForToken(); prompted = true; }
  const validToken = token;
  const { telegram, bot } = await step("telegram", () => validateToken(validToken), (result) => `@${result.bot.username ?? result.bot.id}`);
  if (config && config.activeBotId !== bot.id) {
    throw new CliError(
      `this folder is configured for bot ${config.activeBotId}, but the supplied token belongs to ${bot.id}`,
      "run tgfx auth to switch bots",
    );
  }
  const release = await step("lock", () => acquireRuntimeLock(bot.id, project.workspace), () => undefined);
  try {
    if (!config) config = await createConfig(project, bot, telegram);
    const webhook = await telegram.getWebhookInfo();
    if (webhook.url) {
      throw new CliError(
        `this bot has a webhook configured (${webhook.url})`,
        "remove the webhook so tgfx can use long polling",
      );
    }
    if (prompted) await setBotToken(bot.id, token);
    return { paths: { ...project, ...botPaths(bot.id) }, config, token, telegram, bot, fxBinary, release };
  } catch (error) {
    await release();
    throw error;
  }
}

function createLogger(json: boolean): (event: TgfxLogEvent) => void {
  if (json) {
    return (event) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
  }
  return (event) => console.log(`${dim(new Date().toTimeString().slice(0, 8))} ${event.message}`);
}

async function runCommand(tokens: string[]): Promise<void> {
  const { flags } = parseArgs(tokens, {
    flags: {
      model: "string",
      yolo: "boolean",
      output: "string",
      "no-icons": "boolean",
      "no-tui": "boolean",
      json: "boolean",
      "no-color": "boolean",
      debug: "boolean",
      help: "boolean",
      version: "boolean",
    },
  });
  if (flags.help) { process.stderr.write(helpText()); return; }
  if (flags.version) { console.log(VERSION); return; }
  const output = flags.output;
  if (output !== undefined && !isOutputMode(output)) {
    throw new CliError(`"${output}" is not an output mode`, `use one of ${OUTPUT_MODES.join(", ")}`);
  }
  const json = Boolean(flags.json);
  const project = projectPaths();
  // The live view needs a terminal on both ends and a workspace that is already
  // set up, so no prompt has to share the screen with it. Otherwise stay a plain log.
  const live = !json && !flags["no-tui"] && Boolean(process.stderr.isTTY && process.stdin.isTTY);
  const known = live ? await knownWorkspace(project) : undefined;
  const store = live ? new StatusStore({ yolo: Boolean(flags.yolo) }) : undefined;
  const log = store ? (event: TgfxLogEvent) => store.logLine(event.message) : createLogger(json);
  let app: TgfxApp | undefined;
  let view: { unmount(): void } | undefined;
  let release: (() => Promise<void>) | undefined;
  const shutdown = () => void app?.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // The view mounts before the startup checks when the workspace is already set
  // up, so the wire can draw itself as they finish. A first run keeps the screen
  // for the setup prompts and mounts the view once they are done.
  const mount = async () => {
    if (!store || view) return;
    // After setup, wipe the prompts and QR code so the view starts on a clean screen.
    if (!known) process.stderr.write("[2J[3J[H");
    const { startTui } = await import("./cli/tui");
    view = startTui({
      store,
      controls: {
        quit: shutdown,
        setOutput: (output) => app?.setOutput(output),
        setCustomIcons: (on) => app?.setCustomIcons(on),
        setPaused: (on) => app?.setPaused(on),
      },
    });
  };
  try {
    if (known) await mount();
    const resolved = await runtime(project, {
      json, ...(known ? { known } : {}), ...(store ? { boot: (event) => store.apply(event) } : {}),
    });
    await mount();
    const { release: releaseLock, ...appRuntime } = resolved;
    release = releaseLock;
    if (flags.yolo) {
      const message = "fx permission checks are disabled for this run (--yolo)";
      if (json) log({ event: "permission.mode", message, mode: "yolo" });
      else if (!live) warn(message);
    }
    app = new TgfxApp({
      ...appRuntime,
      mcpLaunch: Bun.isStandaloneExecutable
        ? { command: process.execPath, args: ["mcp"] }
        : { command: process.execPath, args: [fileURLToPath(import.meta.url), "mcp"] },
      ...(typeof flags.model === "string" ? { model: flags.model } : {}),
      ...(output === undefined ? {} : { output }),
      ...(flags["no-icons"] ? { customIcons: false } : {}),
      permissionMode: flags.yolo ? "yolo" : "auto",
      log,
      ...(store ? { status: (event: StatusEvent) => store.apply(event) } : {}),
    });
    store?.apply({ type: "settings", settings: app.settings() });
    await app.run();
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await app?.stop();
    await release?.();
    view?.unmount();
    if (json) log({ event: "stopped", message: "stopped" });
    else ok("stopped");
  }
}

type ParsedTarget = { chatId: string; topicId: string };

function parseChatTarget(value: string): ParsedTarget {
  const match = /^(-?\d+)(?:\/(\d+))?$/.exec(value.trim());
  if (!match) {
    throw new CliError(
      `"${value}" is not a Telegram chat ID`,
      "use a decimal chat ID, optionally with a topic: -1002255001/55",
    );
  }
  return { chatId: canonicalId(match[1]!), topicId: String(BigInt(match[2] ?? "0")) };
}

async function allowCommand(tokens: string[]): Promise<void> {
  const { flags, positionals } = parseArgs(tokens, {
    flags: { chat: "boolean", json: "boolean" },
    positionals: true,
  });
  const paths = projectPaths();
  const config = await requireConfig(paths);
  if (positionals.length) {
    for (const raw of positionals) {
      const id = canonicalId(raw);
      grant(config, { kind: flags.chat || Number(id) < 0 ? "chat" : "user", id });
    }
  } else {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new CliError(
        "give at least one Telegram user or chat ID",
        "example: tgfx allow 123456789 · in a terminal, plain tgfx allow pairs an account by QR code",
      );
    }
    grant(config, await pickPrincipal(paths, config));
  }
  await saveConfig(paths, config);
  process.stderr.write(`  ${dim("saved · restart tgfx to apply")}\n`);
  if (flags.json) console.log(JSON.stringify(config.access, null, 2));
}

async function denyCommand(tokens: string[]): Promise<void> {
  const { flags, positionals } = parseArgs(tokens, {
    flags: { json: "boolean" },
    positionals: true,
  });
  if (!positionals.length) {
    throw new CliError("give at least one Telegram user or chat ID", "example: tgfx deny 123456789");
  }
  const ids = positionals.map(canonicalId);
  const paths = projectPaths();
  const config = await requireConfig(paths);
  const notices: Array<{ warning?: boolean; message: string }> = [];
  let changed = false;
  for (const id of ids) {
    const inUsers = config.access.userIds.includes(id);
    const inChats = config.access.chatIds.includes(id);
    if (!inUsers && !inChats) {
      notices.push({ warning: true, message: `${id} was not on the allowlist` });
      continue;
    }
    config.access.userIds = config.access.userIds.filter((value) => value !== id);
    config.access.chatIds = config.access.chatIds.filter((value) => value !== id);
    changed = true;
    if (inUsers) notices.push({ message: `removed user ${id}` });
    if (inChats) notices.push({ message: `removed chat ${id}` });
  }
  if (config.access.userIds.length + config.access.chatIds.length === 0) {
    throw new CliError("the allowlist cannot be empty", "allow another user or chat first, then deny this one");
  }
  if (changed) await saveConfig(paths, config);
  for (const notice of notices) (notice.warning ? warn : ok)(notice.message);
  const remaining = config.access.userIds.length + config.access.chatIds.length;
  process.stderr.write(
    `  ${dim(`${remaining} principal${remaining === 1 ? "" : "s"} remain${remaining === 1 ? "s" : ""} · saved · restart tgfx to apply`)}\n`,
  );
  if (flags.json) console.log(JSON.stringify(config.access, null, 2));
}

async function approvalsCommand(tokens: string[]): Promise<void> {
  const { flags, positionals } = parseArgs(tokens, {
    flags: { json: "boolean" },
    positionals: true,
  });
  const paths = projectPaths();
  const config = await requireConfig(paths);
  if (!positionals.length) {
    if (flags.json) { console.log(JSON.stringify(config.approvals, null, 2)); return; }
    const target = `${config.approvals.chatId}${config.approvals.topicId === "0" ? "" : `/${config.approvals.topicId}`}`;
    console.log(`approvals → ${target}`);
    return;
  }
  if (positionals.length > 1) throw new CliError("approvals takes one chat", "example: tgfx approvals -1002255001/55");
  const target = parseChatTarget(positionals[0]!);
  const token = await requireToken(config);
  await createTelegramApi(token).api.getChat(target.chatId);
  config.approvals = { chatId: target.chatId, topicId: target.topicId };
  await saveConfig(paths, config);
  ok(`approvals go to ${target.chatId}${target.topicId === "0" ? "" : `/${target.topicId}`} · restart tgfx to apply`);
  if (flags.json) console.log(JSON.stringify(config.approvals, null, 2));
}

function since(iso: string): string {
  const milliseconds = Date.now() - Date.parse(iso);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "just now";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function accessCommand(tokens: string[]): Promise<void> {
  const { flags } = parseArgs(tokens, { flags: { json: "boolean" } });
  const paths = projectPaths();
  const config = await requireConfig(paths);
  const database = botPaths(config.activeBotId).database;
  const state = existsSync(database) ? new StateStore(database) : undefined;
  try {
    const principals = [
      ...config.access.userIds.map((id) => ({ id, kind: "user" as const })),
      ...config.access.chatIds.map((id) => ({ id, kind: "chat" as const })),
    ];
    const routes = state?.routes().filter((route) => route.bot_id === config.activeBotId) ?? [];
    if (flags.json) {
      console.log(JSON.stringify({
        bot: config.activeBotId,
        workspace: paths.workspace,
        access: principals,
        approvals: config.approvals,
        settings: { output: config.output, customIcons: config.customIcons },
        sessions: routes.map((route) => ({
          chat: route.chat_id,
          topic: route.topic_id,
          session: route.session_id,
          generation: route.generation,
          lastActive: route.updated_at,
        })),
      }, null, 2));
      return;
    }

    console.log(`${bold(`bot ${config.activeBotId}`)} ${dim("·")} ${dim(paths.workspace)}`);
    console.log("");
    console.log(`  ${dim("can talk to fx")}`);
    for (const principal of principals) {
      const marks: string[] = [];
      if (principal.id === config.approvals.chatId) marks.push(yellow("approvals go here"));
      if (principal.kind === "chat" && Number(principal.id) < 0) marks.push(dim("everyone"));
      console.log(`  ${green("●")} ${principal.kind} ${principal.id}${marks.length ? `   ${marks.join(" · ")}` : ""}`);
    }
    if (config.access.chatIds.includes(config.approvals.chatId) === false
      && config.access.userIds.includes(config.approvals.chatId) === false) {
      const target = `${config.approvals.chatId}${config.approvals.topicId === "0" ? "" : `/${config.approvals.topicId}`}`;
      console.log("");
      console.log(`  ${dim("approvals")}`);
      console.log(`  ${yellow("●")} ${target}`);
    }
    if (routes.length) {
      console.log("");
      console.log(`  ${dim("sessions")}`);
      for (const route of routes) {
        const label = route.topic_id === "0" ? route.chat_id : `${route.chat_id}/${route.topic_id}`;
        const detail = route.session_id
          ? `session saved · gen ${route.generation} · ${since(route.updated_at)}`
          : "no session yet";
        console.log(`  ${route.session_id ? green("●") : dim("○")} ${label.padEnd(16)} ${dim(detail)}`);
      }
    }
    console.log("");
  } finally {
    state?.close();
  }
}

async function authCommand(tokens: string[]): Promise<void> {
  const { flags } = parseArgs(tokens, { flags: { remove: "boolean" } });
  const paths = projectPaths();
  banner();
  if (flags.remove) {
    const config = await requireConfig(paths);
    const deleted = await deleteBotToken(config.activeBotId);
    if (deleted) ok(`removed the stored token for bot ${config.activeBotId}`);
    else warn(`no stored token for bot ${config.activeBotId}`);
    if (tokenFromEnvironment()) warn("TELEGRAM_BOT_TOKEN is still set in this environment");
    process.stderr.write(`  ${dim("run tgfx auth to add a token again")}\n`);
    return;
  }
  const environmentToken = tokenFromEnvironment();
  const token = environmentToken ?? await askForToken();
  const { bot, telegram } = await validateToken(token);
  const release = await acquireRuntimeLock(bot.id, paths.workspace);
  try {
    let config = await loadConfig(paths);
    const previous = config?.activeBotId;
    if (config && previous !== bot.id) {
      requireInteractive("switching bots");
      const replace = await confirm({
        message: `Replace configured bot ${previous} with @${bot.username ?? bot.id}?`,
        initialValue: false,
        ...STDERR,
      });
      cancelled(replace);
      if (!replace) throw new CliError("bot switch cancelled; the existing workspace configuration was not changed");
    }
    const webhook = await telegram.getWebhookInfo();
    if (webhook.url) {
      throw new CliError(
        `this bot has a webhook configured (${webhook.url})`,
        "remove the webhook so tgfx can use long polling",
      );
    }
    if (!config) config = await createConfig(paths, bot, telegram);
    else {
      config = { ...config, activeBotId: bot.id };
      await saveConfig(paths, config);
      if (previous !== bot.id) {
        process.stderr.write(`  ${dim(`switched from bot ${previous} · route history stays partitioned by bot ID`)}\n`);
      }
    }
    if (environmentToken) warn("using TELEGRAM_BOT_TOKEN from the environment · not saved to the credential store");
    else await setBotToken(bot.id, token);
    ok(`connected @${bot.username ?? bot.id}`);
  } finally {
    await release();
  }
}

async function doctorCommand(tokens: string[]): Promise<void> {
  const { flags } = parseArgs(tokens, { flags: { json: "boolean" } });
  const paths = projectPaths();
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  let config: TgfxConfig | undefined;
  try {
    config = await loadConfig(paths);
    checks.push({ check: "config", ok: Boolean(config), detail: config ? paths.config : "not initialized" });
  } catch (error) {
    checks.push({ check: "config", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  if (config) {
    const environmentToken = tokenFromEnvironment();
    let token: string | undefined;
    let tokenError: string | undefined;
    try {
      token = environmentToken ?? await getBotToken(config.activeBotId);
    } catch (error) {
      tokenError = error instanceof Error ? error.message : String(error);
    }
    if (!token) {
      checks.push({
        check: "Telegram",
        ok: false,
        detail: tokenError ? `credential store unavailable · ${tokenError}` : "bot token missing · run tgfx auth",
      });
    } else {
      try {
        const { telegram, bot } = await validateToken(token);
        const webhook = await telegram.getWebhookInfo();
        const identityMatches = bot.id === config.activeBotId;
        checks.push({
          check: "Telegram",
          ok: !webhook.url && identityMatches,
          detail: `@${bot.username ?? bot.id} · ${environmentToken ? "environment token" : "OS credential store"}${webhook.url ? " · webhook configured" : ""}${identityMatches ? "" : " · wrong configured bot"}`,
        });
        try {
          const approvals = await telegram.api.getChat(config.approvals.chatId);
          checks.push({
            check: "approvals chat",
            ok: true,
            detail: `${approvals.type} ${config.approvals.chatId}${config.approvals.topicId === "0" ? "" : `/${config.approvals.topicId}`}`,
          });
        } catch (error) {
          checks.push({ check: "approvals chat", ok: false, detail: error instanceof Error ? error.message : String(error) });
        }
        for (const chatId of config.access.chatIds) {
          if (Number(chatId) >= 0) continue;
          try {
            const [chat, member] = await Promise.all([
              telegram.api.getChat(chatId),
              telegram.api.getChatMember(chatId, Number(bot.id)),
            ]);
            const granted = [...adminCapabilitiesForMember(member)];
            const admin = member.status === "administrator" || member.status === "creator";
            checks.push({
              check: `group ${"title" in chat && chat.title ? chat.title : chatId}`,
              ok: true,
              detail: admin
                ? `admin · ${granted.length ? granted.join(", ") : "no usable rights — grant them in the promote dialog"}`
                : "not an admin · admin tools stay off",
            });
          } catch (error) {
            checks.push({ check: `group ${chatId}`, ok: false, detail: error instanceof Error ? error.message : String(error) });
          }
        }
      } catch (error) {
        checks.push({ check: "Telegram", ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  try {
    const fx = await inspectFx(process.env.FX_BINARY ?? "fx", paths.workspace);
    checks.push({
      check: "fx",
      ok: true,
      detail: `${fx.version} · ${fx.report.model} · ${fx.report.auth}${fx.report.warn_count ? ` · ${fx.report.warn_count} warning(s)` : ""}`,
    });
  } catch (error) {
    checks.push({ check: "fx", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  if (config) {
    const database = botPaths(config.activeBotId).database;
    try {
      const state = new StateStore(database);
      state.close();
      checks.push({ check: "SQLite", ok: true, detail: database });
    } catch (error) {
      checks.push({ check: "SQLite", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  if (flags.json) console.log(JSON.stringify(checks, null, 2));
  else for (const check of checks) console.log(`${check.ok ? green("✓") : red("✗")} ${check.check} ${dim("·")} ${check.detail}`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

const COMMANDS: Record<string, { run: (tokens: string[]) => Promise<void> }> = {
  access: { run: accessCommand },
  allow: { run: allowCommand },
  deny: { run: denyCommand },
  approvals: { run: approvalsCommand },
  auth: { run: authCommand },
  doctor: { run: doctorCommand },
  help: { run: async (tokens) => { parseArgs(tokens, {}); process.stderr.write(helpText()); } },
  version: { run: async (tokens) => { parseArgs(tokens, {}); console.log(VERSION); } },
};

// MCP stdio owns stdout. It exits before any terminal UI code can run so no
// banner or prompt byte can corrupt its newline-delimited JSON-RPC channel.
const argv = process.argv.slice(2);
const first = argv[0];
if (first === "mcp") {
  await runTelegramMcpServer();
} else {
  if (argv.includes("--no-color")) process.env.NO_COLOR = "1";
  const debug = argv.includes("--debug") || (process.env.DEBUG ?? "").includes("tgfx");
  try {
    if (first === "--help" || first === "-h") process.stderr.write(helpText());
    else if (first === "--version" || first === "-v") console.log(VERSION);
    else if (first !== undefined && !first.startsWith("-")) {
      const command = COMMANDS[first];
      if (!command) {
        throw new CliError(`unknown command "${first}"`, "run tgfx --help for the full list");
      }
      await command.run(argv.slice(1));
    } else {
      await runCommand(argv);
    }
  } catch (error) {
    printError(error, debug);
    process.exit(1);
  }
}
