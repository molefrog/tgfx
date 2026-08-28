import type * as acp from "@agentclientprotocol/sdk";
import { fileURLToPath } from "node:url";
import type { BotCommand, CallbackQuery, InputRichMessageWithoutUpload, Update } from "grammy/types";
import { FxRouteSession, type FxPermissionMode } from "./fx/acp";
import { AcpProjector } from "./fx/projector";
import { isFxUsagePeriod, readFxUsage, type FxUsagePeriod } from "./fx/usage";
import { StateStore, type InboxRow } from "./state";
import { adminCapabilitiesForMember, TelegramApi, TelegramError } from "./telegram/api";
import { costReport, type CostReportView } from "./telegram/cost-report";
import { PeerDraftLimiter } from "./telegram/draft-scheduler";
import {
  closedModelPicker,
  failedModelSelection,
  modelPicker,
  providerIconsFromStickerSet,
  providerPicker,
  selectedModel,
  type ModelPickerData,
  type ModelPickerView,
  type ProviderIconMap,
} from "./telegram/model-picker";
import {
  createDraftId,
  isRetryableTelegramError,
  recoverOutbox,
  streamsRoute,
  TurnRenderer,
} from "./telegram/renderer";
import { redactSecrets } from "./secrets";
import {
  commandFromText,
  groupMigrationFromUpdate,
  isAuthorized,
  normalizeMessageUpdate,
  shouldInvokeAgent,
  toEnvelope,
} from "./telegram/normalize";
import type {
  AdminCapability,
  BotIdentity,
  InboundMessage,
  Route,
  SenderIdentity,
  TgfxConfig,
} from "./types";
import { routeKey } from "./types";
import { pruneWorkspaceFiles, saveConfig, type WorkspacePaths } from "./config";

const COMMANDS: BotCommand[] = [{
  command: "compact",
  description: "Compact the 𝒇x conversation",
}, {
  command: "model",
  description: "Choose the 𝒇x model",
}, {
  command: "cost",
  description: "Show local 𝒇x usage and spend",
}];
const THINKING_EMOJI = {
  type: "custom_emoji" as const,
  custom_emoji_id: "5573473356579078196",
  alternative_text: "🙂",
};
const COMPACTING_DRAFT: InputRichMessageWithoutUpload = {
  blocks: [{ type: "thinking", text: [THINKING_EMOJI, " Compacting conversation..."] }],
};
const COMPACTING_MESSAGE: InputRichMessageWithoutUpload = {
  blocks: [{ type: "paragraph", text: [THINKING_EMOJI, " Compacting conversation..."] }],
};
const COMPACTED_MESSAGE: InputRichMessageWithoutUpload = {
  blocks: [{ type: "paragraph", text: "✓ Conversation compacted" }],
};
const PROVIDER_ICON_PACK = "ai_provider_labs_by_fxharness_bot";

type StopCapableUpdate = Update & {
  stopped_message_generation?: {
    chat: { id: number };
    message_thread_id?: number;
    draft_id: number;
  };
};

type PersistedPayload =
  | { kind: "message"; message: InboundMessage }
  | { kind: "callback"; update: Update; route: Route }
  | { kind: "poll_answer"; update: Update; route: Route }
  | { kind: "join_request"; update: Update; route: Route }
  | { kind: "migration"; update: Update; route: Route; oldChatId: string; newChatId: string };

type PermissionWaiter = {
  options: acp.PermissionOption[];
  messageId: number;
  routeKey: string;
  resolve(value: acp.RequestPermissionResponse): void;
};

function uuid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function hydrateMessage(message: InboundMessage): InboundMessage {
  return { ...message, timestamp: new Date(message.timestamp) };
}

function senderFromCallback(callback: CallbackQuery): SenderIdentity {
  const user = callback.from;
  return {
    kind: "user",
    id: String(user.id),
    ref: uuid("usr"),
    displayName: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Telegram user",
    ...(user.username ? { username: user.username } : {}),
    ...(user.language_code ? { languageCode: user.language_code } : {}),
    isBot: user.is_bot,
  };
}

function makePrompt(
  message: InboundMessage,
  textOverride?: string,
  adminContext?: Record<string, unknown>,
): acp.ContentBlock[] {
  const envelope = toEnvelope(message) as { telegram_message: Record<string, unknown> };
  if (adminContext) envelope.telegram_message.admin_context = adminContext;
  const blocks: acp.ContentBlock[] = [{
    type: "text",
    text: JSON.stringify(envelope, null, 2),
  }];
  const text = textOverride ?? message.text;
  if (text?.trim()) blocks.push({ type: "text", text });
  return blocks;
}

export type TgfxLogEvent = { event: string; message: string } & Record<string, unknown>;

export class TgfxApp {
  private readonly state: StateStore;
  private readonly sessions = new Map<string, FxRouteSession>();
  private readonly queueTails = new Map<string, Promise<void>>();
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly activeDraftIds = new Map<string, number>();
  private readonly draftLimiters = new Map<string, PeerDraftLimiter>();
  private readonly permissionWaiters = new Map<string, PermissionWaiter>();
  private readonly albums = new Map<string, { ids: number[]; timer: ReturnType<typeof setTimeout> }>();
  private readonly pollAbort = new AbortController();
  private readonly config: TgfxConfig;
  private customModelIconsEnabled: boolean;
  private providerIcons?: Promise<ProviderIconMap>;
  private pollTask?: Promise<void>;
  private stopping = false;
  private stopTask?: Promise<void>;
  private stopSignal!: () => void;
  private readonly stopped = new Promise<void>((resolve) => { this.stopSignal = resolve; });

  constructor(private readonly options: {
    config: TgfxConfig;
    paths: WorkspacePaths;
    token: string;
    bot: BotIdentity;
    telegram: TelegramApi;
    fxBinary: string;
    model?: string;
    permissionMode?: FxPermissionMode;
    renderer?: Partial<TgfxConfig["renderer"]>;
    log?: (event: TgfxLogEvent) => void;
  }) {
    this.config = options.config;
    this.customModelIconsEnabled = options.config.modelPicker?.customIcons ?? true;
    this.state = new StateStore(options.paths.database);
    this.state.ensurePollState(options.bot.id);
  }

  private log(input: string | TgfxLogEvent): void {
    const event = typeof input === "string" ? { event: "log", message: input } : input;
    (this.options.log ?? ((value: TgfxLogEvent) => console.log(value.message)))(event);
  }

  private label(chatId: string, topicId = "0"): string {
    return topicId === "0" ? chatId : `${chatId}/${topicId}`;
  }

