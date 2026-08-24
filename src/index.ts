#!/usr/bin/env bun
import { confirm, isCancel, note, password, select, spinner, text } from "@clack/prompts";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { renderUnicodeCompact } from "uqr";
import { TgfxApp, type TgfxLogEvent } from "./app";
import {
  findBotIndex,
  loadConfig,
  saveConfig,
  updateBotIndex,
  workspacePaths,
  type WorkspacePaths,
} from "./config";
import { acquireRuntimeLock, runningLock } from "./lock";
import { runTelegramMcpServer } from "./mcp/server";
import { deleteBotToken, getBotToken, setBotToken, tokenFromEnvironment } from "./secrets";
import { StateStore, type ChatDirectoryRow } from "./state";
import { adminCapabilitiesForMember, createTelegramApi, type TelegramApi } from "./telegram/api";
import { privatePairingFromUpdate, type PrivatePairing } from "./telegram/pairing";
import type { AdminCapability, BotIdentity, TgfxConfig } from "./types";
import { inspectFx } from "./fx/preflight";
import {
  banner,
  bold,
  CliError,
  cyan,
  dim,
  green,
  helpText,
  ok,
  parseArgs,
  printError,
  red,
  suggestion,
  VERSION,
  warn,
  yellow,
} from "./cli/ui";

const STDERR = { output: process.stderr };

const CAPABILITY_LABELS: Record<AdminCapability, string> = {
  pins: "pin messages and keep the bulletin",
  topics: "manage forum topics",
  delete_messages: "delete messages",
  moderation: "ban or restrict members",
  join_requests: "review join requests",
};

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

async function requireConfig(paths: WorkspacePaths): Promise<TgfxConfig> {
  const config = await loadConfig(paths);
  if (!config) throw new CliError("this folder isn't set up yet", "run tgfx once to connect a bot");
  return config;
}

async function requireToken(config: TgfxConfig): Promise<string> {
  const token = tokenFromEnvironment() ?? await getBotToken(config.activeBotId);
  if (!token) throw new CliError("the Telegram bot token is missing", "run tgfx auth to add it");
  return token;
}

/** Says whether a config edit reaches a live process (it reloads within a second). */
async function applyNote(paths: WorkspacePaths, botId: string): Promise<string> {
  const lock = await runningLock(botId);
  if (lock?.workspace === paths.workspace) return "applied to the running bot";
  return "will apply on next start";
}

/** Cached display names from the workspace journal, when it exists. */
function withDirectory<T>(
  paths: WorkspacePaths,
  botId: string,
  use: (lookup: (chatId: string) => ChatDirectoryRow | undefined) => T,
): T {
  if (!existsSync(paths.database)) return use(() => undefined);
  const state = new StateStore(paths.database);
  try {
    return use((chatId) => state.chatInfo(botId, chatId));
  } finally { state.close(); }
}

