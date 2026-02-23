import type { RuntimeConfig } from "../../config/runtime";
import type { Provider } from "../../db/schema";
import {
  proxyProviderMappings,
  type ProxyProviderMapping,
} from "../../providers/proxy-provider";
import { isObjectRecord, type JsonObject } from "../../utils/object";

type ModelsDevRegistry = JsonObject;

type CacheEntry = {
  fetchedAt: number;
  registry: ModelsDevRegistry;
};

type BuildProxyModelsRegistryInput = {
  upstreamRegistry: ModelsDevRegistry;
  baseOrigin: string;
  connectedProviders: Iterable<Provider>;
};

const PROXY_API_KEY_ENV = "KLEIS_API_KEY";

let cache: CacheEntry | null = null;
let inFlightFetch: Promise<ModelsDevRegistry> | null = null;

const parseRegistry = (value: unknown): ModelsDevRegistry => {
  if (!isObjectRecord(value)) {
    throw new Error("models.dev payload is not an object");
  }

  return value;
};

const isCacheFresh = (
  cacheEntry: CacheEntry,
  now: number,
  ttlSeconds: number
): boolean => {
  const ttlMs = ttlSeconds * 1000;
  return now - cacheEntry.fetchedAt < ttlMs;
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

export const getModelsDevRegistry = (
  config: RuntimeConfig
): Promise<ModelsDevRegistry> => {
  const now = Date.now();
  if (cache && isCacheFresh(cache, now, config.modelsDevCacheTtlSeconds)) {
    return Promise.resolve(cache.registry);
  }

  if (inFlightFetch) {
    return inFlightFetch;
  }

  inFlightFetch = fetchRegistry(config.modelsDevUrl)
    .then((registry) => {
      cache = {
        fetchedAt: Date.now(),
        registry,
      };
      return registry;
    })
    .finally(() => {
      inFlightFetch = null;
    });

  return inFlightFetch;
};

export const buildProxyModelsRegistry = (
  input: BuildProxyModelsRegistryInput
): ModelsDevRegistry => {
  const connected = new Set(input.connectedProviders);
  const registry: ModelsDevRegistry = {};
  const baseOrigin = normalizeOrigin(input.baseOrigin);

  for (const mapping of proxyProviderMappings) {
    if (!connected.has(mapping.internalProvider)) {
      continue;
    }

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
