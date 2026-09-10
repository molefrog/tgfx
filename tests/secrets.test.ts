import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteBotToken, getBotToken, redactSecrets, setBotToken } from "../src/secrets";

describe("bot token secrets", () => {
  let directory: string;
  let originalHome: string | undefined;
  beforeEach(async () => {
    originalHome = process.env.TGFX_HOME;
    directory = await mkdtemp(join(tmpdir(), "tgfx-secrets-"));
    process.env.TGFX_HOME = directory;
  });
  afterEach(async () => {
    mock.restore();
    if (originalHome === undefined) delete process.env.TGFX_HOME;
    else process.env.TGFX_HOME = originalHome;
    await rm(directory, { recursive: true, force: true });
  });

  async function localToken(token = "123456:old-token"): Promise<string> {
    await mkdir(join(directory, "tokens"), { mode: 0o700 });
    const path = join(directory, "tokens", "123456.token");
    await Bun.write(path, token, { mode: 0o600 });
    return path;
  }

  test("stores the token using Bun's object-form secrets API", async () => {
    const set = spyOn(Bun.secrets, "set").mockResolvedValue(undefined);

    await setBotToken("123456", "123456:token");

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({
      service: "dev.tgfx",
      name: "telegram:123456",
      value: "123456:token",
    });
  });

  test.skipIf(process.platform === "linux")("keeps non-Linux keyring failures visible", async () => {
    spyOn(Bun.secrets, "set").mockRejectedValue(new Error("keyring locked"));
    await expect(setBotToken("123456", "123456:token")).rejects.toThrow("keyring locked");
  });

  test("a fallback token takes precedence over an older keyring token", async () => {
    await localToken();
    const get = spyOn(Bun.secrets, "get").mockResolvedValue("123456:stale-token");
    expect(await getBotToken("123456")).toBe("123456:old-token");
    expect(get).not.toHaveBeenCalled();
  });

  test("rotation keeps using the fallback after the keyring recovers", async () => {
    const path = await localToken();
    const set = spyOn(Bun.secrets, "set").mockResolvedValue(undefined);
    expect(await setBotToken("123456", "123456:new-token")).toBe(path);
    expect(await Bun.file(path).text()).toBe("123456:new-token");
    expect(set).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform === "win32")("rotation restores owner-only file and directory permissions", async () => {
    const path = await localToken();
    await chmod(path, 0o644);
    await chmod(join(directory, "tokens"), 0o755);
    await setBotToken("123456", "123456:new-token");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "tokens"))).mode & 0o777).toBe(0o700);
  });

  test("removing a fallback token cannot revive an older keyring token", async () => {
    const path = await localToken();
    spyOn(Bun.secrets, "get").mockResolvedValue("123456:stale-token");
    expect(await deleteBotToken("123456")).toBeTrue();
    expect(await Bun.file(path).text()).toBe("");
    expect(await getBotToken("123456")).toBeUndefined();
  });

  test("removing an already removed fallback token reports no token", async () => {
    await localToken("");
    expect(await deleteBotToken("123456")).toBeFalse();
  });

  test("auth can replace a previously removed fallback token", async () => {
    const path = await localToken("");
    await setBotToken("123456", "123456:new-token");
    expect(await Bun.file(path).text()).toBe("123456:new-token");
  });

  test("rejects bot IDs that could escape the token directory", async () => {
    await expect(setBotToken("../other", "secret")).rejects.toThrow("bot ID");
  });

  test("reports filesystem errors instead of reading a stale keyring token", async () => {
    await Bun.write(join(directory, "tokens"), "not a directory");
    await expect(getBotToken("123456")).rejects.toThrow();
  });
});

describe("redactSecrets", () => {
  test("redacts a Telegram bot token embedded in text", () => {
    const input = "Using token 6143594:AAH-dummytokenhashxxxxxxxxxxxxx for the bot";
    expect(redactSecrets(input)).toBe(
      "Using token [redacted Telegram token] for the bot",
    );
  });

  test("redacts a token embedded in a Bot API file URL", () => {
    const token = `123456789:${"A".repeat(30)}`;
    expect(redactSecrets(`https://api.telegram.org/file/bot${token}/photo.jpg`))
      .toBe("https://api.telegram.org/file/bot[redacted Telegram token]/photo.jpg");
  });

  test("redacts multiple tokens in one string", () => {
    const input = "old=6143594:AAH-oldtokenhashxxxxxxxxxxxxxxxx new=9999999:BBH-newtokenhashyyyyyyyyyyyyyyyy";
    expect(redactSecrets(input)).toBe(
      "old=[redacted Telegram token] new=[redacted Telegram token]",
    );
  });

  test("leaves plain text and numbers without token structure unchanged", () => {
    const input = "Chat 6143594 sent message 42 to -1002255001";
    expect(redactSecrets(input)).toBe(input);
  });

  test("preserves text with a colon that is not a token", () => {
    const input = "time: 12:30 and ratio 1:2";
    expect(redactSecrets(input)).toBe(input);
  });

  test("redacts a token with the minimum accepted length", () => {
    const input = "123456:AAAAAAAAAAAAAAAAAAAA";
    expect(redactSecrets(input)).toBe("[redacted Telegram token]");
  });

  test("does not redact a hash shorter than 20 characters", () => {
    const input = "123456:short";
    expect(redactSecrets(input)).toBe(input);
  });

  test("does not redact a bot id with fewer than 6 digits", () => {
    const input = "12345:AAAAAAAAAAAAAAAAAAAA";
    expect(redactSecrets(input)).toBe(input);
  });
});
