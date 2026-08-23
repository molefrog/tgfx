#!/usr/bin/env bun
import { confirm, intro, isCancel, note, outro, password, select, spinner, text } from "@clack/prompts";
import { defineCommand, runMain } from "citty";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { TgfxApp } from "./app";
import {
  findBotIndex,
  loadConfig,
  saveConfig,
  updateBotIndex,
  workspacePaths,
  type WorkspacePaths,
} from "./config";
import { acquireRuntimeLock } from "./lock";
import { runTelegramMcpServer } from "./mcp/server";
import { getBotToken, setBotToken, tokenFromEnvironment } from "./secrets";
import { StateStore } from "./state";
import { TelegramApi } from "./telegram/api";
import { privatePairingFromUpdate, type PrivatePairing } from "./telegram/pairing";
import type { BotIdentity, TgfxConfig } from "./types";
import { inspectFx } from "./fx/preflight";

const VERSION = "0.1.0";

function cancelled(value: unknown): asserts value is Exclude<typeof value, symbol> {
  if (isCancel(value)) {
    outro("Setup cancelled.");
    process.exit(1);
  }
}

function requireInteractive(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("This workspace is not initialized. Run tgfx once in an interactive terminal.");
  }
}

async function validateToken(token: string): Promise<{ telegram: TelegramApi; bot: BotIdentity }> {
  const telegram = new TelegramApi(token);
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
  requireInteractive();
  const value = await password({
    message: "Telegram bot token",
    validate: (input) => (input ?? "").includes(":") ? undefined : "Paste the token from @BotFather",
  });
  cancelled(value);
  return String(value).trim();
}

async function pairPrivateOwner(bot: BotIdentity, telegram: TelegramApi): Promise<PrivatePairing> {
  if (!bot.username) throw new Error("This bot has no public username, so Telegram deep-link pairing is unavailable.");
  const webhook = await telegram.getWebhookInfo();
  if (webhook.url) {
    throw new Error(
      `This bot still has a webhook configured (${webhook.url}). Remove it before tgfx can use long polling.`,
    );
  }

  const payload = `tgfx_${randomBytes(8).toString("hex")}`;
  const url = `https://t.me/${bot.username}?start=${payload}`;
  const backlog = await telegram.getUpdates(-1, 0);
  let offset = (backlog.at(-1)?.update_id ?? -1) + 1;
  note(`${url}\n\nOpen this link and press Start. The link expires when setup exits.`, "Connect your Telegram account");
  const progress = spinner();
  progress.start("Waiting for your private message…");
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
  throw new Error("No matching /start message arrived within two minutes. Run tgfx again to retry.");
}

