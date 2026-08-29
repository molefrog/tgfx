import { describe, expect, test } from "bun:test";
import { assertSupportedFxVersion, parseFxDoctor } from "../src/fx/preflight";

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

  test("requires FX 0.0.7 or newer", () => {
    expect(() => assertSupportedFxVersion("0.0.6")).toThrow("0.0.7 or newer");
    expect(() => assertSupportedFxVersion("not-a-version")).toThrow("could not parse");
    expect(() => assertSupportedFxVersion("0.0.7")).not.toThrow();
    expect(() => assertSupportedFxVersion("v0.0.8-dev")).not.toThrow();
    expect(() => assertSupportedFxVersion("0.1.0")).not.toThrow();
  });
});
