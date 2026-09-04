import { OUTPUT_MODES, REPLY_STYLES, type OutputMode } from "../types";

export type ReplyStyleView = {
  text: string;
  replyMarkup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
};

/** Callback data of a /format button: `fmt:<mode>`. */
export const REPLY_STYLE_CALLBACK = "fmt";

/**
 * The /format card: every reply style with its hint, and a 2×2 grid of buttons
 * with the current one ticked. Stateless, so an old card keeps working.
 */
export function replyStylePicker(current: OutputMode): ReplyStyleView {
  const lines = OUTPUT_MODES.map((mode) => {
    const style = REPLY_STYLES[mode];
    const name = mode === current ? `<b>${style.name}</b>` : style.name;
    return `${mode === current ? "✓" : "·"} ${name} — ${style.hint}`;
  });
  const button = (mode: OutputMode) => ({
    text: `${mode === current ? "✓ " : ""}${REPLY_STYLES[mode].name}`,
    callback_data: `${REPLY_STYLE_CALLBACK}:${mode}`,
  });
  return {
    text: `<b>Reply style</b>\n\n${lines.join("\n")}`,
    replyMarkup: { inline_keyboard: [[button("answer"), button("report")], [button("progress"), button("live")]] },
  };
}
