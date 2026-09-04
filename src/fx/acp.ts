import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { withTimeout } from "../timeout";
import { VERSION } from "../version";

export type FxSessionInfo = {
  sessionId: string;
  agentVersion: string;
  model: string;
  replacedPrevious: boolean;
};

export type FxModelOption = {
  value: string;
  name: string;
  description?: string;
};

export type FxModelConfig = {
  currentValue: string;
  options: FxModelOption[];
};

export type FxPermissionHandler = (
  request: acp.RequestPermissionRequest,
) => Promise<acp.RequestPermissionResponse>;

export type FxPermissionMode = "auto" | "yolo";

type McpOptions = { command: string; args: string[]; env: Record<string, string> };
const START_TIMEOUT_MS = 30_000;
const MAX_PROMPT_BYTES = 8 * 1024 * 1024;

export function sanitizeFxEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...environment };
  delete clean.TELEGRAM_BOT_TOKEN;
  for (const name of Object.keys(clean)) {
    if (name.startsWith("TGFX_MCP_") || name.startsWith("TGFX_INTERNAL_TELEGRAM_")) delete clean[name];
  }
  return clean;
}

function selectValue(options: acp.SessionConfigOption[] | null | undefined, id: string): string | undefined {
  const option = options?.find((candidate) => candidate.id === id && candidate.type === "select");
  return option?.type === "select" ? option.currentValue : undefined;
}

function modelConfig(options: acp.SessionConfigOption[] | null | undefined): FxModelConfig | undefined {
  const config = options?.find((candidate) => candidate.id === "model" && candidate.type === "select");
  if (!config || config.type !== "select") return undefined;
  return {
    currentValue: config.currentValue,
    options: config.options.flatMap((entry) => {
      const values = "value" in entry ? [entry] : entry.options;
      return values.map((value) => ({
        value: value.value,
        name: value.name,
        ...(value.description ? { description: value.description } : {}),
      }));
    }),
  };
}

/** The fail-closed answer: fx's reject option, or a cancellation when it offers none. */
export function rejectedPermission(options: acp.PermissionOption[]): acp.RequestPermissionResponse {
  const option = options.find((item) => item.kind === "reject_once")
    ?? options.find((item) => item.kind === "reject_always");
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function rejectPermission(request: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
  return rejectedPermission(request.options);
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch { /* fall back to the direct child below */ }
  }
  child.kill(signal);
}

async function waitForExit(child: ChildProcessWithoutNullStreams, milliseconds: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await withTimeout(
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    milliseconds,
    () => undefined,
  );
}

async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessTree(child, "SIGTERM");
  await waitForExit(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) {
    signalProcessTree(child, "SIGKILL");
    await waitForExit(child, 1_000);
  }
}

export class FxRouteSession {
  private child?: ChildProcessWithoutNullStreams;
  private context?: acp.ClientContext;
  private sessionId?: string;
  private connectTask?: Promise<void>;
  private ready = Promise.withResolvers<FxSessionInfo>();
  private closeGate = Promise.withResolvers<void>();
  private currentPermission?: FxPermissionHandler;
  private configOptions: acp.SessionConfigOption[] = [];
  private updateListeners = new Set<(update: acp.SessionUpdate) => void | Promise<void>>();
  private closed = false;
  private disposeTask?: Promise<void>;
  private connectionError?: unknown;
  private stderr = "";

  constructor(private readonly options: {
    workspace: string;
    binary: string;
    model?: string;
    permissionMode?: FxPermissionMode;
    previousSessionId?: string;
    mcp?: McpOptions;
  }) {}

  async start(): Promise<FxSessionInfo> {
    if (!this.usable) throw this.connectionError ?? new Error("fx ACP session is closed");
    if (!this.connectTask) {
      this.connectTask = this.connect().catch((error) => { this.connectionError = error; });
    }
    return withTimeout(this.ready.promise, START_TIMEOUT_MS, () => {
      throw new Error("fx ACP did not initialize within 30 seconds");
    });
  }

  get usable(): boolean {
    return !this.closed && !this.connectionError
      && (!this.child || (this.child.exitCode === null && this.child.signalCode === null));
  }

