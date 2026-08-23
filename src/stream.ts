import {
  TelegramApiError,
  type TelegramClient,
  type TelegramMessageEntity,
} from "./telegram";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DRAFT_KEEPALIVE_MS = 20_000;

function truncateText(text: string, limit = 4096): string {
  let truncated = text.slice(0, limit);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

export function createDraftId(): number {
  // Telegram requires a non-zero Integer. Keep it in signed 31-bit range so it
  // stays portable across JSON implementations.
  return (crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff) || 1;
}

export function splitIntoChunks(text: string): string[] {
  // Approximate model tokens for a dependency-free demo: words, numbers, and
  // punctuation are separate, with following whitespace kept on each token.
  return (
    text.match(
      /(?:\p{L}+(?:['’]\p{L}+)*)\s*|(?:\p{N}+)\s*|(?:[^\p{L}\p{N}\s]+)\s*|\s+/gu,
    ) ?? []
  );
}

export async function* simulateGeneration(text: string): AsyncGenerator<string> {
  for (const chunk of splitIntoChunks(text)) {
    yield chunk;
    // Deliberately slow enough to make each Telegram refresh reveal only a
    // couple of token-sized chunks while staying under Telegram's rate limit.
    await sleep(260 + Math.floor(Math.random() * 100));
  }
}

export function visibleEntities(
  entities: TelegramMessageEntity[],
  visibleLength: number,
): TelegramMessageEntity[] {
  return entities.flatMap((entity) => {
    if (entity.offset >= visibleLength) return [];

    return [{
      ...entity,
      length: Math.min(entity.length, visibleLength - entity.offset),
    }];
  });
}

export interface TelegramStreamFrame {
  text: string;
  entities?: TelegramMessageEntity[];
}

export async function streamTelegramFrames(options: {
  telegram: TelegramClient;
  chatId: number;
  messageThreadId?: number;
  frames: AsyncIterable<TelegramStreamFrame>;
  updateEveryMs?: number;
}): Promise<string> {
  const {
    telegram,
    chatId,
    messageThreadId,
    frames,
    updateEveryMs = 800,
  } = options;

  if (updateEveryMs < 800) {
    throw new Error("updateEveryMs must be at least 800ms to respect Telegram rate limits");
  }

  const draftId = createDraftId();
  let latestFrame: TelegramStreamFrame = { text: "", entities: [] };
  let lastSentSignature = "";
  let lastUpdateAt = 0;

  const sendDraft = async (frame: TelegramStreamFrame): Promise<void> => {
    const text = truncateText(frame.text);
    const entities = visibleEntities(frame.entities ?? [], text.length);

    try {
      await telegram.sendMessageDraft(
        chatId,
        draftId,
        text,
        messageThreadId,
        entities,
      );
    } catch (error) {
      if (!(error instanceof TelegramApiError) || !error.retryAfter) throw error;
      await sleep(error.retryAfter * 1_000);
      await telegram.sendMessageDraft(
        chatId,
        draftId,
        text,
        messageThreadId,
        entities,
      );
    }

    lastSentSignature = JSON.stringify({ text, entities });
    lastUpdateAt = Date.now();
  };

  // An empty draft is rendered as Telegram's native “Thinking…” placeholder.
  await sendDraft(latestFrame);

  // Consume ACP continuously while a separate loop refreshes Telegram. This
  // coalesces fast token/tool bursts into the freshest frame, but guarantees a
  // pending frame becomes visible after at most one update interval.
  const iterator = frames[Symbol.asyncIterator]();
  let revision = 0;
  let sentRevision = 0;
  let hasFrame = false;
  let done = false;
  let failure: unknown;
  let wakeActivity!: () => void;
  let activity = new Promise<void>((resolve) => {
    wakeActivity = resolve;
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const notifyActivity = () => {
    wakeActivity();
    activity = new Promise<void>((resolve) => {
      wakeActivity = resolve;
    });
  };

  const producer = (async () => {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const text = truncateText(next.value.text);
        latestFrame = {
          text,
          entities: visibleEntities(next.value.entities ?? [], text.length),
        };
        hasFrame = true;
        revision++;
        notifyActivity();
      }
    } catch (error) {
      failure = error;
    } finally {
      done = true;
      wakeActivity();
      finish();
    }
  })();

  try {
    while (!done) {
      if (revision !== sentRevision) {
        const delay = Math.max(0, updateEveryMs - (Date.now() - lastUpdateAt));
        if (delay > 0) await Promise.race([sleep(delay), finished]);
        if (done) break;

        const sendingRevision = revision;
        await sendDraft(latestFrame);
        sentRevision = sendingRevision;
        continue;
      }

      const keepaliveDelay = Math.max(
        0,
        DRAFT_KEEPALIVE_MS - (Date.now() - lastUpdateAt),
      );
      await Promise.race([activity, sleep(keepaliveDelay), finished]);
      if (!done && revision === sentRevision && Date.now() - lastUpdateAt >= DRAFT_KEEPALIVE_MS) {
        await sendDraft(latestFrame);
      }
    }

    await producer;
    if (failure !== undefined) throw failure;
    if (!hasFrame) throw new Error("Stream completed without producing a message");
  } catch (error) {
    // Do not let a stuck upstream read delay a Telegram error. Returning the
    // iterator is best-effort; runFxDemo also aborts the FX child process.
    if (!done) void iterator.return?.().catch(() => undefined);
    throw error;
  }

  const finalEntities = visibleEntities(
    latestFrame.entities ?? [],
    latestFrame.text.length,
  );
  const finalSignature = JSON.stringify({
    text: latestFrame.text,
    entities: finalEntities,
  });

  if (finalSignature !== lastSentSignature) {
    await sendDraft(latestFrame);
  }

  // Drafts are ephemeral. A normal message commits the finished response and
  // causes clients to remove the live draft.
  await telegram.sendMessage(
    chatId,
    latestFrame.text,
    messageThreadId,
    finalEntities,
  );
  return latestFrame.text;
}

export async function streamTelegramMessage(options: {
  telegram: TelegramClient;
  chatId: number;
  messageThreadId?: number;
  chunks: AsyncIterable<string>;
  entities?: TelegramMessageEntity[];
  updateEveryMs?: number;
}): Promise<string> {
  const {
    telegram,
    chatId,
    messageThreadId,
    chunks,
    entities = [],
    updateEveryMs = 800,
  } = options;

  let fullText = "";

  async function* frames(): AsyncGenerator<TelegramStreamFrame> {
    for await (const chunk of chunks) {
      fullText = truncateText(fullText + chunk);
      yield {
        text: fullText,
        entities: visibleEntities(entities, fullText.length),
      };
      if (fullText.length === 4096) break;
    }
  }

  return streamTelegramFrames({
    telegram,
    chatId,
    messageThreadId,
    frames: frames(),
    updateEveryMs,
  });
}
