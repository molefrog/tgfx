export const TELEGRAM_MCP_TOOL_ROW_TITLES = {
  set_reaction: "Reacting to Telegram message",
  download_attachment: "Downloading Telegram attachment",
  send_file: "Sending workspace file",
  request_choice: "Asking Telegram user to choose",
  create_poll: "Creating Telegram poll",
  set_pinned_message: "Setting managed pinned message",
  pin_message: "Pinning referenced message",
  unpin_message: "Unpinning referenced message",
  manage_topic: "Managing forum topic",
  delete_messages: "Deleting Telegram messages",
  moderate_member: "Moderating Telegram member",
  review_join_request: "Reviewing chat join request",
} as const;

export type TelegramMcpToolName = keyof typeof TELEGRAM_MCP_TOOL_ROW_TITLES;
