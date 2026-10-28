import type { InputRichMessageWithoutUpload, Update } from "grammy/types";

export function confirmationData(rich: InputRichMessageWithoutUpload, choice = "confirm"): string | undefined {
  for (const block of rich.blocks ?? []) {
    if (block.type !== "paragraph" || !Array.isArray(block.text)) continue;
    for (const part of block.text) {
      if (typeof part === "object" && !Array.isArray(part) && part.type === "button"
        && "callback_data" in part.button && part.button.callback_data?.endsWith(`:${choice}`)) {
        return part.button.callback_data;
      }
    }
  }
}

export function confirmUpdate(rich: InputRichMessageWithoutUpload, messageId: number, updateId = 100): Update {
  return { update_id: updateId, callback_query: {
    id: `confirm-${updateId}`, chat_instance: "test", data: confirmationData(rich)!,
    from: { id: 42, is_bot: false, first_name: "User" },
    message: { message_id: messageId, date: 1, chat: { id: 42, type: "private", first_name: "User" } },
  } };
}