async function createConfig(paths: WorkspacePaths, bot: BotIdentity, telegram: TelegramApi): Promise<TgfxConfig> {
  requireInteractive();
  const setup = await select({
    message: "Who may use this workspace bot?",
    options: [
      { value: "pair", label: "Connect my Telegram account", hint: "recommended" },
      { value: "manual", label: "Enter Telegram IDs manually", hint: "groups and advanced setup" },
    ],
  });
  cancelled(setup);
  let principalKind: "user" | "chat" = "user";
  let identifier: string;
  let controlChatId: string;
  let pairedUpdateId: number | undefined;
  if (setup === "pair") {
    const pairing = await pairPrivateOwner(bot, telegram);
    identifier = pairing.userId;
    controlChatId = pairing.chatId;
    pairedUpdateId = pairing.updateId;
  } else {
    const selectedPrincipal = await select({
      message: "Which Telegram identity may use it?",
      options: [
        { value: "user", label: "One Telegram user" },
        { value: "chat", label: "One group or private chat" },
      ],
    });
    cancelled(selectedPrincipal);
    principalKind = selectedPrincipal as "user" | "chat";
    if (principalKind === "chat") {
      note(
        "Every human or anonymous chat-as-sender identity in this chat can invoke 𝒇x. Messages from other bots remain ignored.",
        "Chat-wide access",
      );
    }
    const allowed = await text({
      message: principalKind === "user" ? "Allowed Telegram user ID" : "Allowed Telegram chat ID",
      placeholder: "6143594",
      validate: (input) => /^-?\d+$/.test((input ?? "").trim()) ? undefined : "Enter a decimal Telegram ID",
    });
    cancelled(allowed);
    identifier = String(allowed).trim();
    const control = await text({
      message: "Control chat ID (approvals and failures)",
      initialValue: identifier,
      validate: (input) => /^-?\d+$/.test((input ?? "").trim()) ? undefined : "Enter a decimal Telegram ID",
    });
    cancelled(control);
    controlChatId = String(control).trim();
    if (principalKind === "chat" && controlChatId === identifier) {
      note(
        "Every allowed member of this control chat can press permission and administrator approval buttons.",
        "Approval policy",
      );
    }
  }
  const streaming = await confirm({ message: "Stream private-chat responses as rich drafts?", initialValue: true });
  cancelled(streaming);
  const collapseTools = await confirm({ message: "Collapse completed tool calls?", initialValue: true });
  cancelled(collapseTools);
  const config: TgfxConfig = {
    version: 1,
    activeBotId: bot.id,
    access: {
      userIds: principalKind === "user" ? [identifier] : [],
      chatIds: principalKind === "chat" ? [identifier] : [],
    },
    controlChat: { chatId: controlChatId, topicId: "0" },
    renderer: { mode: streaming ? "streaming" : "final", collapseTools: Boolean(collapseTools), updateEveryMs: 800 },
    admin: { chatIds: [], capabilities: [] },
  };
  await telegram.sendText(
    config.controlChat.chatId,
    `𝒕𝒈(𝒇x) connected to ${paths.workspace}. This chat will receive approvals and delivery failures.`,
  );
  await saveConfig(paths, config);
  if (pairedUpdateId !== undefined) {
    const state = new StateStore(paths.database);
    try {
      state.registerBot(bot);
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
    if (options.json || !process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        `Bot ${bot.id} has unfinished work in ${previous.workspace} (${detail}). Resume it there or abandon it interactively.`,
      );
    }
    note(`${previous.workspace}\n${detail}`, "Previous workspace has unfinished work");
    const abandon = await confirm({
      message: "Abandon that recovery work and move this bot to the current folder?",
      initialValue: false,
    });
    cancelled(abandon);
    if (!abandon) {
      throw new Error(`Resume tgfx in ${previous.workspace} before moving this bot.`);
    }
    state.abandonUnfinished(`Explicitly abandoned when bot moved to ${paths.workspace}`);
  } finally { state.close(); }
}

async function runtime(paths = workspacePaths(), options: { json?: boolean } = {}): Promise<{
  paths: WorkspacePaths; config: TgfxConfig; token: string; telegram: TelegramApi; bot: BotIdentity;
  fxBinary: string; release: () => Promise<void>;
}> {
  if (!options.json) intro("𝒕𝒈(𝒇x)");
  const fxBinary = process.env.FX_BINARY ?? "fx";
  const fx = await inspectFx(fxBinary, paths.workspace);
  if (!options.json) note(`${fx.version} · ${fx.report.model}\n${fx.report.auth}`, "𝒇x ready");
  let config = await loadConfig(paths);
  let token = tokenFromEnvironment();
  let prompted = false;
  if (!token && config) token = await getBotToken(config.activeBotId);
  if (options.json && (!config || !token)) {
    throw new Error("Initialize this workspace once without --json before using machine-readable mode.");
  }
  if (!token) { token = await askForToken(); prompted = true; }
  const { telegram, bot } = await validateToken(token);
  if (config && config.activeBotId !== bot.id) {
    throw new Error(
      `This folder is configured for bot ${config.activeBotId}, but the supplied token belongs to ${bot.id}. Run tgfx auth to change bots.`,
    );
  }
  const release = await acquireRuntimeLock(paths, bot.id);
  try {
    await guardWorkspaceHandoff(paths, bot, options);
    if (!config) config = await createConfig(paths, bot, telegram);
    const webhook = await telegram.getWebhookInfo();
    if (webhook.url) {
      throw new Error(`This bot has a webhook configured (${webhook.url}); tgfx needs long polling.`);
    }
    if (prompted) await setBotToken(bot.id, token);
    await updateBotIndex({
      botId: bot.id, username: bot.username, workspace: paths.workspace, updatedAt: new Date().toISOString(),
    });
    return { paths, config, token, telegram, bot, fxBinary, release };
  } catch (error) {
    await release();
    throw error;
  }
}

