import { randomBytes } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type Launch = { command: string; args: string[] };
type Connection = { socket: Socket; child?: ChildProcessWithoutNullStreams };
type Lease = { env: Record<string, string>; connections: Set<Connection> };

/** Keeps the credentialed MCP subprocess on the service side of a Unix-user boundary. */
export class TelegramMcpBroker {
  private readonly leases = new Map<string, Lease>();
  private readonly connections = new Set<Connection>();
  private closed = false;

  private constructor(readonly path: string, private readonly server: Server, private readonly launch: Launch) {}

  static async listen(directory: string, launch: Launch): Promise<TelegramMcpBroker> {
    await mkdir(directory, { recursive: true, mode: 0o750 });
    // A fresh name never takes over another service's socket, including after a crash.
    const path = join(directory, `mcp-${randomBytes(8).toString("hex")}.sock`);
    let broker: TelegramMcpBroker;
    const server = createServer((socket) => broker.accept(socket));
    broker = new TelegramMcpBroker(path, server, launch);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => { server.off("error", reject); resolve(); });
    });
    try { await chmod(path, 0o660); }
    catch (error) { await broker.close(); throw error; }
    return broker;
  }

  lease(env: Record<string, string>): { launch: Launch & { env: Record<string, string> }; revoke: () => void } {
    if (this.closed) throw new Error("Telegram MCP broker is closed");
    const capability = randomBytes(32).toString("base64url");
    const lease: Lease = { env: { ...env }, connections: new Set() };
    this.leases.set(capability, lease);
    return {
      launch: {
        command: this.launch.command,
        args: [...this.launch.args.slice(0, -1), "mcp-proxy"],
        env: { TGFX_MCP_SOCKET: this.path, TGFX_MCP_CAPABILITY: capability },
      },
      revoke: () => {
        this.leases.delete(capability);
        for (const connection of lease.connections) this.disconnect(connection);
      },
    };
  }

  private disconnect(connection: Connection): void {
    connection.socket.destroy();
    const child = connection.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    }
  }

  private accept(socket: Socket): void {
    const connection: Connection = { socket };
    this.connections.add(connection);
    let lease: Lease | undefined;
    socket.on("error", () => this.disconnect(connection));
    socket.once("close", () => {
      this.connections.delete(connection);
      lease?.connections.delete(connection);
      this.disconnect(connection);
    });
    socket.setTimeout(5_000, () => socket.destroy());
    let pending = Buffer.alloc(0);
    const authenticate = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf(10);
      if (end < 0) { if (pending.length > 1024) socket.destroy(); return; }
      if (end > 1024) { socket.destroy(); return; }
      try {
        const input: unknown = JSON.parse(pending.subarray(0, end).toString("utf8"));
        if (!input || typeof input !== "object" || Object.keys(input).length !== 1
          || !("capability" in input) || typeof input.capability !== "string") throw new Error();
        lease = this.leases.get(input.capability);
        if (!lease || this.closed) throw new Error();
      } catch { socket.destroy(); return; }
      socket.pause();
      socket.off("data", authenticate);
      socket.setTimeout(0);
      lease.connections.add(connection);
      const child = spawn(this.launch.command, this.launch.args, {
        env: { ...process.env, ...lease.env }, stdio: ["pipe", "pipe", "pipe"],
      });
      connection.child = child;
      child.on("error", () => this.disconnect(connection));
      child.stdin.on("error", () => this.disconnect(connection));
      child.stdout.pipe(socket);
      // Diagnostics are never part of the JSON-RPC stream or sent to the agent.
      child.stderr.resume();
      child.once("exit", () => socket.end());
      const rest = pending.subarray(end + 1);
      if (rest.length) child.stdin.write(rest);
      pending = Buffer.alloc(0);
      socket.pipe(child.stdin);
      socket.resume();
    };
    socket.on("data", authenticate);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.leases.clear();
    for (const connection of this.connections) this.disconnect(connection);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

/** Agent-side stdio adapter. Its environment contains a route capability, never the bot token. */
export async function runMcpProxy(): Promise<void> {
  const path = process.env.TGFX_MCP_SOCKET;
  const capability = process.env.TGFX_MCP_CAPABILITY;
  if (!path || !capability) throw new Error("Missing Telegram MCP broker connection");
  const socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    const stop = () => socket.destroy();
    const cleanup = () => {
      process.stdin.unpipe(socket);
      process.stdin.pause();
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    socket.once("error", (error) => { cleanup(); reject(error); });
    socket.once("close", () => { cleanup(); resolve(); });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ capability })}\n`);
      socket.pipe(process.stdout, { end: false });
      process.stdin.pipe(socket);
    });
  });
}
