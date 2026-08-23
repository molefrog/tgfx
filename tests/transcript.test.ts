import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpTranscript } from "../src/fx/transcript";

describe("ACP wire transcript", () => {
  test("records split NDJSON chunks in both directions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "telefx-transcript-"));
    const path = join(directory, "turn.jsonl");
    const transcript = await AcpTranscript.create(path);
    const encoder = new TextEncoder();

    const outboundBytes: Uint8Array[] = [];
    const outbound = transcript.tapWritable(new WritableStream<Uint8Array>({
      write(chunk) {
        outboundBytes.push(chunk);
      },
    }));
    const writer = outbound.getWriter();
    await writer.write(encoder.encode('{"jsonrpc":"2.0","id":'));
    await writer.write(encoder.encode('1,"method":"initialize"}\n'));
    await writer.close();

    const inbound = transcript.tapReadable(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"jsonrpc":"2.0","id":1,'));
        controller.enqueue(encoder.encode('"result":{"protocolVersion":1}}\n'));
        controller.close();
      },
    }));
    await new Response(inbound).arrayBuffer();
    await transcript.close();

    const records = (await Bun.file(path).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(records).toHaveLength(3);
    expect(records[0].direction).toBe("meta");
    expect(records[1]).toMatchObject({
      direction: "client_to_fx",
      message: { jsonrpc: "2.0", id: 1, method: "initialize" },
      raw: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    });
    expect(records[2]).toMatchObject({
      direction: "fx_to_client",
      message: { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } },
    });
    expect(new TextDecoder().decode(Buffer.concat(outboundBytes))).toContain(
      '"method":"initialize"',
    );
  });
});
