import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Update } from "grammy/types";
import { TgfxApp } from "../src/app";
import { workspacePaths } from "../src/config";
import { StateStore } from "../src/state";
import { TelegramApi } from "../src/telegram/api";
import { normalizeMessageUpdate } from "../src/telegram/normalize";
import { withTimeout } from "../src/timeout";
import { FakeTelegram } from "./fixtures/fake-telegram";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const bot = { id: "100", username: "fake_bot", displayName: "Bot" };
type Message = NonNullable<Update["message"]>;

function message(id: number, extra: Record<string, unknown> = {}): Message {
  return {
    message_id: id, date: 1_787_478_400,
    chat: { id: 42, type: "private", first_name: "Ada" },
    from: { id: 42, is_bot: false, first_name: "Ada" },
    text: `message ${id}`,
    ...extra,
  } as Message;
}

function forwarded(id: number, extra: Record<string, unknown> = {}): Message {
  return message(id, {
    forward_origin: { type: "hidden_user", date: 123, sender_user_name: `Source ${id}` },
    ...extra,
  });
}

async function harness(seed?: (state: StateStore) => void) {
  const workspace = await mkdtemp(join(tmpdir(), "tgfx-batches-"));
  cleanup.push(() => rm(workspace, { recursive: true, force: true }));
  process.env.TGFX_HOME = join(workspace, "home");
  const paths = workspacePaths(bot.id, workspace);
  const log = join(workspace, "fx.jsonl");
  const binary = join(workspace, "fx");
  await Bun.write(binary, `#!/bin/sh\nexport FAKE_FX_LOG='${log}'\nexec '${process.execPath}' '${resolve("tests/fixtures/fake-fx.ts")}' "$@"\n`);
  await chmod(binary, 0o700);
  const state = new StateStore(paths.database);
  state.ensurePollState(bot.id);
  seed?.(state);
  const telegram = new FakeTelegram();
  let turns = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const contexts: Array<ReturnType<StateStore["activeContext"]>> = [];
  const app = new TgfxApp({
    config: {
      version: 1, activeBotId: bot.id, access: { userIds: ["42", "43"], chatIds: ["-9"] },
      approvals: { chatId: "42", topicId: "0" }, output: "answer", customIcons: false,
    },
    bot, paths, token: "100:test", fxBinary: binary,
    telegram: new TelegramApi("100:test", telegram.url),
    log: (event) => {
      if (event.event === "turn.started") {
        contexts.push(state.activeContext(`100:${event.chat}:${event.topic}`));
      }
      if (event.event === "turn.delivered") {
        turns++;
        for (const waiter of waiters) if (turns >= waiter.count) waiter.resolve();
      }
    },
  });
  const running = app.run();
  const close = async () => {
    await app.stop();
    await running;
    await telegram.stop();
  };
  cleanup.push(async () => { await close(); state.close(); });
  await telegram.waitForCalls("getUpdates");
  return {
    state, telegram, contexts, close,
    push: (...messages: Message[]) => messages.forEach((message) => telegram.push({ message })),
    wait: (count = 1) => withTimeout(new Promise<void>((resolve) => {
      if (turns >= count) resolve();
      else waiters.push({ count, resolve });
    }), 5_000, () => { throw new Error("turn did not finish"); }),
    prompts: async () => (await Bun.file(log).text()).trim().split("\n")
      .map((line) => JSON.parse(line)).filter((event) => event.event === "prompt")
      .map((event) => event.value.prompt as Array<{ text: string }>),
  };
}

function envelopes(prompt: Array<{ text: string }>) {
  return prompt.filter((block) => block.text.startsWith("{\n"))
    .map((block) => JSON.parse(block.text).telegram_message);
}

test("delivers a text-free location pin to FX", async () => {
  const h = await harness();
  h.push(message(1, { text: undefined, location: { latitude: 1, longitude: 2 } }));
  await h.wait();
  expect(envelopes((await h.prompts())[0]!)[0].location).toBeDefined();
});

test("runs ten forwards from successive polls as one durable turn", async () => {
  const h = await harness();
  h.push(...Array.from({ length: 5 }, (_, i) => forwarded(i + 1)));
  // Wait for the cursor to acknowledge the first poll before adding the rest.
  await h.telegram.waitForRequest((r) => r.method === "getUpdates" && r.payload.offset === 6);
  h.push(...Array.from({ length: 5 }, (_, i) => forwarded(i + 6)));
  await h.wait();
  await h.close();
  expect(await h.prompts()).toHaveLength(1);
  expect(h.state.db.query("SELECT count(*) AS n FROM telegram_inbox WHERE status='done'").get()).toEqual({ n: 10 });
  expect(h.telegram.calls("sendRichMessage")).toHaveLength(1);
});

test("keeps every forwarded text, source and message reference in order", async () => {
  const h = await harness();
  h.push(forwarded(1), forwarded(2));
  await h.wait();
  const prompt = (await h.prompts())[0]!;
  expect(JSON.parse(prompt[0]!.text).telegram_batch).toMatchObject({ kind: "forwarded", count: 2 });
  const items = envelopes(prompt);
  expect(items.map((item) => item.provenance.forward_origin.sender_user_name)).toEqual(["Source 1", "Source 2"]);
  expect(prompt.filter((block) => block.text.startsWith("message ")).map((block) => block.text)).toEqual(["message 1", "message 2"]);
  for (const item of items) {
    expect(h.state.messageReference(item.message.ref, "100:42:0")?.message_id).toBe(item.message.message_id);
  }
});