function displayName(row: ChatDirectoryRow | undefined, id: string): string {
  if (row?.title) return row.title;
  if (row?.username) return `@${row.username}`;
  return id;
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
  const backlog = await telegram.getUpdates(-1, 0);
  let offset = (backlog.at(-1)?.update_id ?? -1) + 1;
  note(
    `${renderUnicodeCompact(url)}\n\nScan with your phone, or open\n${url}\n\nThe link expires when setup exits.`,
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

async function createConfig(paths: WorkspacePaths, bot: BotIdentity, telegram: TelegramApi): Promise<TgfxConfig> {
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
    const selectedPrincipal = await select({
      message: "Which Telegram identity may use it?",
      options: [
        { value: "user", label: "One Telegram user" },
        { value: "chat", label: "One group or private chat" },
      ],
      ...STDERR,
    });
    cancelled(selectedPrincipal);
    principalKind = selectedPrincipal as "user" | "chat";
    if (principalKind === "chat") {
      note(
        "Every human or anonymous chat-as-sender identity in this chat can invoke fx. Messages from other bots remain ignored.",
        "Chat-wide access",
        STDERR,
      );
    }
    const allowed = await text({
      message: principalKind === "user" ? "Allowed Telegram user ID" : "Allowed Telegram chat ID",
      placeholder: "6143594",
      validate: (input) => DECIMAL_ID.test((input ?? "").trim()) ? undefined : "Enter a decimal Telegram ID",
      ...STDERR,
    });
    cancelled(allowed);
    identifier = String(allowed).trim();
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
    renderer: { mode: "streaming", collapseTools: true, updateEveryMs: 800 },
  };
  await telegram.sendText(
    config.approvals.chatId,
    `tgfx connected to ${paths.workspace}. This chat receives approval cards and delivery-failure notices.`,
  );
  await saveConfig(paths, config);
  if (pairedUpdateId !== undefined) {
    const state = new StateStore(paths.database);
    try {
      state.ensurePollState(bot.id);
      state.advanceCursor(bot.id, pairedUpdateId + 1);
    } finally { state.close(); }
  }
  return config;
}

async function guardWorkspaceHandoff(
  paths: WorkspacePaths,
  bot: BotIdentity,
  options: { json?: boolean } = {},
): Promise<void> {
  const previous = await findBotIndex(bot.id);
  if (!previous || previous.workspace === paths.workspace) return;
  const previousPaths = workspacePaths(previous.workspace);
  if (!existsSync(previousPaths.database)) return;
  const state = new StateStore(previousPaths.database);
  try {
    const unfinished = state.unfinished();
    if (!unfinished.total) return;
    const detail = `${unfinished.inbox} inbox · ${unfinished.outbox} outbox · ${unfinished.effects} effects · ${unfinished.approvals} approvals`;
    if (options.json || !process.stdin.isTTY || !process.stderr.isTTY) {
      throw new CliError(
        `bot ${bot.id} has unfinished work in ${previous.workspace} (${detail})`,
        "resume tgfx there, or run tgfx here interactively to abandon it",
      );
    }
    note(`${previous.workspace}\n${detail}`, "Previous workspace has unfinished work", STDERR);
    const abandon = await confirm({
      message: "Abandon that recovery work and move this bot to the current folder?",
      initialValue: false,
      ...STDERR,
    });
    cancelled(abandon);
    if (!abandon) {
      throw new CliError(`resume tgfx in ${previous.workspace} before moving this bot`);
    }
    state.abandonUnfinished(`Explicitly abandoned when bot moved to ${paths.workspace}`);
  } finally { state.close(); }
}

async function runtime(paths: WorkspacePaths, options: { json?: boolean } = {}): Promise<{
  paths: WorkspacePaths; config: TgfxConfig; token: string; telegram: TelegramApi; bot: BotIdentity;
  fxBinary: string; release: () => Promise<void>;
}> {
  if (!options.json) banner();
  const fxBinary = process.env.FX_BINARY ?? "fx";
  const fx = await inspectFx(fxBinary, paths.workspace);
  if (!options.json) ok(`fx ${fx.version} · ${fx.report.model} · ${fx.report.auth}`);
  let config = await loadConfig(paths);
  let token = tokenFromEnvironment();
  let prompted = false;
  if (!token && config) token = await getBotToken(config.activeBotId);
  if (options.json && (!config || !token)) {
    throw new CliError(
      "this workspace is not initialized",
      "run tgfx once without --json to finish interactive setup",
    );
  }
  if (!token) { token = await askForToken(); prompted = true; }
  const { telegram, bot } = await validateToken(token);
  if (config && config.activeBotId !== bot.id) {
    throw new CliError(
      `this folder is configured for bot ${config.activeBotId}, but the supplied token belongs to ${bot.id}`,
      "run tgfx auth to switch bots",
    );
  }
  const release = await acquireRuntimeLock(paths, bot.id);
  try {
    await guardWorkspaceHandoff(paths, bot, options);
    if (!config) config = await createConfig(paths, bot, telegram);
    const webhook = await telegram.getWebhookInfo();
    if (webhook.url) {
      throw new CliError(
        `this bot has a webhook configured (${webhook.url})`,
        "remove the webhook so tgfx can use long polling",
      );
    }
    if (prompted) await setBotToken(bot.id, token);
    await updateBotIndex({ botId: bot.id, workspace: paths.workspace });
    return { paths, config, token, telegram, bot, fxBinary, release };
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
      streaming: "boolean",
      "no-streaming": "boolean",
      "collapse-tools": "boolean",
      "no-collapse-tools": "boolean",
      json: "boolean",
      "no-color": "boolean",
      debug: "boolean",
      help: "boolean",
      version: "boolean",
    },
  });
  if (flags.help) { process.stderr.write(helpText()); return; }
  if (flags.version) { console.log(VERSION); return; }
  if (flags.streaming && flags["no-streaming"]) throw new CliError("choose --streaming or --no-streaming, not both");
  if (flags["collapse-tools"] && flags["no-collapse-tools"]) {
    throw new CliError("choose --collapse-tools or --no-collapse-tools, not both");
  }
  const streaming = flags.streaming ? true : flags["no-streaming"] ? false : undefined;
  const collapseTools = flags["collapse-tools"] ? true : flags["no-collapse-tools"] ? false : undefined;
  const json = Boolean(flags.json);
  const resolved = await runtime(workspacePaths(), { json });
  const { release, ...appRuntime } = resolved;
  const log = createLogger(json);
  let app: TgfxApp | undefined;
  const shutdown = () => void app?.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    app = new TgfxApp({
      ...appRuntime,
      ...(typeof flags.model === "string" ? { model: flags.model } : {}),
      renderer: {
        ...(streaming === undefined ? {} : { mode: streaming ? "streaming" : "final" }),
        ...(collapseTools === undefined ? {} : { collapseTools }),
      },
      log,
    });
    await app.run();
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await app?.stop();
    await release();
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
  return { chatId: match[1]!, topicId: match[2] ?? "0" };
}

