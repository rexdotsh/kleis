import { proxyProviderMappings } from "../../providers/proxy-provider";
import { isObjectRecord, type JsonObject } from "../../utils/object";

type ModelsDevRegistry = JsonObject;

type BuildProxyModelsRegistryInput = {
  upstreamRegistry: ModelsDevRegistry;
  baseOrigin: string;
};

const KLEIS_PROVIDER_ID = "kleis";
const KLEIS_PROVIDER_NAME = "Kleis";
const PROXY_API_KEY_ENV = "KLEIS_API_KEY";
const MODELS_DEV_URL = "https://models.dev/api.json";
const CODEX_ALLOWED_OPENAI_MODEL_IDS = new Set([
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.1-codex",
]);

let inFlightFetch: Promise<ModelsDevRegistry> | null = null;

const parseRegistry = (value: unknown): ModelsDevRegistry => {
  if (!isObjectRecord(value)) {
    throw new Error("models.dev payload is not an object");
  }

  return value;
};

const fetchRegistry = async (url: string): Promise<ModelsDevRegistry> => {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`models.dev request failed with status ${response.status}`);
  }

  return parseRegistry(await response.json());
};

const normalizeOrigin = (value: string): string => value.replace(/\/+$/u, "");

const getNestedObject = (
  value: unknown,
  key: string
): Record<string, unknown> | null => {
  if (!isObjectRecord(value)) {
    return null;
  }

  const nested = value[key];
  return isObjectRecord(nested) ? nested : null;
};

const cloneJsonValue = <T>(value: T): T => {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
};

const cloneProviderModels = (input: {
  sourceModels: Record<string, unknown>;
  apiUrl: string;
  npm: string;
  modelPrefix?: string;
  sourceLabel?: string;
  shouldIncludeModel?: (modelId: string) => boolean;
}): JsonObject => {
  const models: JsonObject = {};
  for (const [modelId, modelValue] of Object.entries(input.sourceModels)) {
    if (input.shouldIncludeModel && !input.shouldIncludeModel(modelId)) {
      continue;
    }

    const proxyModelId = input.modelPrefix
      ? `${input.modelPrefix}/${modelId}`
      : modelId;

    if (!isObjectRecord(modelValue)) {
      models[proxyModelId] = modelValue;
      continue;
    }

    const model = cloneJsonValue(modelValue);
    const baseName =
      typeof model.name === "string" && model.name.trim()
        ? model.name
        : modelId;
    const providerOverrides = getNestedObject(model, "provider") ?? {};

    model.id = proxyModelId;
    if (input.sourceLabel) {
      model.name = `${baseName} (${input.sourceLabel})`;
    }
    model.provider = {
      ...providerOverrides,
      api: input.apiUrl,
      npm: input.npm,
    };
    models[proxyModelId] = model;
  }

  return models;
};

const isModelSupportedByProxyProvider = (
  internalProvider: (typeof proxyProviderMappings)[number]["internalProvider"],
  modelId: string
): boolean => {
  if (internalProvider !== "codex") {
    return true;
  }

  const normalizedModelId = modelId.toLowerCase();
  return (
    normalizedModelId.includes("codex") ||
    CODEX_ALLOWED_OPENAI_MODEL_IDS.has(normalizedModelId)
  );
};

const mergeKleisProviderModels = (
  registry: ModelsDevRegistry,
  baseOrigin: string
): JsonObject => {
  const models: JsonObject = {};

  for (const mapping of proxyProviderMappings) {
    const sourceProvider = getNestedObject(registry, mapping.canonicalProvider);
    if (!sourceProvider) {
      continue;
    }

    const providerModels = cloneProviderModels({
      sourceModels: getNestedObject(sourceProvider, "models") ?? {},
      apiUrl: `${baseOrigin}${mapping.routeBasePath}`,
      npm: mapping.npm,
      modelPrefix: mapping.canonicalProvider,
      sourceLabel: mapping.canonicalProvider,
      shouldIncludeModel: (modelId) =>
        isModelSupportedByProxyProvider(mapping.internalProvider, modelId),
    });
    Object.assign(models, providerModels);
  }

  return models;
};

const toKleisProviderEntry = (input: {
  registry: ModelsDevRegistry;
  baseOrigin: string;
}): JsonObject => {
  return {
    id: KLEIS_PROVIDER_ID,
    name: KLEIS_PROVIDER_NAME,
    env: [PROXY_API_KEY_ENV],
    models: mergeKleisProviderModels(input.registry, input.baseOrigin),
  };
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }

    result.push(normalized);
  }

  return result;
};

const mergeKleisProviderEntries = (
  existingProvider: Record<string, unknown>,
  generatedProvider: JsonObject
): JsonObject => {
  const provider = cloneJsonValue(existingProvider);
  const existingModels = getNestedObject(provider, "models") ?? {};
  const generatedModels = getNestedObject(generatedProvider, "models") ?? {};

  provider.models = {
    ...cloneJsonValue(generatedModels),
    ...cloneJsonValue(existingModels),
  };

  const env = new Set(toStringArray(provider.env));
  env.add(PROXY_API_KEY_ENV);
  provider.env = Array.from(env);

  if (typeof provider.id !== "string" || !provider.id.trim()) {
    provider.id = KLEIS_PROVIDER_ID;
  }

  if (typeof provider.name !== "string" || !provider.name.trim()) {
    provider.name = KLEIS_PROVIDER_NAME;
  }

  return provider;
};

const appendKleisProviderEntry = (input: {
  registry: ModelsDevRegistry;
  baseOrigin: string;
}): void => {
  const generatedProvider = toKleisProviderEntry({
    registry: input.registry,
    baseOrigin: input.baseOrigin,
  });
  const existingProvider = getNestedObject(input.registry, KLEIS_PROVIDER_ID);

  if (!existingProvider) {
    input.registry[KLEIS_PROVIDER_ID] = generatedProvider;
    return;
  }

  input.registry[KLEIS_PROVIDER_ID] = mergeKleisProviderEntries(
    existingProvider,
    generatedProvider
  );
};

export const getModelsDevRegistry = (): Promise<ModelsDevRegistry> => {
  if (inFlightFetch) {
    return inFlightFetch;
  }

  inFlightFetch = fetchRegistry(MODELS_DEV_URL).finally(() => {
    inFlightFetch = null;
  });

  return inFlightFetch;
};

export const buildProxyModelsRegistry = (
  input: BuildProxyModelsRegistryInput
): ModelsDevRegistry => {
  const registry: ModelsDevRegistry = cloneJsonValue(input.upstreamRegistry);
  const baseOrigin = normalizeOrigin(input.baseOrigin);

  appendKleisProviderEntry({
    registry,
    baseOrigin,
  });

  return registry;
};
