import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpath, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import * as z from "zod/v4";
import { StateStore } from "../state";
import { adminCapabilitiesForMember, TelegramApi } from "../telegram/api";
import type { AdminCapability, AttachmentRef } from "../types";
import { safeDownloadPath, safeName, writeResponseLimited } from "./files";

type McpEnvironment = {
  token: string;
  botId: string;
  routeKey: string;
  workspace: string;
  database: string;
  files: string;
  approvalsChat: string;
  approvalsTopic: string;
  allowedChats: string[];
  protectedUsers: string[];
  apiRoot?: string;
  fileRoot?: string;
};

const decimalId = z.string().regex(/^-?\d+$/);

function jsonEnvironment<T>(name: string, schema: z.ZodType<T>, fallback: unknown): T {
  const raw = process.env[name];
  if (raw === undefined) return schema.parse(fallback);
  try {
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`Invalid internal tgfx MCP environment: ${name}`, { cause: error });
  }
}

function environment(): McpEnvironment {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing internal tgfx MCP environment: ${name}`);
    return value;
  };
  const botId = decimalId.parse(required("TGFX_MCP_BOT_ID"));
  const routeKey = required("TGFX_MCP_ROUTE_KEY");
  if (!routeKey.startsWith(`${botId}:`)) {
    throw new Error("Invalid internal tgfx MCP environment: route does not belong to bot");
  }
  return {
    token: required("TGFX_MCP_TOKEN"),
    botId,
    routeKey,
    workspace: resolve(required("TGFX_MCP_WORKSPACE")),
    database: resolve(required("TGFX_MCP_DATABASE")),
    files: resolve(required("TGFX_MCP_FILES")),
    approvalsChat: decimalId.parse(required("TGFX_MCP_APPROVALS_CHAT")),
    approvalsTopic: decimalId.parse(process.env.TGFX_MCP_APPROVALS_TOPIC ?? "0"),
    allowedChats: jsonEnvironment("TGFX_MCP_ALLOWED_CHATS", z.array(decimalId), []),
    protectedUsers: jsonEnvironment("TGFX_MCP_PROTECTED_USERS", z.array(decimalId), []),
    ...(process.env.TGFX_INTERNAL_TELEGRAM_API_ROOT
      ? { apiRoot: process.env.TGFX_INTERNAL_TELEGRAM_API_ROOT }
      : {}),
    ...(process.env.TGFX_INTERNAL_TELEGRAM_FILE_ROOT
      ? { fileRoot: process.env.TGFX_INTERNAL_TELEGRAM_FILE_ROOT }
      : {}),
  };
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function effectKey(routeKey: string, contextRef: string, tool: string, args: unknown): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify({ routeKey, contextRef, tool, args }))
    .digest("hex");
}

export async function runTelegramMcpServer(): Promise<void> {
  const env = environment();
  const workspaceRoot = await realpath(env.workspace);
  const state = new StateStore(env.database);
  const telegram = new TelegramApi(env.token, env.apiRoot);
  const routeChatId = env.routeKey.split(":")[1] ?? "";
  // Admin needs no tgfx-side configuration: for an allowlisted group chat the
  // available admin tools are exactly the bot's live Telegram admin rights.
  // Promotion in Telegram is the consent; demotion is the revocation.
  const liveAdminCapabilities = async (): Promise<Set<AdminCapability>> => {
    if (!env.allowedChats.includes(routeChatId) || Number(routeChatId) >= 0) {
      return new Set<AdminCapability>();
    }
    return adminCapabilitiesForMember(
      await telegram.api.getChatMember(routeChatId, Number(env.botId)),
    );
  };
  const grantedAdminCapabilities = new Set<AdminCapability>();
  if (env.allowedChats.includes(routeChatId) && Number(routeChatId) < 0) {
    try {
      for (const capability of await liveAdminCapabilities()) grantedAdminCapabilities.add(capability);
    } catch (error) {
      console.error(`tgfx MCP could not verify Telegram admin rights: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const adminEnabled = (capability: AdminCapability) => grantedAdminCapabilities.has(capability);
  const server = new McpServer(
    { name: "tgfx-telegram", version: "0.1.0" },
    { instructions: [
      "The user's Telegram message is supplied separately in a telegram_message JSON envelope.",
      "Your normal assistant response is automatically sent as the reply to that message.",
      "References are scoped capabilities. Never invent Telegram IDs, file URLs, or local paths.",
      "Download an attachment before claiming to inspect or modify it.",
      "Use admin tools only when the user's current message explicitly asks for that action.",
    ].join(" ") },
  );

  const context = () => {
    const value = state.activeContext(env.routeKey);
    if (!value) throw new Error("The Telegram context capability expired or no turn is active.");
    if (value.bot_id !== env.botId || value.route_key !== env.routeKey) {
      throw new Error("Telegram context capability is outside this route.");
    }
    return value;
  };

  const perform = async <T>(tool: string, args: unknown, operation: () => Promise<T>): Promise<T> => {
    const current = context();
    const key = effectKey(env.routeKey, current.context_ref, tool, args);
    const status = state.beginEffect({ effectKey: key, botId: env.botId, routeKey: env.routeKey, toolName: tool });
    if (status === "complete") return state.effectResult(key) as T;
    if (status === "unknown") {
      throw new Error("The previous attempt has an unknown outcome. Ask the user before trying this action again.");
    }
    try {
      const value = await operation();
      state.completeEffect(key, value);
      return value;
    } catch (error) {
      state.failEffect(key, error instanceof Error ? error.message : String(error), true);
      throw error;
    }
  };

  const requireAdmin = async (capability: AdminCapability, prompt: string): Promise<void> => {
    const current = context();
    if (!env.allowedChats.includes(current.chat_id)) throw new Error("Admin tools are disabled for this chat.");
    if (!(await liveAdminCapabilities()).has(capability)) {
      throw new Error(`The bot does not have Telegram admin rights for '${capability}'.`);
    }
    const id = crypto.randomUUID().replaceAll("-", "");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    state.createInteraction({
      id, botId: env.botId, routeKey: env.routeKey, kind: `telegram_admin:${capability}`,
      payload: { prompt, options: ["approve", "deny"] }, expiresAt,
    });
    let card;
    try {
      card = await telegram.sendText(env.approvalsChat, `Approval required\n\n${prompt}`, env.approvalsTopic, {
        reply_markup: { inline_keyboard: [[
          { text: "Approve", callback_data: `mcp:${id}:approve` },
          { text: "Deny", callback_data: `mcp:${id}:deny` },
        ]] },
      });
    } catch (error) {
      state.expireInteraction(id);
      throw error;
    }
    while (Date.now() < Date.parse(expiresAt)) {
      const approval = state.interaction(id);
      if (approval?.state === "resolved" && approval.result_json) {
        if (JSON.parse(approval.result_json) === "approve") return;
        throw new Error("The Telegram administrator denied this action.");
      }
      await Bun.sleep(400);
    }
    if (state.expireInteraction(id)) {
      await telegram.editReplyMarkup(env.approvalsChat, card.message_id, {
        inline_keyboard: [[{ text: "Expired", callback_data: "resolved" }]],
      }).catch(() => undefined);
    }
    throw new Error("The Telegram administrator did not answer before the approval expired.");
  };

  server.registerTool("set_reaction", {
    title: "React to a Telegram message",
    description: "Set one emoji reaction on the current message or a valid message_ref from this route.",
    inputSchema: {
      emoji: z.string().min(1).max(16),
      message_ref: z.string().optional().describe("Omit to react to the current message"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (args) => result(await perform("telegram_set_reaction", args, async () => {
    const current = context();
    const target = args.message_ref
      ? state.messageReference(args.message_ref, env.routeKey)
      : state.messageReference(current.message_ref, env.routeKey);
    if (!target) throw new Error("Unknown or expired message_ref for this route.");
    await telegram.api.setMessageReaction(target.chat_id, Number(target.message_id), [
      { type: "emoji", emoji: args.emoji as never },
    ]);
    return { reacted: true, message_ref: target.ref, emoji: args.emoji };
  })));

  server.registerTool("download_attachment", {
    title: "Download Telegram attachment",
    description: "Download an attachment_ref from the current Telegram turn into this workspace. Use this before claiming to inspect or modify a file.",
    inputSchema: { attachment_ref: z.string(), filename: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (args) => result(await perform("telegram_download_attachment", args, async () => {
    const current = context();
    const attachments = JSON.parse(current.attachments_json) as AttachmentRef[];
    const attachment = attachments.find((candidate) => candidate.ref === args.attachment_ref);
    if (!attachment) throw new Error("Unknown or expired attachment_ref for this turn.");
    const maxBytes = 20 * 1024 * 1024;
    if (attachment.size !== undefined && attachment.size > maxBytes) {
      throw new Error("This attachment exceeds Telegram's 20 MB cloud download limit.");
    }
    const file = await telegram.api.getFile(attachment.fileId);
    if (!file.file_path) throw new Error("Telegram did not return a downloadable path for this attachment.");
    const filename = safeName(args.filename ?? attachment.name ?? basename(file.file_path));
    const path = await safeDownloadPath(env.files, current.context_ref, filename);
    const fileRoot = env.fileRoot ?? `https://api.telegram.org/file/bot${env.token}`;
    const response = await fetch(`${fileRoot}/${file.file_path}`);
    const bytes = await writeResponseLimited(response, path, maxBytes);
    return { downloaded: true, path, bytes, mime_type: attachment.mimeType };
  })));

  server.registerTool("send_file", {
    title: "Send workspace file",
    description: "Upload a file located inside the current workspace to the current Telegram chat.",
    inputSchema: {
      path: z.string().describe("Absolute path or workspace-relative path"),
      caption: z.string().max(1024).optional(),
      filename: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (args) => result(await perform("telegram_send_file", args, async () => {
    const current = context();
    const candidate = resolve(workspaceRoot, args.path);
    const resolvedPath = await realpath(candidate);
    if (resolvedPath !== workspaceRoot && !resolvedPath.startsWith(`${workspaceRoot}${sep}`)) {
      throw new Error("Only files inside the current workspace may be sent.");
    }
    const runtimeDirectory = resolve(workspaceRoot, ".tgfx");
    const filesDirectory = resolve(runtimeDirectory, "files");
    const insideRuntime = resolvedPath === runtimeDirectory || resolvedPath.startsWith(`${runtimeDirectory}${sep}`);
    const insideFiles = resolvedPath === filesDirectory || resolvedPath.startsWith(`${filesDirectory}${sep}`);
    if (insideRuntime && !insideFiles) throw new Error("Private .tgfx runtime files cannot be sent.");
    const info = await stat(resolvedPath);
    if (!info.isFile()) throw new Error("Only a regular workspace file may be sent.");
    if (info.size > 50 * 1024 * 1024) throw new Error("This file exceeds Telegram's 50 MB cloud upload limit.");
    const sent = await telegram.sendFile(
      current.chat_id, resolvedPath, safeName(args.filename ?? basename(resolvedPath)), args.caption, current.topic_id,
    );
    const reference = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
    state.registerBotMessage({
      ref: reference, botId: env.botId, routeKey: env.routeKey, chatId: current.chat_id,
      topicId: current.topic_id, messageId: String(sent.message_id),
    });
    return { sent: true, message_ref: reference };
  })));

  server.registerTool("request_choice", {
    title: "Ask Telegram user to choose",
    description: "Send an inline-keyboard question. The click arrives later as a new Telegram turn; this call returns an interaction_ref immediately.",
    inputSchema: {
      question: z.string().min(1).max(1000),
      options: z.array(z.string().min(1).max(64)).min(2).max(8),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (args) => result(await perform("telegram_request_choice", args, async () => {
    const current = context();
    const id = crypto.randomUUID().replaceAll("-", "");
    state.createInteraction({
      id, botId: env.botId, routeKey: env.routeKey, kind: "choice", payload: args,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    const sent = await telegram.sendText(current.chat_id, args.question, current.topic_id, {
      reply_markup: { inline_keyboard: args.options.map((label, index) => [{
        text: label, callback_data: `choice:${id}:${index}`,
      }]) },
    });
    const messageRef = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
    state.registerBotMessage({
      ref: messageRef, botId: env.botId, routeKey: env.routeKey,
      chatId: current.chat_id, topicId: current.topic_id, messageId: String(sent.message_id),
    });
    return { sent: true, interaction_ref: `interaction_${id}`, message_ref: messageRef };
  })));

  server.registerTool("create_poll", {
    title: "Create Telegram poll",
    description: "Create a poll in the current Telegram chat. Votes arrive later as Telegram events.",
    inputSchema: {
      question: z.string().min(1).max(300),
      options: z.array(z.string().min(1).max(100)).min(2).max(12),
      anonymous: z.boolean().default(false),
      multiple: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (args) => result(await perform("telegram_create_poll", args, async () => {
    const current = context();
    const sent = await telegram.api.sendPoll(current.chat_id, args.question, args.options, {
      is_anonymous: args.anonymous, allows_multiple_answers: args.multiple,
      ...(current.topic_id === "0" ? {} : { message_thread_id: Number(current.topic_id) }),
    });
    const interactionId = crypto.randomUUID().replaceAll("-", "");
    const messageRef = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
    state.registerBotMessage({
      ref: messageRef, botId: env.botId, routeKey: env.routeKey,
      chatId: current.chat_id, topicId: current.topic_id, messageId: String(sent.message_id),
    });
    state.createInteraction({
      id: interactionId, botId: env.botId, routeKey: env.routeKey, kind: "poll",
      payload: {
        pollId: sent.poll.id, messageId: String(sent.message_id), messageRef, question: args.question,
        options: args.options, anonymous: args.anonymous,
      },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    return { sent: true, poll_ref: `interaction_${interactionId}`, message_ref: messageRef };
  })));

  const setPinnedMessage = server.registerTool("set_pinned_message", {
    title: "Set managed pinned message",
    description: "Create or replace tgfx's single managed bulletin in this admin chat and pin it. Requires approval.",
    inputSchema: { text: z.string().min(1).max(4000) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (args) => result(await perform("telegram_set_pinned_message", args, async () => {
    const current = context();
    await requireAdmin("pins", `Set the managed pinned message in chat ${current.chat_id}?`);
    const existing = state.db.query<{ message_ref: string }, [string, string]>(
      "SELECT message_ref FROM managed_pins WHERE bot_id=? AND route_key=?",
    ).get(env.botId, env.routeKey);
    let messageId: number;
    let messageRef: string;
    const reference = existing && state.managedMessageReference(existing.message_ref, env.routeKey);
    if (reference?.owned_by_bot) {
      await telegram.api.editMessageText(current.chat_id, Number(reference.message_id), args.text);
      messageId = Number(reference.message_id);
      messageRef = reference.ref;
    } else {
      const sent = await telegram.sendText(current.chat_id, args.text, current.topic_id);
      messageId = sent.message_id;
      messageRef = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
      state.registerBotMessage({
        ref: messageRef, botId: env.botId, routeKey: env.routeKey, chatId: current.chat_id,
        topicId: current.topic_id, messageId: String(messageId),
      });
    }
    await telegram.api.pinChatMessage(current.chat_id, messageId, { disable_notification: true });
    state.db.query(`
      INSERT INTO managed_pins(bot_id,route_key,message_ref,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(bot_id,route_key) DO UPDATE SET message_ref=excluded.message_ref,updated_at=excluded.updated_at
    `).run(env.botId, env.routeKey, messageRef, new Date().toISOString());
    return { pinned: true, message_ref: messageRef };
  })));
  if (!adminEnabled("pins")) setPinnedMessage.disable();

  const pinMessage = server.registerTool("pin_message", {
    title: "Pin referenced message",
    description: "Pin a message_ref from this route. Requires admin capability and approval.",
    inputSchema: { message_ref: z.string(), silent: z.boolean().default(true) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (args) => result(await perform("telegram_pin_message", args, async () => {
    const target = state.messageReference(args.message_ref, env.routeKey);
    if (!target) throw new Error("Unknown or expired message_ref.");
    await requireAdmin("pins", "Pin the referenced Telegram message?");
    await telegram.api.pinChatMessage(target.chat_id, Number(target.message_id), { disable_notification: args.silent });
    return { pinned: true, message_ref: target.ref };
  })));
  if (!adminEnabled("pins")) pinMessage.disable();

  const unpinMessage = server.registerTool("unpin_message", {
    title: "Unpin referenced message",
    description: "Unpin a message_ref from this route. Requires admin capability and approval.",
    inputSchema: { message_ref: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (args) => result(await perform("telegram_unpin_message", args, async () => {
    const target = state.messageReference(args.message_ref, env.routeKey);
    if (!target) throw new Error("Unknown or expired message_ref.");
    await requireAdmin("pins", "Unpin the referenced Telegram message?");
    await telegram.api.unpinChatMessage(target.chat_id, Number(target.message_id));
    return { unpinned: true, message_ref: target.ref };
  })));
  if (!adminEnabled("pins")) unpinMessage.disable();

  const manageTopic = server.registerTool("manage_topic", {
    title: "Manage forum topic",
    description: "Create, rename, close, or reopen a forum topic in the current admin group. Creation requires approval.",
    inputSchema: {
      action: z.enum(["create", "rename", "close", "reopen"]),
      name: z.string().min(1).max(128).optional(),
      topic_id: z.string().regex(/^\d+$/).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (args) => result(await perform("telegram_manage_topic", args, async () => {
    const current = context();
    if (args.action === "create") await requireAdmin("topics", `Create forum topic “${args.name ?? ""}”?`);
    else if (!env.allowedChats.includes(current.chat_id)
      || !(await liveAdminCapabilities()).has("topics")) {
      throw new Error("Topic administration is disabled for this chat.");
    }
    if (args.action === "create") {
      if (!args.name) throw new Error("name is required for create.");
      const topic = await telegram.api.createForumTopic(current.chat_id, args.name);
      return { created: true, topic_id: String(topic.message_thread_id) };
    }
    const topicId = Number(args.topic_id ?? current.topic_id);
    if (!topicId) throw new Error("topic_id is required outside a topic.");
    if (args.action === "rename") {
      if (!args.name) throw new Error("name is required for rename.");
      await telegram.api.editForumTopic(current.chat_id, topicId, { name: args.name });
    } else if (args.action === "close") await telegram.api.closeForumTopic(current.chat_id, topicId);
    else await telegram.api.reopenForumTopic(current.chat_id, topicId);
    return { updated: true, action: args.action, topic_id: String(topicId) };
  })));
  if (!adminEnabled("topics")) manageTopic.disable();

  const deleteMessages = server.registerTool("delete_messages", {
    title: "Delete Telegram messages",
    description: "Delete up to 100 referenced messages from this route. Destructive and always requires approval.",
    inputSchema: { message_refs: z.array(z.string()).min(1).max(100) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async (args) => result(await perform("telegram_delete_messages", args, async () => {
    const targets = args.message_refs.map((reference) => state.messageReference(reference, env.routeKey));
    if (targets.some((target) => !target)) throw new Error("One or more message_refs are unknown or expired.");
    await requireAdmin("delete_messages", `Delete ${targets.length} Telegram message(s)?`);
    const current = context();
    await telegram.api.deleteMessages(current.chat_id, targets.map((target) => Number(target!.message_id)));
    return { deleted: true, count: targets.length };
  })));
  if (!adminEnabled("delete_messages")) deleteMessages.disable();

  const moderateMember = server.registerTool("moderate_member", {
    title: "Moderate Telegram member",
    description: "Ban, unban, restrict, or restore a member_ref from this route. Destructive actions require approval.",
    inputSchema: {
      member_ref: z.string(),
      action: z.enum(["ban", "unban", "restrict", "restore"]),
      until: z.number().int().optional().describe("Unix timestamp for temporary ban/restriction"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async (args) => result(await perform("telegram_moderate_member", args, async () => {
    const current = context();
    const principal = state.principal(args.member_ref, env.routeKey);
    if (!principal || principal.principal_kind !== "user") throw new Error("Unknown or expired member_ref.");
    if (env.protectedUsers.includes(principal.telegram_id)) {
      throw new Error("This member is protected by the workspace access policy.");
    }
    await requireAdmin("moderation", `${args.action} the referenced Telegram member?`);
    const userId = Number(principal.telegram_id);
    if (args.action === "ban") await telegram.api.banChatMember(current.chat_id, userId, { until_date: args.until });
    else if (args.action === "unban") await telegram.api.unbanChatMember(current.chat_id, userId, { only_if_banned: true });
    else if (args.action === "restrict") {
      await telegram.api.restrictChatMember(
        current.chat_id, userId, { can_send_messages: false }, { until_date: args.until },
      );
    } else {
      await telegram.api.restrictChatMember(current.chat_id, userId, {
          can_send_messages: true, can_send_audios: true, can_send_documents: true,
          can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
          can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
          can_add_web_page_previews: true, can_change_info: false, can_invite_users: true,
          can_pin_messages: false, can_manage_topics: false,
      });
    }
    return { moderated: true, action: args.action, member_ref: args.member_ref };
  })));
  if (!adminEnabled("moderation")) moderateMember.disable();

  const reviewJoinRequest = server.registerTool("review_join_request", {
    title: "Review chat join request",
    description: "Approve or decline a join-request member_ref. Declining is destructive and requires approval.",
    inputSchema: { request_ref: z.string(), decision: z.enum(["approve", "decline"]) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async (args) => result(await perform("telegram_review_join_request", args, async () => {
    const current = context();
    if (!args.request_ref.startsWith("join_")) throw new Error("Unknown or expired request_ref.");
    const request = state.interaction(args.request_ref.slice("join_".length));
    if (!request || request.route_key !== env.routeKey || request.kind !== "join_request" || request.state !== "pending") {
      throw new Error("Unknown or expired request_ref.");
    }
    const payload = JSON.parse(request.payload_json) as { memberRef: string };
    const principal = state.principal(payload.memberRef, env.routeKey);
    if (!principal || principal.principal_kind !== "user") throw new Error("Unknown or expired member_ref.");
    if (args.decision === "decline") await requireAdmin("join_requests", "Decline this Telegram join request?");
    else if (!(await liveAdminCapabilities()).has("join_requests")) {
      throw new Error("Join-request administration is disabled.");
    }
    const userId = Number(principal.telegram_id);
    if (args.decision === "approve") await telegram.api.approveChatJoinRequest(current.chat_id, userId);
    else await telegram.api.declineChatJoinRequest(current.chat_id, userId);
    state.resolveInteraction(request.interaction_id, { decision: args.decision });
    return { reviewed: true, decision: args.decision, request_ref: args.request_ref };
  })));
  if (!adminEnabled("join_requests")) reviewJoinRequest.disable();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => { finish = resolve; });
  const stop = async () => { finish(); state.close(); await server.close(); };
  process.stdin.once("end", finish);
  process.stdin.once("close", finish);
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  await closed;
}
