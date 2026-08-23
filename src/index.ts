import { streamFxAcp } from "./fx/acp";
import { FX_DEMO_PROMPT, FX_TOOL_PROBE_PROMPT } from "./fx/demo";
import { FxTelegramProjector } from "./fx/projector";
import { createAcpTranscriptPath } from "./fx/transcript";
import type { FxMirrorMode } from "./fx/types";
import { isAbsolute, relative, resolve } from "node:path";
import { streamTelegramFrames } from "./stream";
import {
  TelegramApiError,
  TelegramClient,
  type TelegramMessage,
} from "./telegram";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN. Copy .env.example to .env and add your bot token.");
  process.exit(1);
}

const updateEveryMs = Number(process.env.STREAM_UPDATE_MS ?? 800);
if (!Number.isFinite(updateEveryMs) || updateEveryMs < 800) {
  console.error("STREAM_UPDATE_MS must be a number of at least 800.");
  process.exit(1);
}

const allowedUserIds = process.env.TELEGRAM_ALLOWED_USER_IDS
  ? new Set(
      process.env.TELEGRAM_ALLOWED_USER_IDS.split(",").map((value) =>
        Number(value.trim())
      ),
    )
  : undefined;
if (allowedUserIds && [...allowedUserIds].some((id) => !Number.isSafeInteger(id) || id <= 0)) {
  console.error("TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of positive integers.");
  process.exit(1);
}

const workspace = process.cwd();
const configuredLogDirectory = process.env.FX_ACP_LOG_DIR || "logs/acp";
const acpLogDirectory = isAbsolute(configuredLogDirectory)
  ? configuredLogDirectory
  : resolve(workspace, configuredLogDirectory);
const telegram = new TelegramClient(token);
const shutdown = new AbortController();
const chatQueues = new Map<number, Promise<void>>();
let offset = 0;

interface FxCommand {
  mode: FxMirrorMode;
  prompt: string;
  probe: boolean;
}

function parseFxCommand(text: string): FxCommand | undefined {
  const command = text.trim().split(/\s+/u);
  const commandName = command[0]?.split("@", 1)[0]?.toLowerCase();

  if (commandName === "/fx_raw") {
    return { mode: "raw", prompt: FX_DEMO_PROMPT, probe: false };
  }
  if (commandName === "/fx_timeline") {
    return { mode: "timeline", prompt: FX_DEMO_PROMPT, probe: false };
  }
  if (commandName === "/fx_collapse") {
    return { mode: "collapse", prompt: FX_DEMO_PROMPT, probe: false };
  }
  if (commandName !== "/fx" && commandName !== "/fx_probe") return undefined;

  const requested = command[1]?.toLowerCase();
  const mode = requested === undefined ? "timeline" : requested;
  if (requested === "raw" || requested === "timeline" || requested === "collapse") {
    return {
      mode: requested,
      prompt: commandName === "/fx_probe" ? FX_TOOL_PROBE_PROMPT : FX_DEMO_PROMPT,
      probe: commandName === "/fx_probe",
    };
  }
  if (mode !== "timeline") return undefined;
  return {
    mode,
    prompt: commandName === "/fx_probe" ? FX_TOOL_PROBE_PROMPT : FX_DEMO_PROMPT,
    probe: commandName === "/fx_probe",
  };
}

