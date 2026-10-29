import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { discoverEventsSocket, eventRequest } from "../event-socket";

export async function emitCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    cwd: { type: "string" }, chat: { type: "string" }, topic: { type: "string" },
    id: { type: "string" }, payload: { type: "string" }, "payload-file": { type: "string" },
    prompt: { type: "string" }, steer: { type: "boolean" }, wait: { type: "boolean" },
    status: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("tgfx emit <event-name> [--payload JSON | --payload-file FILE|-] [--id ID] [--chat ID] [--topic ID] [--cwd PATH] [--prompt TEXT] [--steer] [--wait]\ntgfx emit --status ID [--cwd PATH]\nNo --chat: a persistent background conversation, with no Telegram delivery.");
    return;
  }
  const path = await discoverEventsSocket(resolve(values.cwd ?? process.cwd()));
  if (values.status) { console.log(JSON.stringify(await eventRequest(path, { op: "get", id: values.status }))); return; }
  if (positionals.length !== 1) throw new Error("Specify one event name; see tgfx emit --help");
  if (values.payload && values["payload-file"]) throw new Error("Choose --payload or --payload-file");
  const raw = values["payload-file"] ? await (values["payload-file"] === "-" ? Bun.stdin : Bun.file(values["payload-file"])).text() : values.payload;
  const event = { name: positionals[0], ...(values.id ? { id: values.id } : {}),
    payload: raw === undefined ? null : JSON.parse(raw), ...(values.chat ? { chatId: values.chat } : {}),
    ...(values.topic ? { topicId: values.topic } : {}), steer: values.steer ?? false,
    ...(values.prompt ? { prompt: values.prompt } : {}) };
  let job = await eventRequest(path, { op: "emit", event }) as { id: string; status: string };
  while (values.wait && ["queued", "running"].includes(job.status)) {
    await Bun.sleep(250);
    job = await eventRequest(path, { op: "get", id: job.id }) as typeof job;
  }
  console.log(JSON.stringify(job));
  if (["failed", "interrupted", "cancelled"].includes(job.status)) process.exitCode = 1;
}