async function allowCommand(tokens: string[]): Promise<void> {
  const { flags, positionals } = parseArgs(tokens, {
    flags: { chat: "boolean", json: "boolean" },
    positionals: true,
  });
  if (!positionals.length) {
    throw new CliError("give at least one Telegram user or chat ID", "example: tgfx allow 6143594");
  }
  const paths = workspacePaths();
  const config = await requireConfig(paths);
  const lines: Array<() => void> = [];
  for (const raw of positionals) {
    const id = raw.trim();
    if (!DECIMAL_ID.test(id)) throw new CliError(`"${raw}" is not a decimal Telegram ID`);
    const kind = flags.chat || Number(id) < 0 ? "chat" : "user";
    const list = kind === "chat" ? config.access.chatIds : config.access.userIds;
    if (list.includes(id)) {
      lines.push(() => warn(`${kind} ${id} is already allowed`));
      continue;
    }
    list.push(id);
    lines.push(() => {
      const name = withDirectory(paths, config.activeBotId, (lookup) => displayName(lookup(id), id));
      const label = name === id ? `${kind} ${id}` : `${name} (${kind} ${id})`;
      ok(`allowed ${label}${kind === "chat" && Number(id) < 0 ? dim(" · everyone in this chat can invoke fx") : ""}`);
    });
  }
  await saveConfig(paths, config);
  for (const line of lines) line();
  process.stderr.write(`  ${dim(await applyNote(paths, config.activeBotId))}\n`);
  if (flags.json) console.log(JSON.stringify(config.access, null, 2));
}

async function denyCommand(tokens: string[]): Promise<void> {
  const { flags, positionals } = parseArgs(tokens, {
    flags: { json: "boolean" },
    positionals: true,
  });
  if (!positionals.length) {
    throw new CliError("give at least one Telegram user or chat ID", "example: tgfx deny 6143594");
  }
  const paths = workspacePaths();
  const config = await requireConfig(paths);
  const lines: Array<() => void> = [];
  for (const raw of positionals) {
    const id = raw.trim();
    if (!DECIMAL_ID.test(id)) throw new CliError(`"${raw}" is not a decimal Telegram ID`);
    const inUsers = config.access.userIds.includes(id);
    const inChats = config.access.chatIds.includes(id);
    if (!inUsers && !inChats) {
      lines.push(() => warn(`${id} was not on the allowlist`));
      continue;
    }
    config.access.userIds = config.access.userIds.filter((value) => value !== id);
    config.access.chatIds = config.access.chatIds.filter((value) => value !== id);
    lines.push(() => ok(`removed ${inChats ? "chat" : "user"} ${id}`));
  }
  if (config.access.userIds.length + config.access.chatIds.length === 0) {
    throw new CliError("the allowlist cannot be empty", "allow another user or chat first, then deny this one");
  }
  await saveConfig(paths, config);
  for (const line of lines) line();
  const remaining = config.access.userIds.length + config.access.chatIds.length;
  process.stderr.write(
    `  ${dim(`${remaining} principal${remaining === 1 ? "" : "s"} remain${remaining === 1 ? "s" : ""} · ${await applyNote(paths, config.activeBotId)}`)}\n`,
  );
  if (flags.json) console.log(JSON.stringify(config.access, null, 2));
}