async function runFxDemo(
  message: TelegramMessage,
  command: FxCommand,
): Promise<void> {
  const { mode, prompt, probe } = command;
  const projector = new FxTelegramProjector(mode);
  const turn = new AbortController();
  const stopTurn = () => turn.abort(shutdown.signal.reason);
  shutdown.signal.addEventListener("abort", stopTurn, { once: true });
  const transcriptPath = createAcpTranscriptPath(acpLogDirectory);

  async function* frames() {
    for await (const event of streamFxAcp({
      prompt,
      workspace,
      binary: process.env.FX_BINARY || "fx",
      model: process.env.FX_ACP_MODEL || undefined,
      transcriptPath,
      signal: turn.signal,
    })) {
      const projected = projector.apply(event);
      if (projected) yield projected;
    }
  }

  let failure: unknown;
  try {
    await streamTelegramFrames({
      telegram,
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id,
      frames: frames(),
      updateEveryMs,
    });
  } catch (error) {
    failure = error;
  } finally {
    turn.abort(new Error("Telegram mirror finished"));
    shutdown.signal.removeEventListener("abort", stopTurn);
  }

  const localPath = relative(workspace, transcriptPath) || transcriptPath;
  await telegram.sendMessage(
    message.chat.id,
    `${failure === undefined ? "ACP transcript saved" : "Partial ACP transcript saved"}: ${localPath}${probe ? "\nTool probe complete; the JSONL contains both wire directions." : ""}`,
    message.message_thread_id,
  ).catch((error) => console.error("Could not report ACP transcript path:", error));

  if (failure !== undefined) throw failure;
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  if (!message.text) return;

  if (allowedUserIds && (!message.from || !allowedUserIds.has(message.from.id))) {
    await telegram.sendMessage(
      message.chat.id,
      "This telefx instance is private.",
      message.message_thread_id,
    );
    return;
  }

  if (message.chat.type !== "private") {
    await telegram.sendMessage(
      message.chat.id,
      "Telegram live drafts currently work only in private chats. Open my profile and run /fx there.",
      message.message_thread_id,
    );
    return;
  }

  const command = message.text.trim().split(/\s/u, 1)[0]!
    .split("@", 1)[0]!
    .toLowerCase();
  if (command === "/start" || command === "/help") {
    await telegram.sendMessage(
      message.chat.id,
      [
        "telefx runs a real Vercel FX session over ACP and mirrors it through Telegram live drafts.",
        "",
        "/fx raw — diagnostics, tool inputs when available, results, and response",
        "/fx timeline — response and persistent tool-call lines",
        "/fx collapse — response with only the current tool line visible",
        "/fx_probe — broad read-only tool gallery with raw ACP JSONL logging",
        "/id — show your Telegram user ID for the local allowlist",
        "",
        "This POC always sends the same read-only prompt to FX; Telegram message injection is intentionally not enabled yet.",
      ].join("\n"),
      message.message_thread_id,
    );
    return;
  }

  if (command === "/id") {
    await telegram.sendMessage(
      message.chat.id,
      `Your Telegram user ID is ${message.from?.id ?? "unavailable"}.`,
      message.message_thread_id,
    );
    return;
  }

  const fxCommand = parseFxCommand(message.text);
  if (!fxCommand) {
    await telegram.sendMessage(
      message.chat.id,
      "Use /fx raw, /fx timeline, /fx collapse, or /fx_probe.",
      message.message_thread_id,
    );
    return;
  }

  try {
    await runFxDemo(message, fxCommand);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`FX ${fxCommand.mode} run failed:`, error);
    await telegram.sendMessage(
      message.chat.id,
      `FX run failed: ${detail.slice(0, 500)}`,
      message.message_thread_id,
    );
  }
}

function enqueueMessage(message: TelegramMessage): void {
  const previous = chatQueues.get(message.chat.id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => handleMessage(message))
    .catch((error) => console.error("Message handler failed:", error))
    .finally(() => {
      if (chatQueues.get(message.chat.id) === next) {
        chatQueues.delete(message.chat.id);
      }
    });
  chatQueues.set(message.chat.id, next);
}

async function main(): Promise<void> {
  const me = await telegram.getMe();
  await telegram.setMyCommands([
    { command: "fx", description: "Run the FX timeline demo" },
    { command: "fx_raw", description: "Mirror raw ACP details" },
    { command: "fx_timeline", description: "Keep all tool-call lines" },
    { command: "fx_collapse", description: "Collapse completed tool calls" },
    { command: "fx_probe", description: "Run the broad FX tool gallery" },
    { command: "id", description: "Show your Telegram user ID" },
    { command: "help", description: "Explain telefx commands" },
  ]).catch((error) => {
    console.warn("Could not update the Telegram command menu:", error);
  });
  console.log(`telefx is running as @${me.username ?? me.first_name}`);
  console.log("Send /fx timeline in a private chat. Press Ctrl+C to stop.");
  if (!allowedUserIds) {
    console.warn("No TELEGRAM_ALLOWED_USER_IDS allowlist is configured.");
  }

  while (!shutdown.signal.aborted) {
    try {
      const updates = await telegram.getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) enqueueMessage(update.message);
      }
    } catch (error) {
      if (shutdown.signal.aborted) break;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`Polling failed: ${detail}`);

      if (error instanceof TelegramApiError && error.status === 409) {
        console.error("Another getUpdates process or a webhook is active for this bot.");
        process.exitCode = 1;
        break;
      }
      await Bun.sleep(1_500);
    }
  }

  await Promise.allSettled(chatQueues.values());
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log("\nStopping Telegram polling and active FX sessions…");
    shutdown.abort(new Error(`Received ${signal}`));
  });
}

await main();
