import { expect, test } from "bun:test";
import type { RichTextButton } from "grammy/types";
import { sessionConfirmation } from "../src/telegram/session-confirmation";
import { confirmationData } from "./fixtures/session-confirmation";

test.each(["clear", "compact"] as const)("/%s renders styled inline rich-message buttons", action => {
  const view = sessionConfirmation(action, "a".repeat(32));
  const paragraph = view.blocks![0]!;
  expect(paragraph.type).toBe("paragraph");
  if (paragraph.type !== "paragraph" || !Array.isArray(paragraph.text)) throw new Error("Missing paragraph");
  const buttons = paragraph.text.filter((part): part is RichTextButton =>
    typeof part === "object" && !Array.isArray(part) && part.type === "button");
  expect(buttons).toHaveLength(2);
  expect(buttons.map(part => part.button.style)).toEqual([action === "clear" ? "danger" : "primary", "link"]);
  for (const choice of ["confirm", "cancel"]) {
    const data = confirmationData(view, choice)!;
    expect(data).toBeDefined();
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  }
});
