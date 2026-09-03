import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { withTimeout } from "../src/timeout";

describe("withTimeout", () => {
  test("returns the work's value when it settles before the deadline", async () => {
    expect(await withTimeout(Promise.resolve("done"), 1_000, () => "late")).toBe("done");
  });

  test("returns the fallback when the deadline wins", async () => {
    const never = new Promise<string>(() => undefined);
    expect(await withTimeout(never, 5, () => "late")).toBe("late");
  });

  test("rejects with what expire throws", async () => {
    const never = new Promise<string>(() => undefined);
    await expect(withTimeout(never, 5, () => { throw new Error("too slow"); })).rejects.toThrow("too slow");
  });

  test("a finished race leaves no timer holding the process open", async () => {
    // A separate process is the only honest check: a pending timer keeps Bun
    // alive until it fires, which is exactly the bug this helper exists for.
    const script = `
      import { withTimeout } from ${JSON.stringify(resolve("src/timeout.ts"))};
      await withTimeout(Promise.resolve(1), 60_000, () => 2);
      console.log("settled");
    `;
    const started = performance.now();
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(stdout.trim()).toBe("settled");
    expect(exitCode).toBe(0);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
