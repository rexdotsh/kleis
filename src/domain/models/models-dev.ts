import type { RuntimeConfig } from "../../config/runtime";
import { isObjectRecord, type JsonObject } from "../../utils/object";

type ModelsDevRegistry = JsonObject;

type CacheEntry = {
  fetchedAt: number;
  registry: ModelsDevRegistry;
};

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

type OpenAiModelList = {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    created: number;
    owned_by: string;
  }>;
};

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

const getModelId = (modelKey: string, modelValue: unknown): string => {
  if (
    isObjectRecord(modelValue) &&
    typeof modelValue.id === "string" &&
    modelValue.id.trim()
  ) {
    return modelValue.id;
  }

  return modelKey;
};

export const toOpenAiModelList = (
  registry: ModelsDevRegistry
): OpenAiModelList => {
  const unique = new Map<string, { id: string; ownedBy: string }>();
  for (const [providerId, providerValue] of Object.entries(registry)) {
    const models = getNestedObject(providerValue, "models");
    if (!models) {
      continue;
    }

    for (const [modelKey, modelValue] of Object.entries(models)) {
      const modelId = getModelId(modelKey, modelValue);
      if (!unique.has(modelId)) {
        unique.set(modelId, {
          id: modelId,
          ownedBy: providerId,
        });
      }
    }
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const data = Array.from(unique.values())
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entry) => ({
      id: entry.id,
      object: "model" as const,
      created: nowSeconds,
      owned_by: entry.ownedBy,
    }));

  return {
    object: "list",
    data,
  };
};
