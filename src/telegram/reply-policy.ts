import type { ReplyPolicy, Route, TgfxConfig } from "../types";

export function replyPolicy(config: TgfxConfig, route: Pick<Route, "chatId" | "chatKind">): ReplyPolicy {
  return config.chatReplies?.[route.chatId]
    ?? (route.chatKind === "private" ? config.dmReply ?? "all" : config.groupReply ?? "mention");
}
