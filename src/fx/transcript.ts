import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type AcpWireDirection = "client_to_fx" | "fx_to_client";

interface DirectionState {
  decoder: TextDecoder;
  buffer: string;
}

/**
 * Records both sides of the newline-delimited ACP transport. Each JSONL record
 * contains the parsed message for convenient querying and the exact wire line.
 */
export class AcpTranscript {
  private readonly states: Record<AcpWireDirection, DirectionState> = {
    client_to_fx: { decoder: new TextDecoder(), buffer: "" },
    fx_to_client: { decoder: new TextDecoder(), buffer: "" },
  };
  private failure?: Error;
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly output: WriteStream,
  ) {
    output.on("error", (error) => {
      this.failure = error;
    });
  }

  static async create(path: string): Promise<AcpTranscript> {
    const absolutePath = resolve(path);
    await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
    const output = createWriteStream(absolutePath, {
      flags: "wx",
      mode: 0o600,
      encoding: "utf8",
    });

    await new Promise<void>((resolveOpen, reject) => {
      output.once("open", () => resolveOpen());
      output.once("error", reject);
    });

    const transcript = new AcpTranscript(absolutePath, output);
    transcript.writeRecord({
      timestamp: new Date().toISOString(),
      direction: "meta",
      message: {
        schema: "telefx-acp-transcript-v1",
        transport: "ndjson-stdio",
      },
    });
    return transcript;
  }

  tapReadable(
    source: ReadableStream<Uint8Array>,
  ): ReadableStream<Uint8Array> {
    return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        this.accept("fx_to_client", chunk);
        controller.enqueue(chunk);
      },
      flush: () => this.flush("fx_to_client"),
    }));
  }

  tapWritable(
    destination: WritableStream<Uint8Array>,
  ): WritableStream<Uint8Array> {
    const writer = destination.getWriter();
    return new WritableStream<Uint8Array>({
      write: async (chunk) => {
        this.accept("client_to_fx", chunk);
        await writer.write(chunk);
      },
      close: async () => {
        this.flush("client_to_fx");
        await writer.close();
      },
      abort: async (reason) => {
        this.flush("client_to_fx");
        await writer.abort(reason);
      },
    });
  }

  private accept(direction: AcpWireDirection, chunk: Uint8Array): void {
    this.assertWritable();
    const state = this.states[direction];
    state.buffer += state.decoder.decode(chunk, { stream: true });
    this.drain(direction);
  }

  private drain(direction: AcpWireDirection): void {
    const state = this.states[direction];
    for (;;) {
      const newline = state.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = state.buffer.slice(0, newline).replace(/\r$/u, "");
      state.buffer = state.buffer.slice(newline + 1);
      if (line) this.writeWireLine(direction, line);
    }
  }

  private flush(direction: AcpWireDirection): void {
    if (this.closed) return;
    const state = this.states[direction];
    state.buffer += state.decoder.decode();
    this.drain(direction);
    const line = state.buffer.replace(/\r$/u, "");
    state.buffer = "";
    if (line) this.writeWireLine(direction, line);
  }

  private writeWireLine(direction: AcpWireDirection, raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      message = null;
    }

    this.writeRecord({
      timestamp: new Date().toISOString(),
      direction,
      message,
      raw,
    });
  }

  private writeRecord(record: Record<string, unknown>): void {
    this.assertWritable();
    this.output.write(`${JSON.stringify(record)}\n`);
  }

  private assertWritable(): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("ACP transcript is already closed");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.flush("client_to_fx");
    this.flush("fx_to_client");
    this.closed = true;

    await new Promise<void>((resolveClose, reject) => {
      if (this.failure) return reject(this.failure);
      this.output.once("error", reject);
      this.output.end(() => resolveClose());
    });
    if (this.failure) throw this.failure;
  }
}

export function createAcpTranscriptPath(directory: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const suffix = crypto.randomUUID().slice(0, 8);
  return resolve(directory, `${timestamp}-${suffix}.jsonl`);
}
