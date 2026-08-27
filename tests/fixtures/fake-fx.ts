#!/usr/bin/env bun
import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

const logPath = process.env.FAKE_FX_LOG;
const record = (event: string, value: unknown = {}) => {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ event, value })}\n`);
};
if (process.argv[2] === "usage") {
  const period = process.argv[process.argv.indexOf("--period") + 1] ?? "24h";
  const multiplier = period === "30d" ? 30 : period === "7d" ? 7 : 1;
  record("usage", { period });
  console.log(JSON.stringify({
    kind: "usage",
    schema_version: 1,
    period,
    totals: {
      total_tokens: 9_884_362 * multiplier,
      input_tokens: 9_833_472 * multiplier,
      output_tokens: 50_890 * multiplier,
      cache_read_tokens: 7_938_042 * multiplier,
      cache_write_tokens: 0,
      reasoning_tokens: 21_649 * multiplier,
      request_count: 253 * multiplier,
      spend: 6.1857 * multiplier,
    },
    models: [{
      model: "zai/glm-5.2-fast",
      totals: {
        total_tokens: 9_653_614 * multiplier,
        input_tokens: 9_610_000 * multiplier,
        output_tokens: 43_614 * multiplier,
        cache_read_tokens: 7_800_000 * multiplier,
        cache_write_tokens: 0,
        reasoning_tokens: 20_000 * multiplier,
        request_count: 200 * multiplier,
        spend: 5.6345 * multiplier,
      },
    }],
  }));
  process.exit(0);
}
const modelIndex = process.argv.indexOf("--model");
let model = modelIndex >= 0 ? process.argv[modelIndex + 1] ?? "fake-default" : "fake-default";
const availableModels = [...new Set([
  model,
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-luna-fast",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-sol-fast",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-terra-fast",
  "openai/gpt-5.5",
])];
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
    options: availableModels.map((value) => ({ value, name: value })),
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
  .onRequest(acp.methods.agent.session.setConfigOption, ({ params }) => {
    record("set_config_option", params);
    if (params.configId !== "model" || typeof params.value !== "string" || !availableModels.includes(params.value)) {
      throw new Error("unsupported fake config option");
    }
    model = params.value;
    return { configOptions: sessionState().configOptions };
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    record("prompt", context.params);
    const text = context.params.prompt
      .flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    const rawMarkdown = text.includes("RAW_MARKDOWN");
    const messageChunks = rawMarkdown
      ? ["# Section heading\n\nParagraph with **bold", "** and *italic*."]
      : ["fake streamed text"];
    for (const chunk of messageChunks) {
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          ...(rawMarkdown ? { messageId: "fake-assistant-message" } : {}),
          content: { type: "text", text: chunk },
        },
      });
    }
    if (text.includes("COMMAND_RESULT")) {
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "terminal-extension",
          title: "Using terminal",
          kind: "execute",
          status: "pending",
        },
      });
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "terminal-extension",
          status: "completed",
          command_result: {
            command: "bun test --filter \"rich blocks\"",
            cwd: "/workspace",
            exit_code: 0,
          },
        },
      } as unknown as acp.SessionNotification);
    }
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
record("permission_mode", process.env.FX_PERMISSION_MODE);
const outgoing = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
const incoming = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
await app.connect(acp.ndJsonStream(outgoing, incoming));
