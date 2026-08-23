#!/usr/bin/env bun
import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

const logPath = process.env.FAKE_FX_LOG;
const record = (event: string, value: unknown = {}) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ event, value })}\n`);
};
const modelIndex = process.argv.indexOf("--model");
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] ?? "fake-default" : "fake-default";
let cancelled: (() => void) | undefined;

const sessionState = () => ({
  modes: {
    currentModeId: "code",
    availableModes: [
      { id: "ask", name: "Ask" },
      { id: "code", name: "Code" },
    ],
  },
  configOptions: [{
    type: "select" as const,
    id: "model",
    name: "Model",
    currentValue: model,
    options: [{ value: model, name: model }],
  }],
});

const app = acp.agent({ name: "fake-fx" })
  .onRequest(acp.methods.agent.initialize, ({ params }) => {
    record("initialize", params);
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: "fake-fx", title: "Fake 𝒇x", version: "9.9.9" },
      authMethods: [],
    };
  })
  .onRequest(acp.methods.agent.session.load, ({ params }) => {
    record("load", params);
    if (process.env.FAKE_FX_FAIL_LOAD === "1") throw new Error("missing saved session");
    return sessionState();
  })
  .onRequest(acp.methods.agent.session.new, async (context) => {
    record("new", context.params);
    await context.client.notify(acp.methods.client.session.update, {
      sessionId: "fake-new-session",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "status", description: "Show fake status" },
          { name: "model", description: "Switch fake model" },
          { name: "compact", description: "Compact fake context" },
        ],
      },
    });
    return { sessionId: "fake-new-session", ...sessionState() };
  })
  .onRequest(acp.methods.agent.session.setMode, ({ params }) => {
    record("set_mode", params);
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    record("prompt", context.params);
    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "fake streamed text" },
      },
    });
    const text = context.params.prompt
      .flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    if (text.includes("PERMISSION")) {
      const decision = await context.client.request(acp.methods.client.session.requestPermission, {
        sessionId: context.params.sessionId,
        toolCall: {
          toolCallId: "tool-1", title: "Use Telegram", kind: "other", status: "pending",
          rawInput: { action: "test" },
        },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      record("permission_result", decision);
    }
    if (text.includes("WAIT")) await new Promise<void>((resolve) => { cancelled = resolve; });
    return { stopReason: "end_turn" as const };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    record("cancel", params);
    cancelled?.();
    cancelled = undefined;
  })
  .onRequest(acp.methods.agent.session.close, ({ params }) => {
    record("close", params);
    return {};
  });

record("argv", process.argv.slice(2));
const outgoing = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
const incoming = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
await app.connect(acp.ndJsonStream(outgoing, incoming));