  async run(): Promise<void> {
    const webhook = await this.options.telegram.getWebhookInfo();
    if (webhook.url) throw new Error("This bot has a webhook configured. Remove it before using tgfx long polling.");
    await recoverOutbox(this.options.telegram, this.state);
    this.state.prune();
    await pruneWorkspaceFiles(this.options.paths);
    await this.installInitialMenus();
    const recovery = this.state.recoverInbox();
    if (recovery.interrupted) {
      await this.options.telegram.sendText(
        this.config.approvals.chatId,
        `${recovery.interrupted} accepted 𝒇x turn${recovery.interrupted === 1 ? " was" : "s were"} interrupted by the previous process and was not replayed automatically. Send the request again if you want to retry it; earlier side effects may already exist.`,
        this.config.approvals.topicId,
      ).catch(() => undefined);
    }
    for (const row of recovery.received) {
      const payload = row.payload_json ? JSON.parse(row.payload_json) as PersistedPayload : undefined;
      const mediaGroupId = payload?.kind === "message"
        ? String(payload.message.provenance?.media_group_id ?? "")
        : "";
      if (mediaGroupId) this.scheduleAlbum(row.id, row.route_key, mediaGroupId, 0);
      else this.enqueue(row.id, row.route_key);
    }
    this.log({
      event: "polling.started",
      message: `@${this.options.bot.username ?? this.options.bot.id} · polling · ${this.options.paths.workspace} · ${this.rendererConfig.mode}${this.rendererConfig.collapseTools ? " · collapsed tools" : " · visible tools"}`,
      bot: this.options.bot.id,
      workspace: this.options.paths.workspace,
      renderer: this.rendererConfig.mode,
    });
    this.pollTask = this.poll();
    await Promise.race([this.pollTask, this.stopped]);
  }

  private get rendererConfig(): TgfxConfig["renderer"] {
    return { ...this.config.renderer, ...this.options.renderer };
  }

  private draftLimiter(chatId: string): PeerDraftLimiter {
    let limiter = this.draftLimiters.get(chatId);
    if (!limiter) {
      limiter = new PeerDraftLimiter({ minGapMs: this.rendererConfig.updateEveryMs });
      this.draftLimiters.set(chatId, limiter);
    }
    return limiter;
  }

  stop(): Promise<void> {
    if (!this.stopTask) this.stopTask = this.stopOnce();
    return this.stopTask;
  }

  private async stopOnce(): Promise<void> {
    this.stopping = true;
    this.stopSignal();
    this.pollAbort.abort(new Error("tgfx is stopping"));
    for (const album of this.albums.values()) clearTimeout(album.timer);
    this.albums.clear();
    for (const controller of this.activeTurns.values()) controller.abort(new Error("tgfx is stopping"));
    this.activeDraftIds.clear();
    const expiredCards: Promise<unknown>[] = [];
    for (const [id, waiter] of this.permissionWaiters) {
      const reject = waiter.options.find((option) => option.kind === "reject_once")
        ?? waiter.options.find((option) => option.kind === "reject_always");
      this.state.expireInteraction(id);
      expiredCards.push(this.options.telegram.editReplyMarkup(
        this.config.approvals.chatId,
        waiter.messageId,
        { inline_keyboard: [[{ text: "Cancelled · tgfx stopped", callback_data: "resolved" }]] },
      ).catch(() => undefined));
      waiter.resolve(reject
        ? { outcome: { outcome: "selected", optionId: reject.optionId } }
        : { outcome: { outcome: "cancelled" } });
    }
    this.permissionWaiters.clear();
    await Promise.allSettled(expiredCards);
    // `run()` may have returned through the stop signal while `poll()` was
    // finishing one accepted update. Let that code leave the state boundary
    // before taking a queue snapshot or closing SQLite.
    await this.pollTask?.catch(() => undefined);
    const queued = Promise.allSettled([...this.queueTails.values()]);
    // Give cooperative ACP cancellation a short head start, then terminate the
    // child processes so Ctrl-C cannot hang behind an unresponsive agent/tool.
    await Promise.race([queued, Bun.sleep(3_000)]);
    await Promise.allSettled([...this.sessions.values()].map((session) => session.dispose()));
    await queued;
    const menuChats = new Set([
      ...this.config.access.chatIds,
      ...this.config.access.userIds,
      ...this.state.routes().filter((route) => route.bot_id === this.options.bot.id).map((route) => route.chat_id),
    ]);
    await Promise.allSettled([...menuChats].map((chatId) => this.options.telegram.deleteCommands(chatId)));
    this.state.close();
  }

