import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { FxAcpEvent } from "./types";
import { AcpTranscript } from "./transcript";

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.ended) return;
    this.failure = error;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function selectValue(
  options: acp.SessionConfigOption[] | null | undefined,
  id: string,
): { current: string; count: number; values: string[] } | undefined {
  const option = options?.find(
    (candidate) => candidate.id === id && candidate.type === "select",
  );
  if (!option || option.type !== "select") return undefined;

  const values = option.options.flatMap((candidate) =>
    "value" in candidate
      ? [candidate.value]
      : candidate.options.map((nested) => nested.value)
  );

  return {
    current: option.currentValue,
    count: values.length,
    values,
  };
}

async function stopProcess(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.kill("SIGTERM");

  await Promise.race([
    new Promise<void>((resolve) => process.once("exit", () => resolve())),
    Bun.sleep(1_000),
  ]);

  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGKILL");
  }
}

async function executeFxTurn(options: {
  queue: AsyncQueue<FxAcpEvent>;
  prompt: string;
  workspace: string;
  binary: string;
  model?: string;
  transcriptPath?: string;
  signal: AbortSignal;
}): Promise<void> {
  const { queue, prompt, workspace, binary, model, transcriptPath, signal } = options;
  const transcript = transcriptPath
    ? await AcpTranscript.create(transcriptPath)
    : undefined;
  const args = ["acp", ...(model ? ["--model", model] : [])];
  const fx = spawn(binary, args, {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let processError: Error | undefined;
  const spawnFailure = new Promise<never>((_resolve, reject) => {
    fx.once("error", (error) => {
      processError = error;
      reject(error);
    });
  });

  let stderr = "";
  fx.stderr.setEncoding("utf8");
  fx.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_192);
  });

  const abort = () => void stopProcess(fx);
  signal.addEventListener("abort", abort, { once: true });

  try {
    const processInput = Writable.toWeb(fx.stdin) as unknown as WritableStream<
      Uint8Array
    >;
    const processOutput = Readable.toWeb(fx.stdout) as unknown as ReadableStream<
      Uint8Array
    >;
    const input = transcript?.tapWritable(processInput) ?? processInput;
    const output = transcript?.tapReadable(processOutput) ?? processOutput;
    const stream = acp.ndJsonStream(input, output);

    const client = acp
      .client({ name: "telefx" })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        // The first POC runs a fixed read-only prompt. Unexpected permission
        // requests are surfaced to Telegram and rejected, never auto-approved.
        const rejection = params.options.find(
          (option) => option.kind === "reject_once",
        ) ?? params.options.find((option) => option.kind === "reject_always");

        queue.push({
          type: "permission_requested",
          request: params,
          selectedOptionId: rejection?.optionId,
        });

        if (!rejection) return { outcome: { outcome: "cancelled" } };
        return {
          outcome: {
            outcome: "selected",
            optionId: rejection.optionId,
          },
        };
      });

    const connection = client.connectWith(stream, async (ctx) => {
      const initialized = await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          session: { configOptions: { boolean: {} } },
        },
        clientInfo: {
          name: "telefx",
          title: "telefx Telegram bridge",
          version: "0.1.0",
        },
      });

      await ctx.buildSession(workspace).withSession(async (session) => {
        const modelOption = selectValue(
          session.newSessionResponse.configOptions,
          "model",
        );
        const modeOption = selectValue(
          session.newSessionResponse.configOptions,
          "mode",
        );

        if (
          modeOption
          && modeOption.current !== "ask"
          && modeOption.values.includes("ask")
        ) {
          await ctx.request(acp.methods.agent.session.setConfigOption, {
            sessionId: session.sessionId,
            configId: "mode",
            value: "ask",
          });
        }

        queue.push({
          type: "session_started",
          sessionId: session.sessionId,
          agentName: initialized.agentInfo?.title
            ?? initialized.agentInfo?.name
            ?? "fx",
          agentVersion: initialized.agentInfo?.version ?? "unknown",
          model: modelOption?.current ?? model ?? "unknown",
          mode: "ask",
          availableModelCount: modelOption?.count ?? 0,
        });

        const resultPromise = session.prompt(prompt);
        for (;;) {
          if (signal.aborted) throw signal.reason ?? new Error("FX turn aborted");
          const message = await session.nextUpdate();

          if (message.kind === "stop") {
            queue.push({
              type: "turn_completed",
              stopReason: message.stopReason,
            });
            break;
          }

          queue.push({ type: "session_update", update: message.update });
        }

        await resultPromise;
      });
    });
    await Promise.race([connection, spawnFailure]);
  } catch (error) {
    // A failed spawn can close stdio just before Node delivers the child
    // process error event. Give that event one tick so the useful ENOENT wins
    // over the SDK's generic "connection closed" error.
    if (!processError) {
      await Promise.race([
        spawnFailure.catch(() => undefined),
        Bun.sleep(25),
      ]);
    }
    if (processError) {
      throw new Error(`Unable to start ${binary}: ${processError.message}`, {
        cause: processError,
      });
    }
    if (stderr.trim() && error instanceof Error) {
      throw new Error(`${error.message}\nfx stderr: ${stderr.trim()}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await stopProcess(fx);
    await transcript?.close();
  }
}

export async function* streamFxAcp(options: {
  prompt: string;
  workspace: string;
  binary?: string;
  model?: string;
  transcriptPath?: string;
  signal?: AbortSignal;
}): AsyncGenerator<FxAcpEvent> {
  const queue = new AsyncQueue<FxAcpEvent>();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  const execution = executeFxTurn({
    queue,
    prompt: options.prompt,
    workspace: options.workspace,
    binary: options.binary ?? "fx",
    model: options.model,
    transcriptPath: options.transcriptPath,
    signal: controller.signal,
  }).then(
    () => queue.end(),
    (error) => queue.fail(error),
  );

  try {
    for await (const event of queue) yield event;
    await execution;
  } finally {
    controller.abort(new Error("FX event consumer closed"));
    options.signal?.removeEventListener("abort", forwardAbort);
    await execution.catch(() => undefined);
  }
}
