const SERVICE = "dev.tgfx";

function name(botId: string): string {
  return `telegram:${botId}`;
}

export async function getBotToken(botId: string): Promise<string | undefined> {
  return (await Bun.secrets.get({ service: SERVICE, name: name(botId) })) ?? undefined;
}

export async function setBotToken(botId: string, token: string): Promise<void> {
  await Bun.secrets.set({ service: SERVICE, name: name(botId), value: token });
}

export async function deleteBotToken(botId: string): Promise<boolean> {
  return Bun.secrets.delete({ service: SERVICE, name: name(botId) });
}

export function tokenFromEnvironment(): string | undefined {
  const value = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return value || undefined;
}

export function redactSecrets(message: string): string {
  return message.replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, "[redacted Telegram token]");
}
