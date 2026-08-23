import { describe, expect, test } from "bun:test";
import { parseFxDoctor } from "../src/fx/preflight";

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
});
