import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { redactSecrets, setBotToken } from "../src/secrets";

describe("bot token secrets", () => {
  afterEach(() => {
    mock.restore();
  });

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
