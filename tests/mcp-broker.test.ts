import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TelegramMcpBroker } from "../src/mcp/broker";
import { withTimeout } from "../src/timeout";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "tgfx-broker-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o2750);
  const broker = await TelegramMcpBroker.listen(root, {
    command: process.execPath, args: [resolve("src/index.ts"), "mcp"],
  });
  cleanup.push(() => broker.close());
  const lease = broker.lease({
    TGFX_MCP_TOKEN: `100000:${"x".repeat(24)}`,
    TGFX_MCP_BOT_ID: "100", TGFX_MCP_ROUTE_KEY: "100:42:0",
    TGFX_MCP_WORKSPACE: root, TGFX_MCP_HOME: join(root, "private"),
    TGFX_MCP_DATABASE: join(root, "private", "100.db"),
    TGFX_MCP_FILES: join(root, "files"), TGFX_MCP_APPROVALS_CHAT: "42",
    TGFX_MCP_ALLOWED_CHATS: "[]",
  });
  return { root, broker, lease };
}

async function clientFor(launch: { command: string; args: string[]; env: Record<string, string> }) {
  const transport = new StdioClientTransport({ ...launch, stderr: "pipe" });
  const client = new Client({ name: "broker-test", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(transport);
  return client;
}

test("serves real MCP through an uncredentialed proxy and ignores forged route environment", async () => {
  const { broker, lease } = await setup();
  expect(Object.keys(lease.launch.env).sort()).toEqual(["TGFX_MCP_CAPABILITY", "TGFX_MCP_SOCKET"]);
  expect((await stat(broker.path)).mode & 0o777).toBe(0o660);
  expect((await stat(broker.path.replace(/\/[^/]+$/, ""))).mode & 0o7777).toBe(0o2750);
  const client = await clientFor({
    ...lease.launch,
    env: { ...lease.launch.env, TGFX_MCP_ROUTE_KEY: "100:-999:0", TGFX_MCP_ALLOWED_CHATS: '["-999"]' },
  });
  const resources = await client.listResources();
  expect(resources.resources.some((resource) => resource.uri === "telegram://guidelines")).toBeTrue();
  const tools = await client.listTools();
  expect(tools.tools.some((tool) => tool.name === "set_reaction")).toBeTrue();
  expect(tools.tools.some((tool) => tool.name === "moderate_member")).toBeFalse();
});

test("revoking a session disconnects its proxy and prevents reuse of its capability", async () => {
  const { lease } = await setup();
  const client = await clientFor(lease.launch);
  const closed = Promise.withResolvers<void>();
  client.onclose = () => closed.resolve();
  lease.revoke();
  await withTimeout(closed.promise, 3_000, () => { throw new Error("Proxy stayed connected"); });
  await expect(clientFor(lease.launch)).rejects.toThrow();
});

test("rejects invalid or extended broker handshakes without starting an MCP server", async () => {
  const { broker, lease } = await setup();
  for (const message of [
    { capability: "unknown" },
    { capability: lease.launch.env.TGFX_MCP_CAPABILITY, env: { TGFX_MCP_TOKEN: "forged" } },
  ]) {
    const socket = connect(broker.path);
    const closed = Promise.withResolvers<void>();
    socket.on("error", () => undefined);
    socket.once("close", () => closed.resolve());
    socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    await withTimeout(closed.promise, 3_000, () => { socket.destroy(); throw new Error("Invalid client was accepted"); });
  }
});
