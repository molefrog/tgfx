import type { Update } from "grammy/types";

export type PrivatePairing = {
  updateId: number;
  userId: string;
  chatId: string;
  displayName: string;
  username?: string;
};

export function privatePairingFromUpdate(update: Update, payload: string): PrivatePairing | undefined {
  const message = update.message;
  if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return undefined;
  if (message.text?.trim() !== `/start ${payload}`) return undefined;
  return {
    updateId: update.update_id,
    userId: String(message.from.id),
    chatId: String(message.chat.id),
    displayName: [message.from.first_name, message.from.last_name].filter(Boolean).join(" ")
      || message.from.username || "Telegram user",
    ...(message.from.username ? { username: message.from.username } : {}),
  };
}
