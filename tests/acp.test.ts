import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { FxRouteSession, sanitizeFxEnvironment } from "../src/fx/acp";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeBinary(options: { failLoad?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "tgfx-acp-"));
  temporary.push(directory);
  const binary = join(directory, "fx");
  const log = join(directory, "events.jsonl");
  const fixture = resolve("tests/fixtures/fake-fx.ts");
  await writeFile(binary, [
    "#!/bin/sh",
    `export FAKE_FX_LOG=${JSON.stringify(log)}`,
    ...(options.failLoad ? ["export FAKE_FX_FAIL_LOAD=1"] : []),
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} \"$@\"`,
    "",
  ].join("\n"));
  await chmod(binary, 0o700);
  return { directory, binary, log };
}

async function events(path: string): Promise<Array<{ event: string; value: any }>> {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("FX ACP transport", () => {
  test("does not expose Telegram host credentials to FX or its shell tools", () => {
    expect(sanitizeFxEnvironment({
      PATH: "/bin",
      OPENAI_API_KEY: "provider-owned-by-fx",
      TELEGRAM_BOT_TOKEN: "secret",
      TGFX_MCP_TOKEN: "secret",
      TGFX_MCP_ROUTE_KEY: "route",
      TGFX_INTERNAL_TELEGRAM_API_ROOT: "http://test",
    })).toEqual({ PATH: "/bin", OPENAI_API_KEY: "provider-owned-by-fx" });
  });

  test("preserves raw Markdown chunks through ACP untouched", async () => {
    const fake = await fakeBinary();
    const updates: acp.SessionUpdate[] = [];
    const session = new FxRouteSession({
      workspace: fake.directory,
      binary: fake.binary,
      onUpdate: (update) => { updates.push(update); },
    });
    try {
      await session.start();
      await session.prompt([{ type: "text", text: "RAW_MARKDOWN" }]);
    } finally {
      await session.dispose({ closeSession: true });
    }

    // Projecting these chunks into rich blocks is covered by projector.test.ts.
    const chunks = updates.flatMap((update) =>
      update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
        ? [update.content.text]
        : []
    );
    expect(chunks).toEqual([
      "# Section heading\n\nParagraph with **bold",
      "** and *italic*.",
    ]);
  });

  test("loads or replaces a session, selects auto mode, streams, asks permission, and cancels", async () => {
    const fake = await fakeBinary({ failLoad: true });
    const updates: acp.SessionUpdate[] = [];
    const session = new FxRouteSession({
      workspace: fake.directory,
      binary: fake.binary,
      model: "pinned-model",
      previousSessionId: "saved-session",
      mcp: { command: "tgfx", args: ["mcp"], env: { ROUTE: "route-1" } },
      onUpdate: (update) => { updates.push(update); },
    });
    try {
      const info = await session.start();
      expect(info).toEqual({
        sessionId: "fake-new-session",
        agentVersion: "9.9.9",
        model: "pinned-model",
        replacedPrevious: true,
      });
      const models = await session.modelConfig();
      expect(models.currentValue).toBe("pinned-model");
      expect(models.options.map((option) => option.value)).toContain("openai/gpt-5.6-sol");
      const changed = await session.setModel("openai/gpt-5.6-sol");
      expect(changed.currentValue).toBe("openai/gpt-5.6-sol");
      await expect(session.setModel("missing/model")).rejects.toThrow(
        "fx ACP does not offer model missing/model",
      );

      const response = await session.prompt([{ type: "text", text: "PERMISSION" }], {
        permission: async (request) => {
          expect(request.toolCall.rawInput).toEqual({ action: "test" });
          return { outcome: { outcome: "selected", optionId: "allow" } };
        },
      });
      expect(response.stopReason).toBe("end_turn");
      expect(updates).toContainEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "fake streamed text" },
      });

      const controller = new AbortController();
      const waiting = session.prompt([{ type: "text", text: "WAIT" }], { signal: controller.signal });
      await Bun.sleep(30);
      controller.abort(new Error("test cancellation"));
      await waiting;

      await expect(session.prompt([{
        type: "text",
        text: "x".repeat(8 * 1024 * 1024),
      }])).rejects.toThrow("Telegram prompt is too large for ACP");
    } finally {
      await session.dispose({ closeSession: true });
    }

    const log = await events(fake.log);
    expect(log.find((entry) => entry.event === "argv")?.value).toEqual(["acp", "--model", "pinned-model"]);
    expect(log.find((entry) => entry.event === "initialize")?.value.protocolVersion).toBe(1);
    expect(log.find((entry) => entry.event === "load")?.value.sessionId).toBe("saved-session");
    expect(log.find((entry) => entry.event === "new")?.value.mcpServers).toEqual([{
      name: "telegram", command: "tgfx", args: ["mcp"], env: [{ name: "ROUTE", value: "route-1" }],
    }]);
    expect(log.find((entry) => entry.event === "permission_mode")?.value).toBe("auto");
    expect(log.find((entry) => entry.event === "set_mode")?.value.modeId).toBe("code");
    expect(log.find((entry) => entry.event === "set_config_option")?.value).toEqual({
      sessionId: "fake-new-session",
      configId: "model",
      value: "openai/gpt-5.6-sol",
    });
    expect(log.find((entry) => entry.event === "permission_result")?.value.outcome.optionId).toBe("allow");
    expect(log.some((entry) => entry.event === "cancel")).toBeTrue();
    expect(log.some((entry) => entry.event === "close")).toBeTrue();
    expect(log.filter((entry) => entry.event === "prompt")).toHaveLength(2);
  });

  test("starts FX in yolo mode without replacing it through ACP", async () => {
    const fake = await fakeBinary();
    const session = new FxRouteSession({
      workspace: fake.directory,
      binary: fake.binary,
      permissionMode: "yolo",
    });
    try {
      await session.start();
    } finally {
      await session.dispose({ closeSession: true });
    }

    const log = await events(fake.log);
    expect(log.find((entry) => entry.event === "permission_mode")?.value).toBe("yolo");
    expect(log.some((entry) => entry.event === "set_mode")).toBeFalse();
  });
});
