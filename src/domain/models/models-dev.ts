import { proxyProviderMappings } from "../../providers/proxy-provider";
import type { Provider } from "../../db/schema";
import { isObjectRecord, type JsonObject } from "../../utils/object";

type ModelsDevRegistry = JsonObject;

type BuildProxyModelsRegistryInput = {
  upstreamRegistry: ModelsDevRegistry;
  baseOrigin: string;
  configuredProviders: readonly Provider[];
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

const patchCanonicalProviders = (input: {
  registry: ModelsDevRegistry;
  upstreamRegistry: ModelsDevRegistry;
  baseOrigin: string;
  configuredProviders: ReadonlySet<Provider>;
}): void => {
  for (const mapping of proxyProviderMappings) {
    if (!input.configuredProviders.has(mapping.internalProvider)) {
      continue;
    }

    const sourceProvider = getNestedObject(
      input.upstreamRegistry,
      mapping.canonicalProvider
    );
    if (!sourceProvider) {
      continue;
    }

    const apiUrl = `${input.baseOrigin}${mapping.routeBasePath}`;
    const provider = cloneJsonValue(sourceProvider);
    provider.id = mapping.canonicalProvider;
    provider.env = [PROXY_API_KEY_ENV];
    provider.api = apiUrl;
    provider.npm = mapping.npm;
    provider.models = cloneProviderModels({
      sourceModels: getNestedObject(sourceProvider, "models") ?? {},
      apiUrl,
      npm: mapping.npm,
      shouldIncludeModel: (modelId) =>
        isModelSupportedByProxyProvider(mapping.internalProvider, modelId),
    });
    input.registry[mapping.canonicalProvider] = provider;
  }
};

const mergeKleisProviderModels = (
  registry: ModelsDevRegistry,
  baseOrigin: string,
  configuredProviders: ReadonlySet<Provider>
): JsonObject => {
  const models: JsonObject = {};

  for (const mapping of proxyProviderMappings) {
    if (!configuredProviders.has(mapping.internalProvider)) {
      continue;
    }

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
  configuredProviders: ReadonlySet<Provider>;
}): JsonObject => {
  return {
    id: KLEIS_PROVIDER_ID,
    name: KLEIS_PROVIDER_NAME,
    env: [PROXY_API_KEY_ENV],
    models: mergeKleisProviderModels(
      input.registry,
      input.baseOrigin,
      input.configuredProviders
    ),
  };
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
  const configuredProviders = new Set(input.configuredProviders);

  patchCanonicalProviders({
    registry,
    upstreamRegistry: input.upstreamRegistry,
    baseOrigin,
    configuredProviders,
  });

  registry[KLEIS_PROVIDER_ID] = toKleisProviderEntry({
    registry,
    baseOrigin,
    configuredProviders,
  });

  return registry;
};