  private async poll(): Promise<void> {
    let backoff = 500;
    while (!this.stopping) {
      try {
        const updates = await this.options.telegram.getUpdates(
          this.state.nextOffset(this.options.bot.id), 25, this.pollAbort.signal,
        );
        backoff = 500;
        for (const update of updates) await this.accept(update);
      } catch (error) {
        if (this.stopping) break;
        if (!isRetryableTelegramError(error)) {
          if (error instanceof TelegramError && error.errorCode === 409) {
            throw new Error(
              "Another process is polling this Telegram bot, possibly on another machine. Stop that poller before starting tgfx.",
              { cause: error },
            );
          }
          throw error;
        }
        this.log(`Telegram poll failed · ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
        await Promise.race([Bun.sleep(backoff), this.stopped]);
        backoff = Math.min(30_000, backoff * 2);
      }
    }
  }

  private async accept(update: Update): Promise<void> {
    const stopped = (update as StopCapableUpdate).stopped_message_generation;
    if (stopped) {
      const chatId = String(stopped.chat.id);
      const topicId = String(stopped.message_thread_id ?? 0);
      const key = routeKey(this.options.bot.id, chatId, topicId);
      const authorized = this.config.access.userIds.includes(chatId)
        || this.config.access.chatIds.includes(chatId);
      const active = this.activeTurns.get(key);
      const matchesActiveDraft = this.activeDraftIds.get(key) === stopped.draft_id;
      this.state.ingestUpdate({
        botId: this.options.bot.id,
        updateId: update.update_id,
        authorized: false,
      });
      if (authorized && active && matchesActiveDraft) {
        active.abort(new Error("Stopped from Telegram draft"));
        await this.sessions.get(key)?.cancel();
      }
      return;
    }

    const migration = groupMigrationFromUpdate(update);
    if (migration) {
      const hasOldRoute = this.state.routes().some((route) =>
        route.bot_id === this.options.bot.id && route.chat_id === migration.oldChatId
      );
      const configuredOld = this.config.access.chatIds.includes(migration.oldChatId)
        || this.config.approvals.chatId === migration.oldChatId;
      // Telegram may deliver both `migrate_to_chat_id` and
      // `migrate_from_chat_id`. Once the first half moved all state and config,
      // the second is an acknowledgement, not a reason to recreate the old route.
      if (!hasOldRoute && !configuredOld) {
        this.state.ingestUpdate({ botId: this.options.bot.id, updateId: update.update_id, authorized: false });
        return;
      }
      const route: Route = {
        key: routeKey(this.options.bot.id, migration.oldChatId, "0"),
        botId: this.options.bot.id,
        chatId: migration.oldChatId,
        topicId: "0",
        chatKind: "group",
      };
      const authorized = this.config.access.chatIds.includes(migration.oldChatId)
        || this.config.access.chatIds.includes(migration.newChatId)
        || (migration.senderId !== undefined
          && this.config.access.userIds.includes(migration.senderId));
      if (authorized) this.state.ensureRoute(route);
      const id = this.state.ingestUpdate({
        botId: this.options.bot.id,
        updateId: update.update_id,
        routeKey: route.key,
        payload: { kind: "migration", update, route, ...migration } satisfies PersistedPayload,
        authorized,
      });
      if (id !== undefined) this.enqueue(id, route.key);
      return;
    }

    const message = normalizeMessageUpdate(
      this.options.bot,
      update,
      (chatId, messageId) => this.state.messageReferenceByTelegramId(
        this.options.bot.id, chatId, messageId,
      )?.ref,
    );
    if (message) {
      const authorized = isAuthorized(this.config, message);
      if (authorized) this.state.ensureRoute(message.route);
      const id = this.state.ingestUpdate({
        botId: this.options.bot.id,
        updateId: update.update_id,
        routeKey: message.route.key,
        payload: { kind: "message", message } satisfies PersistedPayload,
        authorized,
        ...(message.event === "message.edited"
          ? { supersede: { chatId: message.route.chatId, messageId: message.messageId } }
          : {}),
      });
      if (id !== undefined) {
        const mediaGroupId = String(message.provenance?.media_group_id ?? "");
        if (mediaGroupId) this.scheduleAlbum(id, message.route.key, mediaGroupId);
        else this.enqueue(id, message.route.key);
      }
      return;
    }

    const callback = update.callback_query;
    if (callback?.message) {
      const chatId = String(callback.message.chat.id);
      const topicId = String("message_thread_id" in callback.message ? callback.message.message_thread_id ?? 0 : 0);
      const route: Route = {
        key: routeKey(this.options.bot.id, chatId, topicId),
        botId: this.options.bot.id,
        chatId,
        topicId,
        chatKind: callback.message.chat.type,
      };
      const authorized = this.config.access.chatIds.includes(chatId)
        || this.config.access.userIds.includes(String(callback.from.id));
      if (authorized) this.state.ensureRoute(route);
      const id = this.state.ingestUpdate({
        botId: this.options.bot.id,
        updateId: update.update_id,
        routeKey: route.key,
        payload: { kind: "callback", update, route } satisfies PersistedPayload,
        authorized,
      });
      if (id !== undefined) {
        const controlCallback = callback.data?.startsWith("fxp:")
          || callback.data?.startsWith("mcp:");
        if (controlCallback) await this.dispatch(id);
        else this.enqueue(id, route.key);
      }
      return;
    }

    const pollAnswer = update.poll_answer;
    if (pollAnswer) {
      const interaction = this.state.pollInteraction(pollAnswer.poll_id);
      const routeRow = interaction ? this.state.route(interaction.route_key) : undefined;
      if (interaction && routeRow) {
        const route: Route = {
          key: routeRow.route_key, botId: routeRow.bot_id, chatId: routeRow.chat_id,
          topicId: routeRow.topic_id, chatKind: routeRow.chat_kind,
        };
        const actorId = pollAnswer.user?.id ?? pollAnswer.voter_chat?.id;
        const authorized = this.config.access.chatIds.includes(route.chatId)
          || (actorId !== undefined && this.config.access.userIds.includes(String(actorId)));
        const id = this.state.ingestUpdate({
          botId: this.options.bot.id, updateId: update.update_id, routeKey: route.key,
          payload: { kind: "poll_answer", update, route } satisfies PersistedPayload,
          authorized,
        });
        if (id !== undefined) this.enqueue(id, route.key);
        return;
      }
    }

    const joinRequest = update.chat_join_request;
    if (joinRequest) {
      const chatId = String(joinRequest.chat.id);
      const route: Route = {
        key: routeKey(this.options.bot.id, chatId, "0"), botId: this.options.bot.id,
        chatId, topicId: "0", chatKind: joinRequest.chat.type,
      };
      const enabled = this.config.access.chatIds.includes(chatId)
        && await this.hasAdminCapability(chatId, "join_requests");
      if (enabled) this.state.ensureRoute(route);
      const id = this.state.ingestUpdate({
        botId: this.options.bot.id, updateId: update.update_id, routeKey: route.key,
        payload: { kind: "join_request", update, route } satisfies PersistedPayload,
        authorized: enabled,
      });
      if (id !== undefined) this.enqueue(id, route.key);
      return;
    }

    // Unknown, poll-only, or unrouteable updates are acknowledged without retaining payload.
    if (update.message || update.edited_message || update.channel_post || update.edited_channel_post) {
      this.log(`Ignored unsupported Telegram message update ${update.update_id}`);
    }
    this.state.ingestUpdate({
      botId: this.options.bot.id,
      updateId: update.update_id,
      authorized: false,
    });
  }

  private enqueue(inboxId: number, routeKeyValue: string): void {
    const previous = this.queueTails.get(routeKeyValue) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.dispatch(inboxId));
    let tail!: Promise<void>;
    tail = next.finally(() => {
      if (this.queueTails.get(routeKeyValue) === tail) this.queueTails.delete(routeKeyValue);
    });
    this.queueTails.set(routeKeyValue, tail);
  }

  private scheduleAlbum(inboxId: number, routeKeyValue: string, mediaGroupId: string, delay = 750): void {
    const key = `${routeKeyValue}:${mediaGroupId}`;
    const current = this.albums.get(key);
    if (current) {
      current.ids.push(inboxId);
      clearTimeout(current.timer);
    }
    const ids = current?.ids ?? [inboxId];
    const timer = setTimeout(() => {
      this.albums.delete(key);
      const rows = ids.map((id) => this.state.inbox(id)).filter((row): row is InboxRow =>
        Boolean(row?.payload_json && row.status === "received")
      );
      if (!rows.length) return;
      const messages = rows.map((row) => ({
        row,
        payload: JSON.parse(row.payload_json) as Extract<PersistedPayload, { kind: "message" }>,
      })).sort((left, right) => left.payload.message.updateId - right.payload.message.updateId);
      const primary = messages[0]!;
      const combined = primary.payload.message;
      combined.attachments = messages.flatMap(({ payload }) => payload.message.attachments);
      const captioned = messages.find(({ payload }) => payload.message.text !== undefined)?.payload.message;
      if (captioned) {
        combined.text = captioned.text;
        combined.textKind = captioned.textKind;
      }
      combined.provenance = {
        ...combined.provenance,
        media_group_id: mediaGroupId,
        album: messages.map(({ payload }, index) => ({
          position: index, message_ref: payload.message.messageRef,
          attachment_refs: payload.message.attachments.map((attachment) => attachment.ref),
        })),
      };
      this.state.coalesceInbox(
        primary.row.id,
        { kind: "message", message: combined } satisfies PersistedPayload,
        messages.slice(1).map(({ row }) => row.id),
      );
      this.enqueue(primary.row.id, routeKeyValue);
    }, delay);
    this.albums.set(key, { ids, timer });
  }

  private async dispatch(inboxId: number): Promise<void> {
    if (!this.state.claimInbox(inboxId)) return;
    const row = this.state.inbox(inboxId);
    if (!row?.payload_json) return;
    try {
      const payload = JSON.parse(row.payload_json) as PersistedPayload;
      if (payload.kind === "message") await this.dispatchMessage(row, hydrateMessage(payload.message));
      else if (payload.kind === "callback") await this.dispatchCallback(row, payload.update, payload.route);
      else if (payload.kind === "poll_answer") await this.dispatchPollAnswer(row, payload.update, payload.route);
      else if (payload.kind === "join_request") await this.dispatchJoinRequest(payload.update, payload.route);
      else await this.dispatchMigration(payload.oldChatId, payload.newChatId);
      if (this.state.inbox(inboxId)?.status !== "failed") this.state.markInbox(inboxId, "done");
    } catch (error) {
      const reason = redactSecrets(error instanceof Error ? error.message : String(error));
      if (this.stopping) {
        this.state.markInbox(inboxId, "interrupted", "tgfx stopped during the accepted turn");
        return;
      }
      this.state.markInbox(inboxId, "failed", reason);
      this.log(`Update ${row.update_id} failed · ${reason}`);
      await this.options.telegram.sendText(
        this.config.approvals.chatId,
        `tgfx could not finish an accepted Telegram update.\n\n${reason.slice(0, 3000)}`,
        this.config.approvals.topicId,
      ).catch(() => undefined);
    }
  }

  private async dispatchMessage(row: InboxRow, message: InboundMessage): Promise<void> {
    this.state.registerInbound(message);
    if (!shouldInvokeAgent(message, this.options.bot.username, this.options.bot.id)) return;
    const command = commandFromText(message.text, this.options.bot.username);
    if (command && !command.addressed) return;

    if (command) {
      if (command.name !== "compact" && command.name !== "model" && command.name !== "cost") {
        await this.options.telegram.sendText(message.route.chatId, `Unknown command /${command.name}.`, message.route.topicId);
        return;
      }
      if (command.args) {
        await this.options.telegram.sendText(
          message.route.chatId,
          `Usage: /${command.name}`,
          message.route.topicId,
        );
        return;
      }
      if (command.name === "model") {
        await this.openModelPicker(message);
        return;
      }
      if (command.name === "cost") {
        await this.openCostReport(message);
        return;
      }
      await this.runCompact(row, message);
      return;
    }

    await this.runTurn(row, message, makePrompt(message, undefined, await this.adminContext(message.route)));
  }

  private async openModelPicker(message: InboundMessage): Promise<void> {
    const config = await (await this.session(message.route)).modelConfig();
    if (!config.options.length) {
      await this.options.telegram.sendText(
        message.route.chatId,
        "fx did not return any selectable models.",
        message.route.topicId,
      );
      return;
    }
    const id = crypto.randomUUID().replaceAll("-", "");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const data: ModelPickerData = { ...config, interactionId: id };
    this.state.expireInteractions(message.route.key, "model_picker");
    this.state.createInteraction({
      id,
      botId: this.options.bot.id,
      routeKey: message.route.key,
      kind: "model_picker",
      payload: config,
      expiresAt,
    });
    try {
      let view = providerPicker(data, 0, await this.modelProviderIcons(true));
      let sent;
      try {
        sent = await this.options.telegram.sendText(
          message.route.chatId,
          view.text,
          message.route.topicId,
          { parse_mode: "HTML", reply_markup: view.replyMarkup },
        );
      } catch (error) {
        if (!this.hasCustomModelIcons(view)) throw error;
        this.disableCustomModelIcons(error);
        view = providerPicker(data);
        sent = await this.options.telegram.sendText(
          message.route.chatId,
          view.text,
          message.route.topicId,
          { parse_mode: "HTML", reply_markup: view.replyMarkup },
        );
      }
      this.registerBotMessage(message.route, String(sent.message_id));
    } catch (error) {
      this.state.expireInteraction(id);
      throw error;
    }
  }

  private async modelProviderIcons(refresh = false): Promise<ProviderIconMap> {
    if (!this.customModelIconsEnabled) return {};
    if (refresh) this.providerIcons = undefined;
    this.providerIcons ??= Promise.resolve()
      .then(() => this.options.telegram.getStickerSet(PROVIDER_ICON_PACK))
      .then((set) => providerIconsFromStickerSet(set.stickers))
      .catch((error) => {
        this.log(`Could not load ${PROVIDER_ICON_PACK}; using plain model buttons: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
        return {};
      });
    return this.providerIcons;
  }

  private hasCustomModelIcons(view: ModelPickerView): boolean {
    return view.replyMarkup.inline_keyboard.some((row) =>
      row.some((button) => button.icon_custom_emoji_id !== undefined)
    );
  }

  private disableCustomModelIcons(error: unknown): void {
    this.customModelIconsEnabled = false;
    this.log(`Telegram rejected model picker custom icons; using plain buttons: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }

  private async costView(period: FxUsagePeriod): Promise<CostReportView> {
    return costReport(await readFxUsage(this.options.fxBinary, this.options.paths.workspace, period));
  }

  private async openCostReport(message: InboundMessage): Promise<void> {
    try {
      const view = await this.costView("24h");
      const sent = await this.options.telegram.sendRich(
        message.route.chatId,
        view.richMessage,
        message.route.topicId,
        { reply_markup: view.replyMarkup },
      );
      this.registerBotMessage(message.route, String(sent.message_id));
    } catch (error) {
      this.log({
        event: "usage.failed",
        message: `${this.label(message.route.chatId, message.route.topicId)} · usage failed · ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        chat: message.route.chatId,
        topic: message.route.topicId,
      });
      await this.options.telegram.sendText(
        message.route.chatId,
        "Could not load 𝒇x usage right now.",
        message.route.topicId,
      );
    }
  }

  private async adminCapabilities(chatId: string): Promise<AdminCapability[]> {
    if (!this.config.access.chatIds.includes(chatId) || Number(chatId) >= 0) return [];
    try {
      const member = await this.options.telegram.api.getChatMember(chatId, Number(this.options.bot.id));
      return [...adminCapabilitiesForMember(member)];
    } catch {
      return [];
    }
  }

  private async hasAdminCapability(chatId: string, capability: AdminCapability): Promise<boolean> {
    return (await this.adminCapabilities(chatId)).includes(capability);
  }

  private async adminContext(route: Route): Promise<Record<string, unknown> | undefined> {
    const capabilities = await this.adminCapabilities(route.chatId);
    if (!capabilities.length) return undefined;
    return {
      capabilities,
      pending_join_requests: this.state.pendingJoinRequests(route.key),
    };
  }

  private async dispatchMigration(oldChatId: string, newChatId: string): Promise<void> {
    const oldRoutes = this.state.routes().filter((route) =>
      route.bot_id === this.options.bot.id && route.chat_id === oldChatId
    );
    for (const route of oldRoutes) {
      const session = this.sessions.get(route.route_key);
      if (session) await session.dispose();
      this.sessions.delete(route.route_key);
    }

    const migrated = this.state.migrateChat(this.options.bot.id, oldChatId, newChatId);
    const replaceId = (values: string[]): string[] => [...new Set(
      values.map((value) => value === oldChatId ? newChatId : value),
    )];
    this.config.access.chatIds = replaceId(this.config.access.chatIds);
    if (this.config.approvals.chatId === oldChatId) this.config.approvals.chatId = newChatId;
    try {
      await saveConfig(this.options.paths, this.config);
    } catch (error) {
      this.log({
        event: "config.invalid",
        message: `could not persist the migrated chat ID · ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      });
    }

    if (migrated.length) {
      await this.options.telegram.deleteCommands(oldChatId).catch(() => undefined);
      await this.installMenu(newChatId).catch((error) => this.log(
        `Could not install commands after group migration · ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      ));
      await this.options.telegram.sendText(
        newChatId,
        "Group migration detected. tgfx preserved this group's workspace session under the new supergroup ID.",
      );
      this.log({
        event: "chat.migrated",
        message: `Telegram group migrated · ${oldChatId} → ${newChatId}`,
        oldChatId,
        newChatId,
      });
    }
  }

  private async dispatchJoinRequest(update: Update, route: Route): Promise<void> {
    const request = update.chat_join_request;
    if (!request) return;
    const displayName = [request.from.first_name, request.from.last_name].filter(Boolean).join(" ")
      || request.from.username || "Telegram user";
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const memberRef = this.state.registerPrincipal({
      ref: uuid("member"), botId: this.options.bot.id, routeKey: route.key,
      kind: "user", telegramId: String(request.from.id), displayName, expiresAt,
    });
    this.state.createInteraction({
      id: crypto.randomUUID().replaceAll("-", ""), botId: this.options.bot.id,
      routeKey: route.key, kind: "join_request",
      payload: { memberRef, displayName, ...(request.bio ? { bio: request.bio } : {}) },
      expiresAt,
    });
  }

  private async dispatchPollAnswer(row: InboxRow, update: Update, route: Route): Promise<void> {
    const answer = update.poll_answer;
    if (!answer) return;
    const interaction = this.state.pollInteraction(answer.poll_id);
    if (!interaction) return;
    const poll = JSON.parse(interaction.payload_json) as {
      messageId: string; messageRef: string; question: string; options: string[];
    };
    const actor = answer.user;
    const sender: SenderIdentity = actor ? {
      kind: "user", id: String(actor.id), ref: uuid("member"),
      displayName: [actor.first_name, actor.last_name].filter(Boolean).join(" ") || actor.username || "Telegram user",
      ...(actor.username ? { username: actor.username } : {}),
      ...(actor.language_code ? { languageCode: actor.language_code } : {}),
      isBot: actor.is_bot,
    } : answer.voter_chat ? {
      kind: "chat", id: String(answer.voter_chat.id), ref: uuid("member"),
      displayName: answer.voter_chat.title ?? answer.voter_chat.first_name ?? "Telegram chat",
      ...(answer.voter_chat.username ? { username: answer.voter_chat.username } : {}),
    } : { kind: "unknown", ref: uuid("member") };
    const message: InboundMessage = {
      updateId: update.update_id, event: "poll.answer", route, sender,
      messageId: poll.messageId,
      messageRef: poll.messageRef,
      contextRef: uuid("ctx"), timestamp: new Date(), attachments: [], raw: update,
      provenance: {
        poll_ref: `interaction_${interaction.interaction_id}`,
        question: poll.question,
        selected_option_ids: answer.option_ids,
        selected_options: answer.option_ids.map((index) => poll.options[index]).filter(Boolean),
      },
    };
    this.state.registerInbound(message);
    const envelope = toEnvelope(message) as { telegram_message: Record<string, unknown> };
    envelope.telegram_message.poll = message.provenance;
    await this.runTurn(row, message, [{ type: "text", text: JSON.stringify(envelope, null, 2) }]);
  }

  private async dispatchCallback(row: InboxRow, update: Update, route: Route): Promise<void> {
    const callback = update.callback_query;
    if (!callback?.data || !callback.message) return;
    const [kind, id, value] = callback.data.split(":", 3);
    const inApprovalsRoute = route.chatId === this.config.approvals.chatId
      && route.topicId === this.config.approvals.topicId;
    if (kind === "cost" && id) {
      if (id === "n") {
        await this.options.telegram.answerCallback(callback.id, "Already showing this period");
        return;
      }
      if (!isFxUsagePeriod(id)) {
        await this.options.telegram.answerCallback(callback.id, "Unknown usage period");
        return;
      }
      await this.options.telegram.answerCallback(callback.id);
      try {
        const view = await this.costView(id);
        await this.options.telegram.editRich(
          route.chatId,
          callback.message.message_id,
          view.richMessage,
          { reply_markup: view.replyMarkup },
        );
      } catch (error) {
        this.log({
          event: "usage.failed",
          message: `${this.label(route.chatId, route.topicId)} · usage failed · ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
          chat: route.chatId,
          topic: route.topicId,
        });
        await this.options.telegram.sendText(
          route.chatId,
          "Could not load 𝒇x usage right now.",
          route.topicId,
        );
      }
      return;
    }
    if (kind === "model" && id && value) {
      const interaction = this.state.interaction(id);
      if (!interaction
        || interaction.kind !== "model_picker"
        || interaction.route_key !== route.key
        || interaction.state !== "pending"
        || Date.parse(interaction.expires_at) <= Date.now()) {
        if (interaction?.state === "pending") this.state.expireInteraction(id);
        await this.options.telegram.answerCallback(callback.id, "This model picker expired");
        return;
      }
      const stored = JSON.parse(interaction.payload_json) as Omit<ModelPickerData, "interactionId">;
      const data: ModelPickerData = { ...stored, interactionId: id };
      if (value === "n") {
        await this.options.telegram.answerCallback(callback.id);
        return;
      }
      if (value === "x") {
        this.state.expireInteraction(id);
        const view = closedModelPicker();
        await this.options.telegram.answerCallback(callback.id, "Closed");
        await this.options.telegram.editText(
          route.chatId,
          callback.message.message_id,
          view.text,
          { parse_mode: "HTML", reply_markup: view.replyMarkup },
        ).catch(() => undefined);
        return;
      }
      let view;
      const [action, first, second] = value.split(".", 3);
      if (action === "p") view = providerPicker(data, Number(first), await this.modelProviderIcons());
      else if (action === "v") {
        view = modelPicker(data, Number(first), Number(second), await this.modelProviderIcons());
      }
      else if (action === "s") {
        const model = data.options[Number(first)];
        if (!model || !this.state.resolveInteraction(id, { model: model.value })) {
          await this.options.telegram.answerCallback(callback.id, "This model picker expired");
          return;
        }
        await this.options.telegram.answerCallback(callback.id, "Changing model");
        try {
          const updated = await (await this.session(route)).setModel(model.value);
          const selected = updated.options.find((option) => option.value === updated.currentValue) ?? model;
          view = selectedModel(selected);
          this.log({
            event: "session.model_changed",
            message: `${this.label(route.chatId, route.topicId)} · model changed · ${updated.currentValue}`,
            chat: route.chatId,
            topic: route.topicId,
            model: updated.currentValue,
          });
        } catch (error) {
          view = failedModelSelection(model);
          this.log({
            event: "session.model_change_failed",
            message: `${this.label(route.chatId, route.topicId)} · model change failed · ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
            chat: route.chatId,
            topic: route.topicId,
            model: model.value,
          });
        }
        await this.options.telegram.editText(
          route.chatId,
          callback.message.message_id,
          view.text,
          { parse_mode: "HTML", reply_markup: view.replyMarkup },
        );
        return;
      }
      if (!view) {
        await this.options.telegram.answerCallback(callback.id, "This model choice is no longer available");
        return;
      }
      await this.options.telegram.answerCallback(callback.id);
      try {
        await this.options.telegram.editText(
          route.chatId,
          callback.message.message_id,
          view.text,
          { parse_mode: "HTML", reply_markup: view.replyMarkup },
        );
      } catch (error) {
        if (!this.hasCustomModelIcons(view)) throw error;
        this.disableCustomModelIcons(error);
        const plain = action === "p"
          ? providerPicker(data, Number(first))
          : action === "v" ? modelPicker(data, Number(first), Number(second)) : undefined;
        if (!plain) throw error;
        await this.options.telegram.editText(
          route.chatId,
          callback.message.message_id,
          plain.text,
          { parse_mode: "HTML", reply_markup: plain.replyMarkup },
        );
      }
      return;
    }
    if (kind === "mcp" && id && (value === "approve" || value === "deny")) {
      if (!inApprovalsRoute) {
        await this.options.telegram.answerCallback(callback.id, "This approval belongs to the approvals chat");
        return;
      }
      const approval = this.state.interaction(id);
      const accepted = approval?.kind.startsWith("telegram_admin:") === true
        && this.state.resolveInteraction(id, value);
      if (!accepted) this.state.expireInteraction(id);
      await this.options.telegram.answerCallback(callback.id, accepted ? `Action ${value}d` : "This approval expired");
      if ("message_id" in callback.message) {
        await this.options.telegram.editReplyMarkup(route.chatId, callback.message.message_id, {
          inline_keyboard: [[{ text: accepted ? `Resolved · ${value}` : "Expired", callback_data: "resolved" }]],
        }).catch(() => undefined);
      }
      return;
    }
    if (kind === "fxp" && id && value !== undefined) {
      if (!inApprovalsRoute) {
        await this.options.telegram.answerCallback(callback.id, "This permission belongs to the approvals chat");
        return;
      }
      const waiter = this.permissionWaiters.get(id);
      const option = waiter?.options[Number(value)];
      if (!waiter || !option) {
        this.state.expireInteraction(id);
        await this.options.telegram.answerCallback(callback.id, "This permission request expired");
        return;
      }
      const approval = this.state.interaction(id);
      if (approval?.kind !== "fx_permission" || !this.state.resolveInteraction(id, option.optionId)) {
        this.state.expireInteraction(id);
        await this.options.telegram.answerCallback(callback.id, "This permission request expired");
        return;
      }
      this.permissionWaiters.delete(id);
      waiter.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
      await this.options.telegram.answerCallback(callback.id, option.name);
      if ("message_id" in callback.message) {
        await this.options.telegram.editReplyMarkup(route.chatId, callback.message.message_id, {
          inline_keyboard: [[{ text: `Resolved · ${option.name}`, callback_data: "resolved" }]],
        }).catch(() => undefined);
      }
      return;
    }
    if (kind === "choice" && id && value !== undefined) {
      const interaction = this.state.interaction(id);
      if (!interaction || interaction.route_key !== route.key || interaction.state !== "pending") {
        await this.options.telegram.answerCallback(callback.id, "This choice expired");
        return;
      }
      const original = JSON.parse(interaction.payload_json) as { question: string; options: string[] };
      const index = Number(value);
      const label = original.options[index];
      if (label === undefined || !this.state.resolveInteraction(id, { index, label })) {
        await this.options.telegram.answerCallback(callback.id, "This choice expired");
        return;
      }
      await this.options.telegram.answerCallback(callback.id, label);
      await this.options.telegram.editReplyMarkup(route.chatId, callback.message.message_id, {
        inline_keyboard: [[{ text: `Selected · ${label}`, callback_data: "resolved" }]],
      }).catch(() => undefined);
      const sender = senderFromCallback(callback);
      const message: InboundMessage = {
        updateId: update.update_id,
        event: "interaction.choice",
        route,
        sender,
        messageId: String(callback.message.message_id),
        messageRef: this.state.messageReferenceByTelegramId(
          this.options.bot.id, route.chatId, String(callback.message.message_id),
        )?.ref ?? uuid("msg"),
        contextRef: uuid("ctx"),
        timestamp: new Date(),
        text: `Selected “${label}” for: ${original.question}`,
        textKind: "text",
        attachments: [],
        raw: update,
      };
      this.state.registerInbound(message);
      const envelope = toEnvelope(message) as { telegram_message: Record<string, unknown> };
      envelope.telegram_message.interaction = { ref: `interaction_${id}`, choice_index: index, label };
      await this.runTurn(row, message, [
        { type: "text", text: JSON.stringify(envelope, null, 2) },
        { type: "text", text: message.text! },
      ]);
      return;
    }
    await this.options.telegram.answerCallback(callback.id, "This action is no longer active");
  }

  private registerBotMessage(route: Route, messageId: string): void {
    this.state.registerBotMessage({
      ref: uuid("msg"),
      botId: route.botId,
      routeKey: route.key,
      chatId: route.chatId,
      topicId: route.topicId,
      messageId,
    });
  }

  private async runCompact(row: InboxRow, message: InboundMessage): Promise<void> {
    const blocks: acp.ContentBlock[] = [{ type: "text", text: "/compact" }];
    const activeContextRef = this.state.activeContext(message.route.key)?.context_ref;
    this.state.setLastPrompt(message.route.key, blocks);
    const controller = new AbortController();
    const streaming = streamsRoute(this.rendererConfig, message.route);
    const draftId = streaming ? createDraftId() : undefined;
    this.activeTurns.set(message.route.key, controller);
    if (draftId !== undefined) this.activeDraftIds.set(message.route.key, draftId);
    const routeLabel = this.label(message.route.chatId, message.route.topicId);
    const acknowledgeCancellation = async () => {
      await this.options.telegram.sendText(message.route.chatId, "𝒇x turn cancelled.", message.route.topicId);
      this.state.clearLastPrompt(message.route.key);
      this.log({ event: "turn.cancelled", message: `${routeLabel} · compact cancelled`, chat: message.route.chatId });
    };

    try {
      let progressMessageId: number | undefined;
      if (draftId !== undefined) {
        await this.options.telegram.sendRichDraft(
          message.route.chatId,
          draftId,
          COMPACTING_DRAFT,
          controller.signal,
        );
      } else {
        const progress = await this.options.telegram.sendRich(
          message.route.chatId,
          COMPACTING_MESSAGE,
          message.route.topicId,
          {},
          controller.signal,
        );
        progressMessageId = progress.message_id;
        this.registerBotMessage(message.route, String(progress.message_id));
      }

      this.state.markInbox(row.id, "running");
      const session = await this.session(message.route);
      if (controller.signal.aborted) {
        if (this.stopping) throw controller.signal.reason ?? new Error("tgfx stopped");
        await acknowledgeCancellation();
        return;
      }
      await session.prompt(blocks, {
        signal: controller.signal,
        permission: (request) => this.requestPermission(message.route, request, controller.signal),
      });
      if (controller.signal.aborted) {
        if (this.stopping) throw controller.signal.reason ?? new Error("tgfx stopped");
        await acknowledgeCancellation();
        return;
      }

      if (progressMessageId !== undefined) {
        await this.options.telegram.editRich(
          message.route.chatId,
          progressMessageId,
          COMPACTED_MESSAGE,
          {},
          controller.signal,
        );
      } else {
        const completed = await this.options.telegram.sendRich(
          message.route.chatId,
          COMPACTED_MESSAGE,
          message.route.topicId,
          {},
          controller.signal,
        );
        this.registerBotMessage(message.route, String(completed.message_id));
      }
      this.state.clearLastPrompt(message.route.key);
      this.log({ event: "turn.delivered", message: `${routeLabel} · conversation compacted`, chat: message.route.chatId });
    } catch (error) {
      if (controller.signal.aborted) {
        if (this.stopping) throw error;
        await acknowledgeCancellation();
        return;
      }
      throw error;
    } finally {
      this.activeTurns.delete(message.route.key);
      this.activeDraftIds.delete(message.route.key);
      if (activeContextRef) this.state.deactivateContext(message.route.key, activeContextRef);
    }
  }

  private async runTurn(row: InboxRow, message: InboundMessage, blocks: acp.ContentBlock[]): Promise<void> {
    const activeContextRef = this.state.activeContext(message.route.key)?.context_ref;
    this.state.setLastPrompt(message.route.key, blocks);
    const session = await this.session(message.route);
    const projector = new AcpProjector();
    const controller = new AbortController();
    const renderer = new TurnRenderer(
      this.options.telegram,
      this.state,
      message.route,
      this.rendererConfig,
      projector,
      controller.signal,
      this.draftLimiter(message.route.chatId),
    );
    this.activeTurns.set(message.route.key, controller);
    this.activeDraftIds.set(message.route.key, renderer.draftId);
    const remove = session.onUpdate((update) => {
      renderer.changed(projector.apply(update));
    });
    renderer.start();
    this.state.markInbox(row.id, "running");
    const startedAt = performance.now();
    const routeLabel = this.label(message.route.chatId, message.route.topicId);
    this.log({
      event: "turn.started",
      message: `${routeLabel} · turn started`,
      chat: message.route.chatId,
      topic: message.route.topicId,
    });
    try {
      await session.prompt(blocks, {
        signal: controller.signal,
        permission: (request) => this.requestPermission(message.route, request, controller.signal),
      });
      if (controller.signal.aborted) {
        if (this.stopping) throw controller.signal.reason ?? new Error("tgfx stopped");
        await this.options.telegram.sendText(message.route.chatId, "𝒇x turn cancelled.", message.route.topicId);
        this.state.clearLastPrompt(message.route.key);
        this.log({ event: "turn.cancelled", message: `${routeLabel} · turn cancelled`, chat: message.route.chatId });
        return;
      }
      const messageIds = await renderer.finish({
        botId: this.options.bot.id,
        inboxId: row.id,
        effectKey: `final:${this.options.bot.id}:${row.id}`,
      });
      this.state.clearLastPrompt(message.route.key);
      const seconds = ((performance.now() - startedAt) / 1_000).toFixed(1);
      this.log({
        event: "turn.delivered",
        message: `${routeLabel} · delivered ${messageIds.length} message${messageIds.length === 1 ? "" : "s"} · ${seconds}s`,
        chat: message.route.chatId,
        messages: messageIds.length,
        seconds: Number(seconds),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (this.stopping) throw error;
        await this.options.telegram.sendText(message.route.chatId, "𝒇x turn cancelled.", message.route.topicId);
        this.state.clearLastPrompt(message.route.key);
        this.log({ event: "turn.cancelled", message: `${routeLabel} · turn cancelled`, chat: message.route.chatId });
        return;
      }
      throw error;
    } finally {
      await renderer.abort();
      remove();
      this.activeTurns.delete(message.route.key);
      this.activeDraftIds.delete(message.route.key);
      if (activeContextRef) this.state.deactivateContext(message.route.key, activeContextRef);
    }
  }

  private async session(route: Route): Promise<FxRouteSession> {
    const existing = this.sessions.get(route.key);
    if (existing) return existing;
    const row = this.state.ensureRoute(route);
    const entrypoint = fileURLToPath(new URL("./index.ts", import.meta.url));
    const session = new FxRouteSession({
      workspace: this.options.paths.workspace,
      binary: this.options.fxBinary,
      model: this.options.model,
      permissionMode: this.options.permissionMode,
      previousSessionId: row.session_id ?? undefined,
      mcp: {
        command: process.execPath,
        args: [entrypoint, "mcp"],
        env: {
          TGFX_MCP_TOKEN: this.options.token,
          TGFX_MCP_BOT_ID: this.options.bot.id,
          TGFX_MCP_ROUTE_KEY: route.key,
          TGFX_MCP_WORKSPACE: this.options.paths.workspace,
          TGFX_MCP_DATABASE: this.options.paths.database,
          TGFX_MCP_FILES: this.options.paths.files,
          TGFX_MCP_APPROVALS_CHAT: this.config.approvals.chatId,
          TGFX_MCP_APPROVALS_TOPIC: this.config.approvals.topicId,
          TGFX_MCP_ALLOWED_CHATS: JSON.stringify(this.config.access.chatIds),
          ...(process.env.TGFX_INTERNAL_TELEGRAM_API_ROOT
            ? { TGFX_INTERNAL_TELEGRAM_API_ROOT: process.env.TGFX_INTERNAL_TELEGRAM_API_ROOT }
            : {}),
          ...(process.env.TGFX_INTERNAL_TELEGRAM_FILE_ROOT
            ? { TGFX_INTERNAL_TELEGRAM_FILE_ROOT: process.env.TGFX_INTERNAL_TELEGRAM_FILE_ROOT }
            : {}),
          TGFX_MCP_PROTECTED_USERS: JSON.stringify([
            this.options.bot.id,
            ...this.config.access.userIds,
          ]),
        },
      },
      onUpdate: async (update) => {
        if (update.sessionUpdate !== "available_commands_update") return;
        this.state.setCommands(route.key, update.availableCommands);
      },
    });
    this.sessions.set(route.key, session);
    try {
      const info = await session.start();
      this.state.setRouteSession(route.key, info.sessionId, info.replacedPrevious);
      if (info.replacedPrevious) {
        await this.options.telegram.sendText(
          route.chatId,
          "The previous 𝒇x session could not be resumed, so this route started a fresh session.",
          route.topicId,
        ).catch((error) => this.log(
          `Could not report the replaced fx session · ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        ));
      }
      this.log({
        event: "session.started",
        message: `${this.label(route.chatId, route.topicId)} · fx ${info.agentVersion} · ${info.model}`,
        chat: route.chatId,
        topic: route.topicId,
        fxVersion: info.agentVersion,
        model: info.model,
      });
      return session;
    } catch (error) {
      this.sessions.delete(route.key);
      await session.dispose();
      throw error;
    }
  }

  private async requestPermission(
    route: Route,
    request: acp.RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<acp.RequestPermissionResponse> {
    const id = crypto.randomUUID().replaceAll("-", "");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    this.state.createInteraction({
      id, botId: this.options.bot.id, routeKey: route.key, kind: "fx_permission",
      payload: {
        prompt: request.toolCall.title ?? "𝒇x tool permission",
        options: request.options,
      },
      expiresAt,
    });
    const keyboard = request.options.map((option, index) => [{
      text: option.name,
      callback_data: `fxp:${id}:${index}`,
    }]);
    let card;
    try {
      card = await this.options.telegram.sendText(
        this.config.approvals.chatId,
        `𝒇x permission\n\n${request.toolCall.title ?? "Tool action"}`,
        this.config.approvals.topicId,
        { reply_markup: { inline_keyboard: keyboard } },
      );
    } catch (error) {
      this.state.expireInteraction(id);
      throw error;
    }
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      let settled = false;
      const finish = (response: acp.RequestPermissionResponse) => {
        if (settled) return;
        settled = true;
        this.permissionWaiters.delete(id);
        resolve(response);
      };
      this.permissionWaiters.set(id, {
        options: request.options, messageId: card.message_id,
        routeKey: route.key, resolve: finish,
      });
      void (async () => {
        while (!settled && !signal?.aborted && Date.now() < Date.parse(expiresAt)) {
          const approval = this.state.interaction(id);
          if (approval?.state === "resolved" && approval.result_json) {
            const result = JSON.parse(approval.result_json) as unknown;
            const selected = request.options.find((option) => option.optionId === result);
            if (selected) {
              finish({ outcome: { outcome: "selected", optionId: selected.optionId } });
              return;
            }
          }
          await Bun.sleep(250);
        }
        if (settled) return;
        const reject = request.options.find((option) => option.kind === "reject_once")
          ?? request.options.find((option) => option.kind === "reject_always");
        if (this.state.expireInteraction(id)) {
          await this.options.telegram.editReplyMarkup(
            this.config.approvals.chatId,
            card.message_id,
            { inline_keyboard: [[{
              text: signal?.aborted ? "Cancelled" : "Expired", callback_data: "resolved",
            }]] },
          ).catch(() => undefined);
        }
        finish(reject
          ? { outcome: { outcome: "selected", optionId: reject.optionId } }
          : { outcome: { outcome: "cancelled" } });
      })();
    });
  }

  private async installInitialMenus(): Promise<void> {
    const chats = new Set([
      ...this.config.access.chatIds,
      ...this.config.access.userIds,
      this.config.approvals.chatId,
    ]);
    for (const route of this.state.routes()) {
      if (route.bot_id !== this.options.bot.id) continue;
      chats.add(route.chat_id);
    }
    await Promise.allSettled([...chats].map((chatId) =>
      this.installMenu(chatId)
    ));
  }

  private async installMenu(chatId: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this.options.telegram.setCommands(chatId, COMMANDS);
        return;
      } catch (error) {
        lastError = error;
        if (!isRetryableTelegramError(error) || attempt === 3) break;
        const retryAfter = error instanceof TelegramError ? error.retryAfter : undefined;
        await Promise.race([
          Bun.sleep(retryAfter ? retryAfter * 1_000 : 500 * (2 ** attempt)),
          this.stopped,
        ]);
        if (this.stopping) throw new Error("tgfx is stopping");
      }
    }
    throw lastError;
  }
}
