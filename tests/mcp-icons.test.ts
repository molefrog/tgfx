import { describe, expect, test } from "bun:test";
import { fxToolIconForTool, mcpIconForTool, mcpIconsFromStickerSet } from "../src/telegram/mcp-icons";

describe("MCP custom icons", () => {
  test("maps live pack positions and server aliases to MCP tool identities", () => {
    const stickers = Array.from({ length: 159 }, (_, index) => ({ custom_emoji_id: `emoji-${index}` }));
    const icons = mcpIconsFromStickerSet(stickers);

    expect(mcpIconForTool(icons, "mcp_github_search_code")).toBe("emoji-53");
    expect(mcpIconForTool(icons, "mcp_google_drive_search_files")).toBe("emoji-57");
    expect(mcpIconForTool(icons, "mcp_playwright_browser_navigate")).toBe("emoji-123");
    expect(mcpIconForTool(icons, "mcp_chrome_devtools_take_screenshot")).toBe("emoji-42");
    expect(mcpIconForTool(icons, "mcp_openai_responses_create")).toBe("emoji-6");
    expect(mcpIconForTool(icons, "mcp_unknown_service_call")).toBe("emoji-105");
    expect(mcpIconForTool(icons, "read_file")).toBeUndefined();
    expect(fxToolIconForTool(icons, "read_file")).toBe("emoji-141");
    expect(fxToolIconForTool(icons, "mcp_search_tools")).toBe("emoji-153");
    expect(fxToolIconForTool(icons, "mcp_github_search_code")).toBeUndefined();
  });

  test("uses stable IDs when Telegram returns a stale pack snapshot", () => {
    const icons = mcpIconsFromStickerSet([]);
    expect(mcpIconForTool(icons, "mcp_github_search_code")).toBe("5231279684175569128");
    expect(mcpIconForTool(icons, "mcp_unknown_service_call")).toBe("5231020053402527360");
    expect(fxToolIconForTool(icons, "terminal")).toBe("5231454064142762787");
  });

  test("renders no MCP icon when the caller supplies no icon map", () => {
    expect(mcpIconForTool({}, "mcp_github_search_code")).toBeUndefined();
    expect(fxToolIconForTool({}, "read_file")).toBeUndefined();
  });
});
