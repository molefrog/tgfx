import { describe, expect, test } from "bun:test";
import { terminalQrCode } from "../src/cli/qr";

describe("terminal QR codes", () => {
  test("renders a compact, deterministic code for a Telegram deep link", () => {
    const url = "https://t.me/test_bot?start=tgfx_0123456789abcdef";
    const code = terminalQrCode(url);
    const lines = code.trimEnd().split("\n");

    expect(code).toBe(terminalQrCode(url));
    expect(code).not.toBe(terminalQrCode(`${url}0`));
    expect(lines.length).toBeGreaterThan(10);
    expect(new Set(lines.map((line) => line.length))).toEqual(new Set([lines[0]!.length]));
    expect(code).toMatch(/[\u2580\u2584\u2588]/);
  });
});