const authCommand = defineCommand({
  meta: { name: "auth", description: "Add or replace this workspace's Telegram bot" },
  async run() {
    const paths = workspacePaths();
    intro("𝒕𝒈(𝒇x) · bot authentication");
    const environmentToken = tokenFromEnvironment();
    const token = environmentToken ?? await askForToken();
    const { bot, telegram } = await validateToken(token);
    const release = await acquireRuntimeLock(paths, bot.id);
    try {
      await guardWorkspaceHandoff(paths, bot);
      const webhook = await telegram.getWebhookInfo();
      if (webhook.url) throw new Error(`This bot has a webhook configured (${webhook.url}); tgfx needs long polling.`);
      let config = await loadConfig(paths);
      if (!config) config = await createConfig(paths, bot, telegram);
      else {
        const previous = config.activeBotId;
        if (previous !== bot.id) {
          requireInteractive();
          const replace = await confirm({
            message: `Replace configured bot ${previous} with @${bot.username ?? bot.id}?`,
            initialValue: false,
          });
          cancelled(replace);
          if (!replace) throw new Error("Bot switch cancelled; the existing workspace configuration was not changed.");
        }
        config = { ...config, activeBotId: bot.id };
        await saveConfig(paths, config);
        if (previous !== bot.id) note(`Switched from bot ${previous}. Existing route history remains partitioned by bot ID.`);
      }
      if (!environmentToken) await setBotToken(bot.id, token);
      await updateBotIndex({ botId: bot.id, username: bot.username, workspace: paths.workspace, updatedAt: new Date().toISOString() });
      outro(`Connected @${bot.username ?? bot.id}.`);
    } finally {
      await release();
    }
  },
});

const accessCommand = defineCommand({
  meta: { name: "access", description: "Show or edit the required Telegram allowlist" },
  args: {
    "allow-user": { type: "string", description: "Allow a Telegram user ID" },
    "allow-chat": { type: "string", description: "Allow a Telegram chat ID" },
    "remove-user": { type: "string", description: "Remove a Telegram user ID" },
    "remove-chat": { type: "string", description: "Remove a Telegram chat ID" },
    "control-chat": { type: "string", description: "Set the approval/failure chat ID" },
    "control-topic": { type: "string", description: "Set its topic ID (0 outside topics)" },
  },
  async run({ args }) {
    const paths = workspacePaths();
    const config = await loadConfig(paths);
    if (!config) throw new Error("This workspace is not initialized.");
    const validate = (value: unknown): string | undefined => {
      if (value === undefined) return undefined;
      if (!/^-?\d+$/.test(String(value))) throw new Error(`Invalid Telegram ID: ${value}`);
      return String(value);
    };
    const allowUser = validate(args.allowUser);
    const allowChat = validate(args.allowChat);
    const removeUser = validate(args.removeUser);
    const removeChat = validate(args.removeChat);
    const controlChat = validate(args.controlChat);
    const controlTopic = validate(args.controlTopic);
    if (allowUser && !config.access.userIds.includes(allowUser)) config.access.userIds.push(allowUser);
    if (allowChat && !config.access.chatIds.includes(allowChat)) config.access.chatIds.push(allowChat);
    if (removeUser) config.access.userIds = config.access.userIds.filter((id) => id !== removeUser);
    if (removeChat) config.access.chatIds = config.access.chatIds.filter((id) => id !== removeChat);
    if (controlChat) config.controlChat.chatId = controlChat;
    if (controlTopic) config.controlChat.topicId = controlTopic;
    if (config.access.userIds.length + config.access.chatIds.length === 0) {
      throw new Error("The allowlist cannot be empty.");
    }
    if (allowUser || allowChat || removeUser || removeChat || controlChat || controlTopic) {
      const release = await acquireRuntimeLock(paths, config.activeBotId);
      try {
        if (controlChat) {
          const token = tokenFromEnvironment() ?? await getBotToken(config.activeBotId);
          if (!token) throw new Error("Telegram bot token is missing. Run tgfx auth.");
          await new TelegramApi(token).api.getChat(controlChat);
        }
        await saveConfig(paths, config);
      } finally { await release(); }
    }
    console.log(JSON.stringify(config.access, null, 2));
  },
});

