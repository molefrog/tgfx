import { TGFX_CUSTOM_ICONS } from "./custom-icon-set";

export type McpIconMap = Readonly<Record<string, string>>;

type Sticker = { custom_emoji_id?: string };

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

export function mcpIconsFromStickerSet(stickers: ReadonlyArray<Sticker>): McpIconMap {
  const icons: Record<string, string> = {};
  for (const icon of TGFX_CUSTOM_ICONS) {
    const id = stickers[icon.position]?.custom_emoji_id ?? icon.customEmojiId;
    for (const alias of icon.aliases) {
      const key = normalize(alias);
      icons[icon.kind === "tool" ? `tool:${key}` : key] = id;
    }
  }
  return icons;
}

export function fxToolIconForTool(icons: McpIconMap, identity: string): string | undefined {
  return icons[`tool:${normalize(identity)}`];
}

export function mcpIconForTool(icons: McpIconMap, identity: string): string | undefined {
  const normalized = normalize(identity);
  if (!normalized.startsWith("mcp_")) return undefined;
  const serverAndTool = normalized.slice(4);
  let matched = "";
  for (const alias of Object.keys(icons)) {
    if (serverAndTool !== alias && !serverAndTool.startsWith(`${alias}_`)) continue;
    if (alias.length > matched.length) matched = alias;
  }
  return matched ? icons[matched] : icons.mcp;
}