test("makes all forwarded album attachments available in the shared turn context", async () => {
  const h = await harness();
  const photo = (id: number) => forwarded(id, {
    text: undefined, caption: `caption ${id}`, media_group_id: "album",
    photo: [{ file_id: `file-${id}`, file_unique_id: `unique-${id}`, width: 10, height: 10 }],
  });
  h.push(photo(1), photo(2), forwarded(3));
  await h.wait();
  const items = envelopes((await h.prompts())[0]!);
  const context = h.contexts[0]!;
  expect(JSON.parse(context.attachments_json).map((a: { ref: string }) => a.ref))
    .toEqual(items.flatMap((item) => item.attachments.map((a: { ref: string }) => a.ref)));
  expect(items.map((item) => item.context_ref)).toEqual(Array(3).fill(context.context_ref));
  expect(items.slice(0, 2).map((item) => item.attachments.length)).toEqual([1, 1]);
});

test("dispatches a forwarded batch before the following ordinary message", async () => {
  const h = await harness();
  h.push(forwarded(1), forwarded(2), message(3));
  await h.wait(2);
  const prompts = await h.prompts();
  expect(prompts).toHaveLength(2);
  expect(JSON.parse(prompts[0]![0]!.text)).toHaveProperty("telegram_batch");
  expect(envelopes(prompts[1]!)[0].message.message_id).toBe("3");
});

test("treats forwarded slash commands as content", async () => {
  const h = await harness();
  h.push(forwarded(1, { text: "/clear" }), forwarded(2, { text: "/stop" }));
  await h.wait();
  const prompt = (await h.prompts())[0]!;
  expect(prompt.map((block) => block.text)).toContain("/clear");
  expect(prompt.map((block) => block.text)).toContain("/stop");
  expect(h.telegram.calls("sendMessage")).toHaveLength(0);
});

test("keeps forwarded batches separate by sender within a group", async () => {
  const h = await harness();
  const group = { chat: { id: -9, type: "supergroup", title: "Team" }, text: "@fake_bot read", entities: [{ type: "mention", offset: 0, length: 9 }] };
  h.push(forwarded(1, group), forwarded(2, { ...group, from: { id: 43, is_bot: false, first_name: "Grace" } }));
  await h.wait(2);
  expect((await h.prompts()).map((p) => envelopes(p)[0].sender.user_id)).toEqual(["42", "43"]);
});

test("keeps forwarded batches separate by topic", async () => {
  const h = await harness();
  const group = { chat: { id: -9, type: "supergroup", title: "Team" }, text: "@fake_bot read", entities: [{ type: "mention", offset: 0, length: 9 }] };
  h.push(forwarded(1, { ...group, message_thread_id: 7 }), forwarded(2, { ...group, message_thread_id: 8 }));
  await h.wait(2);
  expect((await h.prompts()).map((p) => envelopes(p)[0].scope.topic_id).sort()).toEqual(["7", "8"]);
});

test("discards buffered forwards when the user sends stop", async () => {
  const h = await harness();
  h.push(forwarded(1), forwarded(2), message(3, { text: "/stop" }));
  await h.telegram.waitForCalls("sendMessage");
  await h.close();
  expect(h.state.db.query("SELECT status FROM telegram_inbox WHERE update_id=1").get()).toEqual({ status: "discarded" });
  expect(h.contexts).toHaveLength(0);
});

test.each([false, true])("recovers forwarded messages after restart (coalesced: %s)", async (coalesced) => {
  const h = await harness((state) => {
    const messages = [1, 2].map((id) => normalizeMessageUpdate(bot, { update_id: id, message: forwarded(id) } as Update)!);
    state.ensureRoute(messages[0]!.route);
    const ids = messages.map((message) => state.ingestUpdate({
      botId: bot.id, updateId: message.updateId, routeKey: message.route.key,
      authorized: true, payload: { kind: "message", message },
    })!);
    if (coalesced) state.coalesceInbox(ids[0]!, { kind: "forwarded", messages }, ids.slice(1));
  });
  await h.wait();
  await h.close();
  const prompts = await h.prompts();
  expect(prompts).toHaveLength(1);
  expect(envelopes(prompts[0]!)).toHaveLength(2);
});

test("still combines an ordinary media album", async () => {
  const h = await harness();
  h.push(...[1, 2].map((id) => message(id, {
    text: undefined, caption: id === 1 ? "album caption" : undefined, media_group_id: "album",
    photo: [{ file_id: `file-${id}`, file_unique_id: `unique-${id}`, width: 10, height: 10 }],
  })));
  await h.wait();
  const prompt = (await h.prompts())[0]!;
  const item = envelopes(prompt)[0];
  expect(item.attachments).toHaveLength(2);
  expect(item.provenance.album.map((member: { attachment_refs: string[] }) => member.attachment_refs.length)).toEqual([1, 1]);
});