async function approvalsCommand(tokens: string[]): Promise<void> {
  const { flags, positionals } = parseArgs(tokens, {
    flags: { json: "boolean" },
    positionals: true,
  });
  const paths = workspacePaths();
  const config = await requireConfig(paths);
  if (!positionals.length) {
    if (flags.json) { console.log(JSON.stringify(config.approvals, null, 2)); return; }
    const name = withDirectory(paths, config.activeBotId, (lookup) =>
      displayName(lookup(config.approvals.chatId), config.approvals.chatId));
    const target = `${config.approvals.chatId}${config.approvals.topicId === "0" ? "" : `/${config.approvals.topicId}`}`;
    console.log(`approvals → ${name === config.approvals.chatId ? target : `${name} (${target})`}`);
    return;
  }
  if (positionals.length > 1) throw new CliError("approvals takes one chat", "example: tgfx approvals -1002255001/55");
  const target = parseChatTarget(positionals[0]!);
  const token = await requireToken(config);
  await createTelegramApi(token).api.getChat(target.chatId);
  config.approvals = { chatId: target.chatId, topicId: target.topicId };
  await saveConfig(paths, config);
  ok(`approvals go to ${target.chatId}${target.topicId === "0" ? "" : `/${target.topicId}`} · ${await applyNote(paths, config.activeBotId)}`);
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
  const paths = workspacePaths();
  const config = await requireConfig(paths);
  const state = existsSync(paths.database) ? new StateStore(paths.database) : undefined;
  try {
    const info = (id: string) => state?.chatInfo(config.activeBotId, id);
    const principals = [
      ...config.access.userIds.map((id) => ({ id, kind: "user" as const, info: info(id) })),
      ...config.access.chatIds.map((id) => ({ id, kind: "chat" as const, info: info(id) })),
    ];
    const routes = state?.routes().filter((route) => route.bot_id === config.activeBotId) ?? [];
    if (flags.json) {
      console.log(JSON.stringify({
        bot: config.activeBotId,
        workspace: paths.workspace,
        access: principals.map((principal) => ({
          id: principal.id,
          kind: principal.kind,
          title: principal.info?.title ?? null,
          username: principal.info?.username ?? null,
          ...(principal.kind === "chat" && Number(principal.id) < 0 ? {
            adminStatus: principal.info?.admin_status ?? null,
            adminRights: principal.info ? JSON.parse(principal.info.admin_rights_json) : [],
          } : {}),
        })),
        approvals: config.approvals,
        renderer: config.renderer,
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

    const botInfo = info(config.activeBotId);
    const botLabel = botInfo?.username ? `@${botInfo.username}` : `bot ${config.activeBotId}`;
    console.log(`${bold(botLabel)} ${dim("·")} ${dim(paths.workspace)}`);
    console.log("");
    console.log(`  ${dim("can talk to fx")}`);
    for (const principal of principals) {
      const name = displayName(principal.info, principal.id);
      const marks: string[] = [];
      if (principal.id === config.approvals.chatId) marks.push(yellow("approvals go here"));
      if (principal.kind === "chat" && Number(principal.id) < 0) {
        const status = principal.info?.admin_status;
        marks.push(dim(status === "administrator" || status === "creator"
          ? "everyone · bot is admin"
          : status
            ? "everyone · not an admin"
            : "everyone"));
      }
      const label = name === principal.id
        ? `${principal.kind} ${principal.id}`
        : `${name.padEnd(16)} ${dim(`${principal.kind} ${principal.id}`)}`;
      console.log(`  ${green("●")} ${label}${marks.length ? `   ${marks.join(" · ")}` : ""}`);
      if (principal.kind === "chat" && Number(principal.id) < 0) {
        const status = principal.info?.admin_status;
        if (status === "administrator" || status === "creator") {
          const rights = new Set(state?.chatAdminRights(config.activeBotId, principal.id) ?? []);
          for (const capability of Object.keys(CAPABILITY_LABELS) as AdminCapability[]) {
            const granted = rights.has(capability);
            console.log(`      ${granted ? green("✓") : red("✗")} ${granted ? CAPABILITY_LABELS[capability] : dim(CAPABILITY_LABELS[capability])}`);
          }
        } else if (!status) {
          console.log(`      ${dim("admin standing unknown — run tgfx doctor or start tgfx")}`);
        }
      }
    }
    if (config.access.chatIds.includes(config.approvals.chatId) === false
      && config.access.userIds.includes(config.approvals.chatId) === false) {
      const name = displayName(info(config.approvals.chatId), config.approvals.chatId);
      const target = `${config.approvals.chatId}${config.approvals.topicId === "0" ? "" : `/${config.approvals.topicId}`}`;
      console.log("");
      console.log(`  ${dim("approvals")}`);
      console.log(`  ${yellow("●")} ${name === config.approvals.chatId ? target : `${name} ${dim(target)}`}`);
    }
    if (routes.length) {
      console.log("");
      console.log(`  ${dim("sessions")}`);
      for (const route of routes) {
        const name = displayName(info(route.chat_id), route.chat_id);
        const label = route.topic_id === "0" ? name : `${name}/${route.topic_id}`;
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
  const paths = workspacePaths();
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
  const release = await acquireRuntimeLock(paths, bot.id);
  try {
    await guardWorkspaceHandoff(paths, bot);
    const webhook = await telegram.getWebhookInfo();
    if (webhook.url) {
      throw new CliError(
        `this bot has a webhook configured (${webhook.url})`,
        "remove the webhook so tgfx can use long polling",
      );
    }
    let config = await loadConfig(paths);
    if (!config) config = await createConfig(paths, bot, telegram);
    else {
      const previous = config.activeBotId;
      if (previous !== bot.id) {
        requireInteractive("switching bots");
        const replace = await confirm({
          message: `Replace configured bot ${previous} with @${bot.username ?? bot.id}?`,
          initialValue: false,
          ...STDERR,
        });
        cancelled(replace);
        if (!replace) throw new CliError("bot switch cancelled; the existing workspace configuration was not changed");
      }
      config = { ...config, activeBotId: bot.id };
      await saveConfig(paths, config);
      if (previous !== bot.id) {
        process.stderr.write(`  ${dim(`switched from bot ${previous} · route history stays partitioned by bot ID`)}\n`);
      }
    }
    if (environmentToken) warn("using TELEGRAM_BOT_TOKEN from the environment · not saved to the credential store");
    else await setBotToken(bot.id, token);
    await updateBotIndex({ botId: bot.id, workspace: paths.workspace });
    ok(`connected @${bot.username ?? bot.id}`);
  } finally {
    await release();
  }
}

async function doctorCommand(tokens: string[]): Promise<void> {
  const { flags } = parseArgs(tokens, { flags: { json: "boolean" } });
  const paths = workspacePaths();
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
    const token = environmentToken ?? await getBotToken(config.activeBotId);
    if (!token) checks.push({ check: "Telegram", ok: false, detail: "bot token missing · run tgfx auth" });
    else {
      const state = existsSync(paths.database) ? new StateStore(paths.database) : undefined;
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
          state?.upsertChatInfo({
            botId: config.activeBotId, chatId: config.approvals.chatId, kind: approvals.type,
            ...("title" in approvals && approvals.title ? { title: approvals.title } : {}),
          });
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
            state?.upsertChatInfo({
              botId: config.activeBotId, chatId, kind: chat.type,
              ...("title" in chat && chat.title ? { title: chat.title } : {}),
            });
            state?.setChatAdminStatus(config.activeBotId, chatId, member.status, granted);
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
      } finally {
        state?.close();
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
    try {
      const state = new StateStore(paths.database);
      state.close();
      checks.push({ check: "SQLite", ok: true, detail: paths.database });
    } catch (error) {
      checks.push({ check: "SQLite", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  if (flags.json) console.log(JSON.stringify(checks, null, 2));
  else for (const check of checks) console.log(`${check.ok ? green("✓") : red("✗")} ${check.check} ${dim("·")} ${check.detail}`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

const COMMANDS: Record<string, { run: (tokens: string[]) => Promise<void>; hidden?: boolean }> = {
  access: { run: accessCommand },
  allow: { run: allowCommand },
  deny: { run: denyCommand },
  approvals: { run: approvalsCommand },
  auth: { run: authCommand },
  doctor: { run: doctorCommand },
  help: { run: async () => void process.stderr.write(helpText()) },
  version: { run: async () => void console.log(VERSION) },
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
        const near = suggestion(first, Object.keys(COMMANDS));
        throw new CliError(
          `unknown command "${first}"`,
          near ? `did you mean ${cyan(`tgfx ${near}`)}? run tgfx --help for the full list` : "run tgfx --help for the full list",
        );
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
