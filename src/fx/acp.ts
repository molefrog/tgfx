import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

export type FxSessionInfo = {
  sessionId: string;
  agentVersion: string;
  model: string;
  replacedPrevious: boolean;
};

export type FxPermissionHandler = (
  request: acp.RequestPermissionRequest,
) => Promise<acp.RequestPermissionResponse>;

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

function rejectPermission(request: acp.RequestPermissionRequest): acp.RequestPermissionResponse {
  const option = request.options.find((item) => item.kind === "reject_once")
    ?? request.options.find((item) => item.kind === "reject_always");
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
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
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    Bun.sleep(milliseconds),
  ]);
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
  private updateListeners = new Set<(update: acp.SessionUpdate) => void | Promise<void>>();
  private closed = false;
  private connectionError?: unknown;
  private stderr = "";

  constructor(private readonly options: {
    workspace: string;
    binary: string;
    model?: string;
    previousSessionId?: string;
    mcp?: McpOptions;
    onUpdate?: (update: acp.SessionUpdate) => void | Promise<void>;
  }) {
    if (options.onUpdate) this.updateListeners.add(options.onUpdate);
  }

  async start(): Promise<FxSessionInfo> {
    if (!this.connectTask) {
      this.connectTask = this.connect().catch((error) => { this.connectionError = error; });
    }
    return Promise.race([
      this.ready.promise,
      Bun.sleep(START_TIMEOUT_MS).then(() => { throw new Error("fx ACP did not initialize within 30 seconds"); }),
    ]);
  }

  private async connect(): Promise<void> {
    const args = ["acp", ...(this.options.model ? ["--model", this.options.model] : [])];
    const child = spawn(this.options.binary, args, {
      cwd: this.options.workspace,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      // Bun loads `.env` into the host process. FX and its ordinary shell tools
      // must never inherit the Telegram token; only the scoped MCP subprocess
      // receives credentials through its ACP launch descriptor.
      env: sanitizeFxEnvironment(process.env),
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
        clientInfo: { name: "tgfx", title: "𝒕𝒈(𝒇x)", version: "0.1.0" },
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
      const modes = "modes" in response ? response.modes : undefined;
      const mode = modes?.currentModeId ?? selectValue(configOptions, "mode") ?? "ask";
      const model = selectValue(configOptions, "model") ?? this.options.model ?? "default";
      if (mode !== "ask") {
        const canSetMode = modes?.availableModes.some((candidate) => candidate.id === "ask");
        if (canSetMode) {
          await ctx.request(acp.methods.agent.session.setMode, {
            sessionId: this.sessionId,
            modeId: "ask",
          });
        } else {
          // Compatibility with agents that model permission mode as a config
          // option instead of ACP's dedicated session mode state.
          const option = configOptions?.find((candidate) => candidate.id === "mode" && candidate.type === "select");
          const canAsk = option?.type === "select" && option.options.some((entry) =>
            "value" in entry ? entry.value === "ask" : entry.options.some((nested) => nested.value === "ask")
          );
          if (!canAsk) throw new Error(`fx ACP does not expose the required ask mode (current: ${mode})`);
          await ctx.request(acp.methods.agent.session.setConfigOption, {
            sessionId: this.sessionId,
            configId: "mode",
            value: "ask",
          });
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
    const abort = () => void this.cancel();
    handlers.signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.context.request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: blocks,
      });
    } finally {
      handlers.signal?.removeEventListener("abort", abort);
      this.currentPermission = undefined;
    }
  }

  async cancel(): Promise<void> {
    if (this.context && this.sessionId) {
      await this.context.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }).catch(() => undefined);
    }
  }

  async dispose(options: { closeSession?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (options.closeSession && this.context && this.sessionId) {
      await Promise.race([
        this.context.request(acp.methods.agent.session.close, { sessionId: this.sessionId }).catch(() => undefined),
        Bun.sleep(1_000),
      ]);
    }
    this.closeGate.resolve();
    if (this.child) await terminate(this.child);
    await this.connectTask;
  }
}
