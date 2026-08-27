import { describe, expect, test } from "bun:test";
import { parseFxUsage, type FxUsageReport } from "../src/fx/usage";
import { costReport } from "../src/telegram/cost-report";

const report: FxUsageReport = {
  kind: "usage",
  schema_version: 1,
  period: "24h",
  totals: {
    total_tokens: 9_884_362,
    input_tokens: 9_833_472,
    output_tokens: 50_890,
    cache_read_tokens: 7_938_042,
    cache_write_tokens: 0,
    reasoning_tokens: 21_649,
    request_count: 253,
    spend: 6.1857,
  },
  models: [{
    model: "zai/glm-5.2-fast",
    totals: {
      total_tokens: 9_653_614,
      input_tokens: 9_610_000,
      output_tokens: 43_614,
      cache_read_tokens: 7_800_000,
      cache_write_tokens: 0,
      reasoning_tokens: 20_000,
      request_count: 200,
      spend: 5.6345,
    },
  }],
};

describe("fx cost report", () => {
  test("validates fx usage JSON", () => {
    expect(parseFxUsage(JSON.stringify(report))).toEqual(report);
    expect(() => parseFxUsage("{}"))
      .toThrow("fx usage returned an incomplete report.");
  });

  test("renders rich Markdown with a model table and period-only buttons", () => {
    const view = costReport(report);
    expect(view.richMessage.blocks?.some((block) => block.type === "table")).toBeTrue();
    const table = view.richMessage.blocks?.find((block) => block.type === "table");
    expect(table).toEqual({
      type: "table",
      cells: [
        [
          { text: "Model", is_header: true, align: "left", valign: "top" },
          { text: "Cost", is_header: true, align: "right", valign: "top" },
          { text: "Tokens", is_header: true, align: "right", valign: "top" },
        ],
        [
          { text: "GLM 5.2 Fast", align: "left", valign: "top" },
          { text: "$5.63", align: "right", valign: "top" },
          { text: "9.65M", align: "right", valign: "top" },
        ],
      ],
    });
    expect(view.replyMarkup.inline_keyboard).toEqual([[
      { text: "24 hours", callback_data: "cost:n" },
      { text: "7 days", callback_data: "cost:7d" },
      { text: "30 days", callback_data: "cost:30d" },
    ]]);
    expect(view.replyMarkup.inline_keyboard.flat().some((button) => /refresh/i.test(button.text))).toBeFalse();
  });
});