const adminCommand = defineCommand({
  meta: { name: "admin", description: "Show or configure opt-in group administration" },
  args: {
    chat: { type: "string", description: "Admin-enabled group chat ID" },
    capabilities: { type: "string", description: "Comma-separated: pins,topics,delete_messages,moderation,join_requests" },
    disable: { type: "boolean", description: "Disable all admin actions" },
  },
  async run({ args }) {
    const paths = workspacePaths();
    const config = await loadConfig(paths);
    if (!config) throw new Error("This workspace is not initialized.");
    const changing = Boolean(args.disable || args.chat || args.capabilities);
    if (changing) {
      const release = await acquireRuntimeLock(paths, config.activeBotId);
      try {
        if (args.disable) config.admin = { chatIds: [], capabilities: [] };
        else {
          if (!args.chat || !/^-?\d+$/.test(args.chat)) throw new Error("--chat must be a decimal group ID.");
          if (!config.access.chatIds.includes(args.chat)) throw new Error("Admin chat must first be allowed with tgfx access --allow-chat.");
          const allowed = new Set(["pins", "topics", "delete_messages", "moderation", "join_requests"]);
          const capabilities = (args.capabilities ?? "").split(",").filter(Boolean);
          if (capabilities.some((value) => !allowed.has(value))) throw new Error("Unknown admin capability.");
          const token = tokenFromEnvironment() ?? await getBotToken(config.activeBotId);
          if (!token) throw new Error("Telegram bot token is missing. Run tgfx auth.");
          const telegram = new TelegramApi(token);
          const member = await telegram.api.getChatMember(args.chat, Number(config.activeBotId));
          if (member.status !== "administrator" && member.status !== "creator") {
            throw new Error("The bot is not an administrator in that chat.");
          }
          if (member.status === "administrator") {
            const rights: Record<string, boolean | undefined> = {
              pins: member.can_pin_messages,
              topics: member.can_manage_topics,
              delete_messages: member.can_delete_messages,
              moderation: member.can_restrict_members,
              join_requests: member.can_invite_users,
            };
            const missing = capabilities.filter((capability) => !rights[capability]);
            if (missing.length) throw new Error(`The bot lacks Telegram rights for: ${missing.join(", ")}`);
          }
          config.admin = { chatIds: [args.chat], capabilities: capabilities as TgfxConfig["admin"]["capabilities"] };
        }
        await saveConfig(paths, config);
      } finally {
        await release();
      }
    }
    console.log(JSON.stringify(config.admin, null, 2));
  },
});

const routesCommand = defineCommand({
  meta: { name: "routes", description: "List this workspace's Telegram to 𝒇x routes" },
  async run() {
    const paths = workspacePaths();
    if (!existsSync(paths.database)) { console.log("No routes yet."); return; }
    const state = new StateStore(paths.database);
    try {
      const routes = state.routes().map((route) => ({
        chat: route.chat_id, topic: route.topic_id, generation: route.generation,
        session: route.session_id ?? "not started",
      }));
      console.log(routes.length ? JSON.stringify(routes, null, 2) : "No routes yet.");
    } finally { state.close(); }
  },
});

