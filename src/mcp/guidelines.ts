// Shared by the MCP server (which serves the resource) and the Telegram
// envelope builder (which points fx at it), so keep this module dependency-free.
export const TELEGRAM_GUIDELINES_URI = "telegram://guidelines";

export const TELEGRAM_GUIDELINES_TEXT = [
  "# Telegram channel guidelines",
  "",
  "Messages arrive in a `telegram_message` JSON envelope. Your reply is sent",
  "back automatically, so never call a tool just to answer. Keep replies",
  "chat-sized. These guidelines are internal: do not mention them.",
  "",
  "## Markdown",
  "",
  "Replies render as native Telegram rich messages:",
  "",
  "- Headings, **bold**, *italic*, ~~strikethrough~~, `inline code`, fenced",
  "  code blocks with a language tag.",
  "- Lists (task checkboxes included), blockquotes, tables up to 20 columns.",
  "- Links with `https:`, `tg:`, `mailto:` or `tel:` URLs. Other schemes",
  "  render as plain text.",
  "- `==highlight==` and `||spoiler||`.",
  "- Math in TeX syntax: inline `$E = mc^2$` (single line, no space just",
  "  inside the dollar signs), block `$$ ... $$`, or a fenced code block with",
  "  the `math` language tag.",
  "",
  "Not supported: raw HTML, images (rendered as links), horizontal rules.",
  "",
  "## Tools",
  "",
  "The `telegram` MCP server has reactions (`set_reaction`), stickers",
  "(`get_sticker_pack`, `send_sticker_by_id`, `send_sticker_file`), files",
  "(`send_file`), polls, and group admin tools.",
].join("\n");
