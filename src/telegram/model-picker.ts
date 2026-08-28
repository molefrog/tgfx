import type { FxModelConfig, FxModelOption } from "../fx/acp";

export type ModelPickerButton = {
  text: string;
  callback_data: string;
  icon_custom_emoji_id?: string;
};

export type ModelPickerView = {
  text: string;
  replyMarkup: { inline_keyboard: ModelPickerButton[][] };
};

export type ModelPickerData = FxModelConfig & {
  interactionId: string;
};

const PROVIDERS_PER_PAGE = 6;
const MODELS_PER_PAGE = 6;

const PROVIDER_NAMES: Record<string, string> = {
  alibaba: "Alibaba",
  amazon: "AWS",
  "arcee-ai": "Arcee AI",
  anthropic: "Anthropic",
  aws: "AWS",
  azure: "Azure",
  bedrock: "Bedrock",
  bytedance: "ByteDance",
  codex: "Codex",
  cohere: "Cohere",
  deepinfra: "DeepInfra",
  deepseek: "DeepSeek",
  google: "Google",
  inception: "Inception Labs",
  inclusionai: "InclusionAI",
  interfaze: "Interfaze",
  kwaipilot: "KwaiPilot",
  meta: "Meta",
  minimax: "MiniMax",
  mistral: "Mistral",
  morph: "Morph",
  moonshotai: "Moonshot",
  nvidia: "NVIDIA",
  novita: "Novita AI",
  openai: "OpenAI",
  perplexity: "Perplexity",
  poolside: "Poolside",
  recraft: "Recraft",
  sakana: "Sakana AI",
  spacexai: "xAI",
  stepfun: "StepFun",
  tencent: "Tencent",
  thinkingmachines: "Thinking Machines",
  vertex: "Vertex AI",
  vertexai: "Vertex AI",
  voyage: "Voyage AI",
  xiaomi: "Xiaomi",
  zai: "Z.ai",
};

export type ProviderIconMap = Readonly<Record<string, string>>;

// This order mirrors manifest.json in the public tgfx custom emoji pack.
const PROVIDER_ICON_ALIASES: readonly (readonly string[])[] = [
  ["alibaba"],
  ["anthropic"],
  ["deepseek"],
  ["google"],
  ["mistral"],
  ["moonshot", "moonshotai"],
  ["openai"],
  ["spacexai", "xai"],
  ["zai"],
  ["amazon", "aws"],
  ["azure"],
  ["bedrock"],
  ["deepinfra"],
  ["meta"],
  ["novita"],
  ["recraft"],
  ["vertex", "vertexai"],
  ["voyage", "voyageai"],
  ["kwaipilot"],
  ["xiaomi"],
  ["nvidia"],
  ["poolside"],
  ["tencent"],
  ["arcee-ai"],
  ["inception"],
  ["bytedance"],
  ["cohere"],
  ["stepfun"],
  ["minimax"],
  ["perplexity"],
  ["morph"],
  ["sakana"],
  ["thinkingmachines"],
  ["inclusionai"],
  ["interfaze"],
  ["codex"],
];

// Stable IDs published by the tgfx pack utility. Telegram may return a stale
// getStickerSet snapshot to bots other than the pack creator, so these fill any
// positions that have not propagated yet.
const PROVIDER_ICON_FALLBACK_IDS: readonly string[] = [
  "5226565966158144571",
  "5226488832840474998",
  "5226984789894014413",
  "5226904869142567791",
  "5226434089187320556",
  "5226762555401217428",
  "5226629089292491967",
  "5224341327717642946",
  "5226834062311726876",
  "5226958749507298137",
  "5224543027971796744",
  "5226880808735773428",
  "5226716096739974456",
  "5226852204253583714",
  "5224650058556813870",
  "5226541828441940973",
  "5226655189808751631",
  "5226697516711456599",
  "5226475028815584417",
  "5226788058917022841",
  "5226571815903601186",
  "5229060186810918066",
  "5226925270237225889",
  "5226676338227719016",
  "5226767528973349304",
  "5228907608097728333",
  "5229062493208355899",
  "5226869366942900093",
  "5226782990855612215",
  "5229029198621878533",
  "5226920017492223412",
  "5226456375772618542",
  "5226528183330838677",
  "5229191144658739880",
  "5229187485346606266",
  "5229233944007844947",
];

export function providerIconsFromStickerSet(
  stickers: ReadonlyArray<{ custom_emoji_id?: string }>,
): ProviderIconMap {
  const icons: Record<string, string> = {};
  for (const [index, aliases] of PROVIDER_ICON_ALIASES.entries()) {
    const customEmojiId = stickers[index]?.custom_emoji_id ?? PROVIDER_ICON_FALLBACK_IDS[index];
    if (!customEmojiId) continue;
    for (const alias of aliases) icons[alias] = customEmojiId;
  }
  return icons;
}

type ProviderGroup = {
  id: string;
  name: string;
  models: Array<FxModelOption & { index: number }>;
};

const UNQUALIFIED_MODEL_PROVIDERS: readonly [prefix: string, provider: string][] = [
  ["grok-", "spacexai"],
  ["gpt-", "codex"],
  ["chatgpt-", "codex"],
  ["o1", "codex"],
  ["o3", "codex"],
  ["o4", "codex"],
  ["claude-", "anthropic"],
  ["deepseek-", "deepseek"],
  ["gemini-", "google"],
  ["gemma-", "google"],
  ["kimi-", "moonshotai"],
  ["nemotron-", "nvidia"],
  ["qwen", "alibaba"],
  ["glm-", "zai"],
  ["minimax-", "minimax"],
];

