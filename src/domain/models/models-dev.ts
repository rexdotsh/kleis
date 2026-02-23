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
  modelPrefix: string;
  sourceLabel: string;
}): JsonObject => {
  const models: JsonObject = {};
  for (const [modelId, modelValue] of Object.entries(input.sourceModels)) {
    const prefixedModelId = `${input.modelPrefix}/${modelId}`;

    if (!isObjectRecord(modelValue)) {
      models[prefixedModelId] = modelValue;
      continue;
    }

    const model = cloneJsonValue(modelValue);
    const upstreamModelId =
      typeof model.id === "string" && model.id.trim() ? model.id : modelId;
    const baseName =
      typeof model.name === "string" && model.name.trim()
        ? model.name
        : upstreamModelId;
    const providerOverrides = getNestedObject(model, "provider") ?? {};

    model.id = prefixedModelId;
    model.name = `${baseName} (${input.sourceLabel})`;
    model.provider = {
      ...providerOverrides,
      api: input.apiUrl,
      npm: input.npm,
    };
    models[prefixedModelId] = model;
  }

  return models;
};

const mergeKleisProviderModels = (
  upstreamRegistry: ModelsDevRegistry,
  baseOrigin: string
): JsonObject => {
  const models: JsonObject = {};

  for (const mapping of proxyProviderMappings) {
    const sourceProvider =
      getNestedObject(upstreamRegistry, mapping.canonicalProvider) ?? null;
    if (!sourceProvider) {
      continue;
    }

    const providerModels = cloneProviderModels({
      sourceModels: getNestedObject(sourceProvider, "models") ?? {},
      apiUrl: `${baseOrigin}${mapping.routeBasePath}`,
      npm: mapping.npm,
      modelPrefix: mapping.canonicalProvider,
      sourceLabel: mapping.canonicalProvider,
    });
    Object.assign(models, providerModels);
  }

  return models;
};

const toKleisProviderEntry = (input: {
  upstreamRegistry: ModelsDevRegistry;
  baseOrigin: string;
}): JsonObject => {
  const baseOrigin = normalizeOrigin(input.baseOrigin);

  return {
    id: KLEIS_PROVIDER_ID,
    name: KLEIS_PROVIDER_NAME,
    env: [PROXY_API_KEY_ENV],
    models: mergeKleisProviderModels(input.upstreamRegistry, baseOrigin),
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

  registry[KLEIS_PROVIDER_ID] = toKleisProviderEntry({
    upstreamRegistry: input.upstreamRegistry,
    baseOrigin: input.baseOrigin,
  });

  return registry;
};