  private async connect(): Promise<void> {
    const permissionMode = this.options.permissionMode ?? "auto";
    const args = ["acp", ...(this.options.model ? ["--model", this.options.model] : [])];
    const child = spawn(this.options.binary, args, {
      cwd: this.options.workspace,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      // Bun loads `.env` into the host process. FX and its ordinary shell tools
      // must never inherit the Telegram token; only the scoped MCP subprocess
      // receives credentials through its ACP launch descriptor.
      env: {
        ...sanitizeFxEnvironment(process.env),
        // ACP exposes ask/auto as session modes, but not yolo. The environment
        // override is FX's process-scoped entry point for all three policies.
        FX_PERMISSION_MODE: permissionMode,
      },
    });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-16_384); });
    const spawnError = Promise.withResolvers<never>();
    child.once("error", (error) => spawnError.reject(error));

    const input = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
    const output = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);
    const app = acp.client({ name: "tgfx" })
      .onNotification(acp.methods.client.session.update, async ({ params }) => {
        if (params.update.sessionUpdate === "config_option_update") {
          this.configOptions = params.update.configOptions;
        }
        for (const listener of this.updateListeners) await listener(params.update);
      })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        return this.currentPermission ? this.currentPermission(params) : rejectPermission(params);
      });

    const connection = app.connectWith(stream, async (ctx) => {
      this.context = ctx;
      const initialized = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { session: { configOptions: { boolean: {} } } },
        clientInfo: { name: "tgfx", title: "𝒕𝒈(𝒇x)", version: VERSION },
      });
      const mcpServers: acp.McpServer[] = this.options.mcp ? [{
        name: "telegram",
        command: this.options.mcp.command,
        args: this.options.mcp.args,
        env: Object.entries(this.options.mcp.env).map(([name, value]) => ({ name, value })),
      }] : [];

      let response: acp.NewSessionResponse | acp.LoadSessionResponse;
      let replacedPrevious = false;
      if (this.options.previousSessionId && initialized.agentCapabilities?.loadSession) {
        try {
          response = await ctx.request(acp.methods.agent.session.load, {
            sessionId: this.options.previousSessionId,
            cwd: this.options.workspace,
            mcpServers,
          });
          this.sessionId = this.options.previousSessionId;
        } catch {
          replacedPrevious = true;
          const created = await ctx.request(acp.methods.agent.session.new, {
            cwd: this.options.workspace,
            mcpServers,
          });
          response = created;
          this.sessionId = created.sessionId;
        }
      } else {
        replacedPrevious = Boolean(this.options.previousSessionId);
        const created = await ctx.request(acp.methods.agent.session.new, {
          cwd: this.options.workspace,
          mcpServers,
        });
        response = created;
        this.sessionId = created.sessionId;
      }

      const configOptions = "configOptions" in response ? response.configOptions : undefined;
      this.configOptions = configOptions ?? [];
      const modes = "modes" in response ? response.modes : undefined;
      const model = selectValue(configOptions, "model") ?? this.options.model ?? "default";
      if (permissionMode === "auto") {
        // Always select code explicitly. FX 0.0.7 can report its display mode
        // as ask while retaining the configured permission policy internally.
        const canSetMode = modes?.availableModes.some((candidate) => candidate.id === "code");
        if (canSetMode) {
          await ctx.request(acp.methods.agent.session.setMode, {
            sessionId: this.sessionId,
            modeId: "code",
          });
        } else {
          // Compatibility with agents that model permission mode as a config
          // option instead of ACP's dedicated session mode state.
          const option = configOptions?.find((candidate) => candidate.id === "mode" && candidate.type === "select");
          const values = option?.type === "select"
            ? option.options.flatMap((entry) => "value" in entry
              ? [entry.value]
              : entry.options.map((nested) => nested.value))
            : [];
          const value = values.includes("auto") ? "auto" : values.includes("code") ? "code" : undefined;
          if (!value) throw new Error("fx ACP does not expose the required auto/code mode");
          const updated = await ctx.request(acp.methods.agent.session.setConfigOption, {
            sessionId: this.sessionId,
            configId: "mode",
            value,
          });
          this.configOptions = updated.configOptions;
        }
      }
      const sessionId = this.sessionId;
      if (!sessionId) throw new Error("fx did not return a session ID");
      this.ready.resolve({
        sessionId,
        agentVersion: initialized.agentInfo?.version ?? "unknown",
        model,
        replacedPrevious,
      });
      await this.closeGate.promise;
    });

    try {
      await Promise.race([connection, spawnError.promise]);
      if (!this.closed) throw new Error(`fx ACP connection closed${this.stderr ? `: ${this.stderr.trim()}` : ""}`);
    } catch (error) {
      this.ready.reject(error);
      if (!this.closed) throw error;
    }
  }

  onUpdate(listener: (update: acp.SessionUpdate) => void | Promise<void>): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  async modelConfig(): Promise<FxModelConfig> {
    await this.start();
    if (this.connectionError) throw this.connectionError;
    const config = modelConfig(this.configOptions);
    if (!config) throw new Error("fx ACP does not expose model selection");
    return config;
  }

  async setModel(value: string, signal?: AbortSignal): Promise<FxModelConfig> {
    const current = await this.modelConfig();
    if (!current.options.some((option) => option.value === value)) {
      throw new Error(`fx ACP does not offer model ${value}`);
    }
    if (!this.context || !this.sessionId) throw new Error("fx ACP session is not ready");
    signal?.throwIfAborted();
    const onAbort = () => { void this.dispose(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    let response: acp.SetSessionConfigOptionResponse;
    try {
      response = await this.context.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.sessionId,
        configId: "model",
        value,
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    this.configOptions = response.configOptions;
    const updated = modelConfig(this.configOptions);
    if (!updated) throw new Error("fx ACP stopped exposing model selection");
    if (updated.currentValue !== value) {
      throw new Error(`fx ACP kept model ${updated.currentValue} instead of ${value}`);
    }
    return updated;
  }

  async prompt(
    blocks: acp.ContentBlock[],
    handlers: { permission?: FxPermissionHandler; signal?: AbortSignal } = {},
  ): Promise<acp.PromptResponse> {
    const bytes = Buffer.byteLength(JSON.stringify(blocks));
    if (bytes > MAX_PROMPT_BYTES) {
      throw new Error(`Telegram prompt is too large for ACP (${bytes} bytes; limit ${MAX_PROMPT_BYTES})`);
    }
    await this.start();
    if (this.connectionError) throw this.connectionError;
    if (!this.context || !this.sessionId) throw new Error("fx ACP session is not ready");
    if (handlers.signal?.aborted) throw handlers.signal.reason;
    this.currentPermission = handlers.permission;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      void this.cancel();
      cancelTimer = setTimeout(() => { void this.dispose(); }, 2_000);
    };
    handlers.signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.context.request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: blocks,
      });
      // FX also uses older names for these ACP stop reasons. Neither spelling
      // means the task completed, even if it streamed a success-looking reply.
      const reason: string = response.stopReason;
      if (reason !== "end_turn") {
        const detail = reason === "max_tokens" || reason === "max_output_tokens"
          ? "reached its response limit"
          : reason === "max_turn_requests" || reason === "max_model_turns"
            ? "reached its turn limit"
            : reason === "refusal" || reason === "refused"
              ? "could not complete the request"
              : reason === "cancelled" ? "was cancelled" : `stopped (${reason})`;
        throw new Error(`FX ${detail}. The request may be unfinished.`);
      }
      return response;
    } finally {
      clearTimeout(cancelTimer);
      handlers.signal?.removeEventListener("abort", abort);
      this.currentPermission = undefined;
    }
  }

  async cancel(): Promise<void> {
    if (this.context && this.sessionId) {
      await this.context.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }).catch(() => undefined);
    }
  }

  dispose(options: { closeSession?: boolean } = {}): Promise<void> {
    return this.disposeTask ??= this.disposeOnce(options);
  }

  private async disposeOnce(options: { closeSession?: boolean }): Promise<void> {
    this.closed = true;
    // Also release callers waiting for a handshake that will never finish.
    if (this.connectTask) this.ready.reject(new Error("fx ACP session is closed"));
    if (options.closeSession && this.context && this.sessionId) {
      await withTimeout(
        this.context.request(acp.methods.agent.session.close, { sessionId: this.sessionId }).catch(() => undefined),
        1_000,
        () => undefined,
      );
    }
    this.closeGate.resolve();
    if (this.child) await terminate(this.child);
    await this.connectTask;
  }
}
