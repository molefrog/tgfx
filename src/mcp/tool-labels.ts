export const TELEGRAM_MCP_TOOL_ROW_TITLES = {
  set_reaction: "Reacting to message",
  download_attachment: "Downloading attachment",
  send_file: "Sending file",
  send_photo: "Sending photo",
  send_voice: "Sending voice message",
  send_video_note: "Sending circular video",
  get_sticker_pack: "Loading sticker pack",
  send_sticker_by_id: "Sending sticker",
  send_sticker_file: "Sending sticker",
  request_choice: "Asking for a choice",
  create_poll: "Creating poll",
  set_pinned_message: "Setting pinned message",
  pin_message: "Pinning message",
  unpin_message: "Unpinning message",
  manage_topic: "Managing topic",
  delete_messages: "Deleting messages",
  moderate_member: "Moderating member",
  review_join_request: "Reviewing join request",
} as const;

export type TelegramMcpToolName = keyof typeof TELEGRAM_MCP_TOOL_ROW_TITLES;