function providerId(model: FxModelOption): string {
  const slash = model.value.indexOf("/");
  if (slash > 0) return model.value.slice(0, slash);
  const value = model.value.toLowerCase();
  return UNQUALIFIED_MODEL_PROVIDERS.find(([prefix]) => value.startsWith(prefix))?.[1] ?? "other";
}

function callback(interactionId: string, action: string): string {
  return `model:${interactionId}:${action}`;
}

function clampPage(page: number, pages: number): number {
  return Math.max(0, Math.min(Number.isFinite(page) ? Math.floor(page) : 0, pages - 1));
}

function rowsOfTwo(buttons: ModelPickerButton[]): ModelPickerButton[][] {
  const rows: ModelPickerButton[][] = [];
  for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
  return rows;
}

function providers(models: FxModelOption[]): ProviderGroup[] {
  const grouped = new Map<string, ProviderGroup>();
  for (const [index, model] of models.entries()) {
    const id = providerId(model);
    let provider = grouped.get(id);
    if (!provider) {
      provider = { id, name: PROVIDER_NAMES[id] ?? (id === "other" ? "Other" : id), models: [] };
      grouped.set(id, provider);
    }
    provider.models.push({ ...model, index });
  }
  return [...grouped.values()];
}

function modelLabel(model: FxModelOption): string {
  if (model.name !== model.value) return model.name;
  const slash = model.value.indexOf("/");
  return slash > 0 ? model.value.slice(slash + 1) : model.value;
}

function currentLabel(data: ModelPickerData): string {
  const current = data.options.find((model) => model.value === data.currentValue);
  return current ? modelLabel(current) : data.currentValue;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function pickerTitle(data: ModelPickerData): string {
  return `Choose model: <b>${escapeHtml(currentLabel(data))}</b>`;
}

function navigation(
  data: ModelPickerData,
  page: number,
  pages: number,
  action: (page: number) => string,
): ModelPickerButton[] {
  return [
    ...(page > 0 ? [{ text: "‹ Previous", callback_data: callback(data.interactionId, action(page - 1)) }] : []),
    { text: `${page + 1} / ${pages}`, callback_data: callback(data.interactionId, "n") },
    ...(page + 1 < pages
      ? [{ text: "Next ›", callback_data: callback(data.interactionId, action(page + 1)) }]
      : []),
  ];
}

export function providerPicker(
  data: ModelPickerData,
  requestedPage = 0,
  icons: ProviderIconMap = {},
): ModelPickerView {
  const groups = providers(data.options);
  const pages = Math.max(1, Math.ceil(groups.length / PROVIDERS_PER_PAGE));
  const page = clampPage(requestedPage, pages);
  const visible = groups.slice(page * PROVIDERS_PER_PAGE, (page + 1) * PROVIDERS_PER_PAGE);
  const buttons = visible.map((provider, offset) => {
    const icon = icons[provider.id];
    return {
      text: `${provider.name} · ${provider.models.length}`,
      callback_data: callback(data.interactionId, `v.${page * PROVIDERS_PER_PAGE + offset}.0`),
      ...(icon ? { icon_custom_emoji_id: icon } : {}),
    };
  });
  return {
    text: pickerTitle(data),
    replyMarkup: {
      inline_keyboard: [
        ...rowsOfTwo(buttons),
        ...(pages > 1 ? [navigation(data, page, pages, (target) => `p.${target}`)] : []),
        [{ text: "Close", callback_data: callback(data.interactionId, "x") }],
      ],
    },
  };
}

export function modelPicker(
  data: ModelPickerData,
  providerIndex: number,
  requestedPage = 0,
  icons: ProviderIconMap = {},
): ModelPickerView | undefined {
  const provider = providers(data.options)[providerIndex];
  if (!provider) return undefined;
  const pages = Math.max(1, Math.ceil(provider.models.length / MODELS_PER_PAGE));
  const page = clampPage(requestedPage, pages);
  const visible = provider.models.slice(page * MODELS_PER_PAGE, (page + 1) * MODELS_PER_PAGE);
  const icon = icons[provider.id];
  return {
    text: pickerTitle(data),
    replyMarkup: {
      inline_keyboard: [
        ...visible.map((model) => [{
          text: model.value === data.currentValue ? `Current · ${modelLabel(model)}` : modelLabel(model),
          callback_data: callback(data.interactionId, `s.${model.index}`),
          ...(icon ? { icon_custom_emoji_id: icon } : {}),
        }]),
        ...(pages > 1
          ? [navigation(data, page, pages, (target) => `v.${providerIndex}.${target}`)]
          : []),
        [
          { text: "‹ Providers", callback_data: callback(data.interactionId, "p.0") },
          { text: "Close", callback_data: callback(data.interactionId, "x") },
        ],
      ],
    },
  };
}

export function selectedModel(model: FxModelOption): ModelPickerView {
  return {
    text: `Model changed to\n\n<b>${escapeHtml(model.name)}</b>`,
    replyMarkup: { inline_keyboard: [] },
  };
}

export function closedModelPicker(): ModelPickerView {
  return {
    text: "Model picker closed.",
    replyMarkup: { inline_keyboard: [] },
  };
}

export function failedModelSelection(model: FxModelOption): ModelPickerView {
  return {
    text: `Could not change the model to ${escapeHtml(model.name)}.\n\nRun /model to try again.`,
    replyMarkup: { inline_keyboard: [] },
  };
}
