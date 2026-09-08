import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSupportedFxVersion, inspectFx, parseFxDoctor } from "../src/fx/preflight";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeFx(version: string) {
  const directory = await mkdtemp(join(tmpdir(), "tgfx-preflight-"));
  temporary.push(directory);
  const binary = join(directory, "fx");
  const log = join(directory, "events.jsonl");
  await Bun.write(binary, [
    `#!${process.execPath}`,
    `process.env.FAKE_FX_VERSION = ${JSON.stringify(version)};`,
    `process.env.FAKE_FX_LOG = ${JSON.stringify(log)};`,
    `await import(${JSON.stringify(resolve("tests/fixtures/fake-fx.ts"))});`,
  ].join("\n"));
  await chmod(binary, 0o700);
  return { binary, directory, log };
}

describe("fx startup preflight", () => {
  test("accepts a complete authenticated doctor report", () => {
    expect(parseFxDoctor(JSON.stringify({
      fail_count: 0, warn_count: 1, model: "grok-4.6", auth: "Grok subscription",
      workspace: "/project", checks: [{ name: "auth", status: "ok", detail: "ready" }],
    }))).toMatchObject({ fail_count: 0, model: "grok-4.6", auth: "Grok subscription" });
  });

  test("rejects malformed doctor output instead of claiming fx is ready", () => {
    expect(() => parseFxDoctor("not json")).toThrow("invalid JSON");
    expect(() => parseFxDoctor(JSON.stringify({ fail_count: 0 }))).toThrow("incomplete");
  });

  test.each(["0.0.6", "0.0.7", "0.0.7-dev.123"])("rejects unsupported fx %s", (version) => {
    expect(() => assertSupportedFxVersion(version)).toThrow("0.0.8");
  });

  test.each(["0.0.8", "v0.0.8-dev", "0.0.8+abc123", "0.0.9", "0.1.0", "1.0.0"])("accepts supported fx %s", (version) => {
    expect(() => assertSupportedFxVersion(version)).not.toThrow();
  });

  test("explains both upgrade channels when fx is too old", () => {
    let message = "";
    try { assertSupportedFxVersion("0.0.7"); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain("fx upgrade --channel stable");
    expect(message).toContain("fx upgrade --channel dev");
  });

  test("rejects unrecognized version output", () => {
    expect(() => assertSupportedFxVersion("not-a-version")).toThrow("could not parse");
  });

  test("checks the installed version before running doctor", async () => {
    const { binary, directory, log } = await fakeFx("0.0.7");
    await expect(inspectFx(binary, directory)).rejects.toThrow();
    const events = (await Bun.file(log).text()).trim().split("\n").map((line) => JSON.parse(line).event);
    expect(events).toEqual(["version"]);
  });

  test("inspects a supported development build", async () => {
    const { binary, directory } = await fakeFx("0.0.8-dev.123");
    const result = await inspectFx(binary, directory);
    expect(result.report.model).toBe("fake-default");
  });

  test("shows installation instructions when the fx binary is missing", async () => {
    const { directory } = await fakeFx("0.0.8");
    await expect(inspectFx(join(directory, "missing-fx"), directory)).rejects.toThrow("https://fx.sh/setup.sh");
  });
});
