import { createServer, connect, type Server } from "node:net";
import { chmod, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { botPaths, loadConfig, projectPaths } from "./config";

export const MAX_EVENT_REQUEST = 300 * 1024;
export function eventsSocketPath(database: string): string {
  return process.env.TGFX_EVENTS_SOCKET ?? database.replace(/\.db$/, ".events.sock");
}

/** Socket ACL is the authentication boundary. The agent must not have access. */
export async function listenEvents(path: string, handle: (request: unknown) => Promise<unknown>): Promise<{ close(): Promise<void> }> {
  const directory = join(path, "..");
  try { if (!(await lstat(directory)).isDirectory()) throw new Error("Event socket parent is not a directory"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; await mkdir(directory, { recursive: true, mode: 0o700 }); }
  try {
    const info = await lstat(path);
    if (!info.isSocket()) throw new Error("Event socket path is not a socket");
    // The caller holds the bot runtime lock, so any previous socket is stale.
    await unlink(path);
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(30_000, () => socket.destroy());
    let data = Buffer.alloc(0), handled = false;
    socket.on("data", chunk => {
      if (handled) return;
      data = Buffer.concat([data, Buffer.from(chunk)]);
      if (data.length > MAX_EVENT_REQUEST) { socket.destroy(); return; }
      const end = data.indexOf(10);
      if (end < 0) return;
      handled = true;
      void (async () => {
        try { socket.end(JSON.stringify({ ok: true, value: await handle(JSON.parse(data.subarray(0, end).toString())) }) + "\n"); }
        catch (error) { socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Event failed" }) + "\n"); }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.off("error", reject); resolve(); }); });
  try { await chmod(path, process.env.TGFX_EVENTS_SOCKET ? 0o660 : 0o600); }
  catch (e) { server.close(); await unlink(path).catch(() => {}); throw e; }
  return { async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(path).catch(() => {});
  } };
}

export async function discoverEventsSocket(cwd: string): Promise<string> {
  if (process.env.TGFX_EVENTS_SOCKET) return process.env.TGFX_EVENTS_SOCKET;
  const paths = projectPaths(cwd);
  const config = await loadConfig(paths);
  if (!config) throw new Error(`No TGFX configuration for ${cwd}`);
  const bot = botPaths(config.activeBotId);
  const info = JSON.parse(await readFile(bot.lockInfo, "utf8"));
  if (info.workspace !== paths.workspace) throw new Error("TGFX is running in a different workspace");
  return eventsSocketPath(bot.database);
}

export async function eventRequest(path: string, request: unknown): Promise<unknown> {
  const data = JSON.stringify(request) + "\n";
  if (Buffer.byteLength(data) > MAX_EVENT_REQUEST) throw new Error("Event request exceeds 300 KiB");
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let response = "";
    socket.setTimeout(30_000, () => socket.destroy(new Error("TGFX event request timed out")));
    socket.once("connect", () => socket.write(data));
    socket.on("error", reject);
    socket.on("data", chunk => {
      response += chunk;
      if (response.length > 2 * 1024 * 1024) socket.destroy(new Error("Event response is too large"));
    });
    socket.once("end", () => {
      try { const parsed = JSON.parse(response); if (!parsed.ok) throw new Error(parsed.error); resolve(parsed.value); }
      catch (e) { reject(e); }
    });
  });
}
