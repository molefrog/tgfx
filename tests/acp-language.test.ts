import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FxRouteSession } from "../src/fx/acp";
import { normalizeMessageUpdate, toEnvelope } from "../src/telegram/normalize";

// Opt in with TGFX_TEST_FX_BINARY=/absolute/path/to/fx; the provider stays local.
const binary = process.env.TGFX_TEST_FX_BINARY;
test.skipIf(!binary)("FX accepts a Russian reply to a short mention with English Telegram metadata", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "tgfx-language-"));
  const reply = "Привет! Я здесь и готов помочь.";
  let calls = 0;
  const gateway = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/coding-agent/v1/models") {
        return Response.json({ data: [{ id: "openai/gpt-5", type: "language", tags: ["tool-use"] }] });
      }
      if (request.method !== "POST") return new Response("Not found", { status: 404 });
      calls++;
      const events = [
        { type: "text-delta", id: "answer", delta: reply },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 3 }, outputTokens: { total: 5 } } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } });
    },
  });
  const baseUrl = `http://127.0.0.1:${gateway.port}`;
  const environment = {
    AI_GATEWAY_API_KEY: "offline-test-key", VERCEL_OIDC_TOKEN: "", FX_AUTO_UPGRADE: "0",
    FX_GATEWAY_BASE_URL: baseUrl, FX_GATEWAY_CHAT_URL: `${baseUrl}/v3/ai/language-model`,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const session = new FxRouteSession({ workspace, binary: binary!, model: "openai/gpt-5" });
  let received = "";
  session.onUpdate((update) => {
    if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") received += update.content.text;
  });
  try {
    const message = normalizeMessageUpdate({ id: "100", username: "fxharness_bot", displayName: "Bot" }, {
      update_id: 1, message: { message_id: 1, date: 1,
        chat: { id: -9, type: "group", title: "Team" },
        from: { id: 42, is_bot: false, first_name: "Alexey", language_code: "en" },
        text: "@fxharness_bot суп",
      },
    })!;
    await session.prompt([
      { type: "text", text: JSON.stringify(toEnvelope(message), null, 2) },
      { type: "text", text: message.text! },
    ]);
    expect(received).toContain(reply);
    expect(calls).toBe(1);
  } finally {
    await session.dispose({ closeSession: true });
    await gateway.stop(true);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(workspace, { recursive: true, force: true });
  }
});