const doctorCommand = defineCommand({
  meta: { name: "doctor", description: "Check bot, workspace, SQLite, and 𝒇x prerequisites" },
  async run() {
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
      if (!token) checks.push({ check: "Telegram", ok: false, detail: "bot token missing" });
      else {
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
            const control = await telegram.api.getChat(config.controlChat.chatId);
            checks.push({ check: "control chat", ok: true, detail: `${control.type} ${config.controlChat.chatId}${config.controlChat.topicId === "0" ? "" : `/${config.controlChat.topicId}`}` });
          } catch (error) {
            checks.push({ check: "control chat", ok: false, detail: error instanceof Error ? error.message : String(error) });
          }
          for (const chatId of config.admin.chatIds) {
            try {
              const member = await telegram.api.getChatMember(chatId, Number(bot.id));
              const creator = member.status === "creator";
              const rights: Record<TgfxConfig["admin"]["capabilities"][number], boolean> = {
                pins: creator || (member.status === "administrator" && Boolean(member.can_pin_messages)),
                topics: creator || (member.status === "administrator" && Boolean(member.can_manage_topics)),
                delete_messages: creator || (member.status === "administrator" && Boolean(member.can_delete_messages)),
                moderation: creator || (member.status === "administrator" && Boolean(member.can_restrict_members)),
                join_requests: creator || (member.status === "administrator" && Boolean(member.can_invite_users)),
              };
              const missing = config.admin.capabilities.filter((capability) => !rights[capability]);
              checks.push({
                check: `admin ${chatId}`,
                ok: missing.length === 0,
                detail: missing.length ? `missing rights: ${missing.join(", ")}` : config.admin.capabilities.join(", ") || "no capabilities enabled",
              });
            } catch (error) {
              checks.push({ check: `admin ${chatId}`, ok: false, detail: error instanceof Error ? error.message : String(error) });
            }
          }
        } catch (error) { checks.push({ check: "Telegram", ok: false, detail: error instanceof Error ? error.message : String(error) }); }
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
      try { const state = new StateStore(paths.database); state.close(); checks.push({ check: "SQLite", ok: true, detail: paths.database }); }
      catch (error) { checks.push({ check: "SQLite", ok: false, detail: error instanceof Error ? error.message : String(error) }); }
    }
    for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.check} · ${check.detail}`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  },
});

const mcpCommand = defineCommand({
  meta: { name: "mcp", description: "Internal Telegram MCP stdio server", hidden: true },
  async run() { await runTelegramMcpServer(); },
});

const startArgs = {
  model: { type: "string", description: "Pass the exact model ID to fx acp" },
  streaming: { type: "boolean", description: "Use private-chat rich drafts", negativeDescription: "Send one final message per turn" },
  "collapse-tools": { type: "boolean", description: "Collapse completed tools", negativeDescription: "Show every tool in the timeline" },
  json: { type: "boolean", description: "Print operational logs as JSON" },
  "no-color": { type: "boolean", description: "Disable terminal color" },
} as const;

const startCommand = defineCommand({
  meta: { name: "tgfx", version: VERSION, description: "Run 𝒇x in this folder through one Telegram bot" },
  args: startArgs,
  async run({ args }) {
    if (args.noColor) process.env.NO_COLOR = "1";
    const resolved = await runtime(workspacePaths(), { json: Boolean(args.json) });
    const { release, ...appRuntime } = resolved;
    const raw = process.argv.slice(2);
    const streaming = raw.includes("--streaming") ? true : raw.includes("--no-streaming") ? false : undefined;
    const collapseTools = raw.includes("--collapse-tools") ? true : raw.includes("--no-collapse-tools") ? false : undefined;
    const log = args.json
      ? (message: string) => console.log(JSON.stringify({ ts: new Date().toISOString(), message }))
      : (message: string) => console.log(message);
    let app: TgfxApp | undefined;
    const shutdown = () => void app?.stop();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    try {
      app = new TgfxApp({
        ...appRuntime,
        ...(args.model ? { model: args.model } : {}),
        renderer: {
          ...(streaming === undefined ? {} : { mode: streaming ? "streaming" : "final" }),
          ...(collapseTools === undefined ? {} : { collapseTools }),
        },
        log,
      });
      await app.run();
    }
    finally {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      await app?.stop();
      await release();
      if (args.json) log("Stopped.");
      else outro("Stopped.");
    }
  },
});

const main = defineCommand({
  meta: { name: "tgfx", version: VERSION, description: "Run 𝒇x in this folder through one Telegram bot" },
  args: startArgs,
  subCommands: {
    auth: authCommand,
    access: accessCommand,
    admin: adminCommand,
    routes: routesCommand,
    doctor: doctorCommand,
    mcp: mcpCommand,
  },
});

// MCP stdio owns stdout. Bypass Citty and Clack completely so no terminal UI
// byte can corrupt its newline-delimited JSON-RPC channel.
const requested = process.argv[2];
const subcommands = new Set(["auth", "access", "admin", "routes", "doctor"]);
if (requested === "mcp") await runTelegramMcpServer();
else if (requested === "--help" || requested === "-h" || requested === "--version" || requested === "-v" || (requested && subcommands.has(requested))) {
  await runMain(main);
} else {
  await runMain(startCommand);
}
