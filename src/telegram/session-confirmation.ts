import type { InputRichMessageWithoutUpload } from "grammy/types";

export type SessionAction = "clear" | "compact";
export const SESSION_ACTION_CALLBACK = "session";

/** Bot API 10.3 buttons live inside the message, rather than its keyboard. */
export function sessionConfirmation(action: SessionAction, id: string): InputRichMessageWithoutUpload {
  const clear = action === "clear";
  return { blocks: [{ type: "paragraph", text: [
    clear
      ? "Start a fresh conversation? This stops the current task and discards queued requests. Files are kept. "
      : "Compact this conversation? FX will summarize its context after any queued tasks finish. ",
    { type: "button", button: {
      text: clear ? "Clear conversation" : "Compact conversation",
      style: clear ? "danger" : "primary",
      callback_data: `${SESSION_ACTION_CALLBACK}:${id}:confirm`,
    } },
    " ",
    { type: "button", button: {
      text: "Cancel", style: "link", callback_data: `${SESSION_ACTION_CALLBACK}:${id}:cancel`,
    } },
  ] }] };
}
