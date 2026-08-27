import type { FxModelConfig, FxModelOption } from "../fx/acp";

export type ModelPickerButton = {
  text: string;
  callback_data: string;
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
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  google: "Google",
  mistral: "Mistral",
  moonshotai: "Moonshot",
  openai: "OpenAI",
  spacexai: "xAI",
  zai: "Z.ai",
};

type ProviderGroup = {
  id: string;
  name: string;
  models: Array<FxModelOption & { index: number }>;
};

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
    const slash = model.value.indexOf("/");
    const id = slash > 0 ? model.value.slice(0, slash) : "other";
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

export function providerPicker(data: ModelPickerData, requestedPage = 0): ModelPickerView {
  const groups = providers(data.options);
  const pages = Math.max(1, Math.ceil(groups.length / PROVIDERS_PER_PAGE));
  const page = clampPage(requestedPage, pages);
  const visible = groups.slice(page * PROVIDERS_PER_PAGE, (page + 1) * PROVIDERS_PER_PAGE);
  const buttons = visible.map((provider, offset) => ({
    text: `${provider.name} · ${provider.models.length}`,
    callback_data: callback(data.interactionId, `v.${page * PROVIDERS_PER_PAGE + offset}.0`),
  }));
  return {
    text: [
      "Choose a model",
      "",
      `Current: ${currentLabel(data)}`,
      "",
      "First choose a provider.",
    ].join("\n"),
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
): ModelPickerView | undefined {
  const provider = providers(data.options)[providerIndex];
  if (!provider) return undefined;
  const pages = Math.max(1, Math.ceil(provider.models.length / MODELS_PER_PAGE));
  const page = clampPage(requestedPage, pages);
  const visible = provider.models.slice(page * MODELS_PER_PAGE, (page + 1) * MODELS_PER_PAGE);
  return {
    text: [
      `Choose a model · ${provider.name}`,
      "",
      `Current: ${currentLabel(data)}`,
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        ...visible.map((model) => [{
          text: model.value === data.currentValue ? `Current · ${modelLabel(model)}` : modelLabel(model),
          callback_data: callback(data.interactionId, `s.${model.index}`),
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
    text: `Model changed to\n\n${model.name}`,
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
    text: `Could not change the model to ${model.name}.\n\nRun /model to try again.`,
    replyMarkup: { inline_keyboard: [] },
  };
}
