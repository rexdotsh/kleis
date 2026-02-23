import {
  proxyProviderMappings,
  type ProxyProviderMapping,
} from "../../providers/proxy-provider";
import { isObjectRecord, type JsonObject } from "../../utils/object";

type ModelsDevRegistry = JsonObject;

type BuildProxyModelsRegistryInput = {
  upstreamRegistry: ModelsDevRegistry;
  baseOrigin: string;
};

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

const cloneProviderModels = (
  sourceModels: Record<string, unknown>,
  apiUrl: string,
  npm: string
): JsonObject => {
  const models: JsonObject = {};
  for (const [modelId, modelValue] of Object.entries(sourceModels)) {
    if (!isObjectRecord(modelValue)) {
      models[modelId] = modelValue;
      continue;
    }

    const model = cloneJsonValue(modelValue);
    const providerOverrides = getNestedObject(model, "provider") ?? {};
    model.provider = {
      ...providerOverrides,
      api: apiUrl,
      npm,
    };
    models[modelId] = model;
  }

  return models;
};

const toProxyProviderEntry = (
  mapping: ProxyProviderMapping,
  sourceProvider: Record<string, unknown> | null,
  baseOrigin: string
): JsonObject => {
  const apiUrl = `${baseOrigin}${mapping.routeBasePath}`;
  const models = cloneProviderModels(
    getNestedObject(sourceProvider, "models") ?? {},
    apiUrl,
    mapping.npm
  );
  const cloned = sourceProvider ? cloneJsonValue(sourceProvider) : {};
  const name =
    typeof sourceProvider?.name === "string" && sourceProvider.name.trim()
      ? sourceProvider.name
      : mapping.defaultName;

  return {
    ...cloned,
    id: mapping.canonicalProvider,
    name,
    env: [PROXY_API_KEY_ENV],
    npm: mapping.npm,
    api: apiUrl,
    models,
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

  for (const mapping of proxyProviderMappings) {
    const sourceProvider =
      getNestedObject(input.upstreamRegistry, mapping.canonicalProvider) ??
      null;
    registry[mapping.canonicalProvider] = toProxyProviderEntry(
      mapping,
      sourceProvider,
      baseOrigin
    );
  }

  return registry;
};
