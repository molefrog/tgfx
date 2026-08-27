import type { InputRichMessageWithoutUpload } from "grammy/types";
import type { FxUsagePeriod, FxUsageReport } from "../fx/usage";
import { FX_USAGE_PERIODS } from "../fx/usage";
import { markdownToRichBlocks } from "./rich-markdown";

type CostButton = { text: string; callback_data: string };

export type CostReportView = {
  richMessage: InputRichMessageWithoutUpload;
  replyMarkup: { inline_keyboard: CostButton[][] };
};

const PERIOD_LABELS: Record<FxUsagePeriod, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

const WORDS: Record<string, string> = {
  claude: "Claude",
  deepseek: "DeepSeek",
  fast: "Fast",
  gemini: "Gemini",
  glm: "GLM",
  gpt: "GPT",
  kimi: "Kimi",
  pro: "Pro",
};

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function modelName(value: string): string {
  const slug = value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value;
  return slug.split("-").map((part) =>
    WORDS[part.toLowerCase()]
      ?? (/^[a-z]\d+$/i.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))
  ).join(" ");
}

function tableCell(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function markdown(report: FxUsageReport): string {
  const totals = report.totals;
  const sections = [
    "**Usage**",
    `_Last ${PERIOD_LABELS[report.period]}_`,
    `**\\$${totals.spend.toFixed(2)} spent** across **${totals.request_count.toLocaleString("en-US")} requests**  \n**${compactNumber(totals.total_tokens)} tokens** processed`,
    [
      "**Token breakdown**",
      "",
      `- Input: **${compactNumber(totals.input_tokens)}**`,
      `- Output: **${compactNumber(totals.output_tokens)}**`,
      `- Cache read: **${compactNumber(totals.cache_read_tokens)}**`,
      `- Reasoning: **${compactNumber(totals.reasoning_tokens)}**`,
    ].join("\n"),
  ];
  if (report.models.length) {
    sections.push([
      "| Model | Cost | Tokens |",
      "| :--- | ---: | ---: |",
      ...report.models.map(({ model, totals: modelTotals }) =>
        `| ${tableCell(modelName(model))} | \\$${modelTotals.spend.toFixed(2)} | ${compactNumber(modelTotals.total_tokens)} |`
      ),
    ].join("\n"));
  }
  return sections.join("\n\n");
}

export function costReport(report: FxUsageReport): CostReportView {
  return {
    richMessage: { blocks: markdownToRichBlocks(markdown(report)) },
    replyMarkup: {
      inline_keyboard: [FX_USAGE_PERIODS.map((period) => ({
        text: PERIOD_LABELS[period],
        callback_data: period === report.period ? "cost:n" : `cost:${period}`,
      }))],
    },
  };
}
