import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { setBotToken } from "../src/secrets";

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
