import type { Provider } from "../../db/schema";
import { isModelInScope, type ModelScopeRoute } from "../../http/proxy-routing";
import { proxyProviderMappings } from "../../providers/proxy-provider";
import {
  getObjectProperty,
  isObjectRecord,
  type JsonObject,
} from "../../utils/object";

type ModelsDevRegistry = JsonObject;

type ApiKeyScopes = {
  providerScopes: readonly string[] | null;
  modelScopes: readonly string[] | null;
};

type BuildProxyModelsRegistryInput = {
  upstreamRegistry: ModelsDevRegistry;
  baseOrigin: string;
  configuredProviders: readonly Provider[];
  apiKeyScopes?: ApiKeyScopes;
};

type ProxyMapping = (typeof proxyProviderMappings)[number];

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

const modelScopeRouteByCanonicalProvider = new Map<string, ModelScopeRoute>(
  proxyProviderMappings.map((mapping) => [
    mapping.canonicalProvider,
    {
      publicProvider: mapping.canonicalProvider,
      provider: mapping.internalProvider,
    },
  ])
);

const parseRegistry = (value: unknown): ModelsDevRegistry => {
  if (!isObjectRecord(value)) {
    throw new Error("models.dev payload is not an object");
  }

  return value;
};

export const fetchModelsDevRegistry = async (): Promise<ModelsDevRegistry> => {
  const response = await fetch(MODELS_DEV_URL, {
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

const normalizeScopeList = (
  scopes: readonly string[] | null | undefined
): string[] | null => {
  if (!scopes?.length) {
    return null;
  }

  const normalized = new Set<string>();
  for (const scope of scopes) {
    const value = scope.trim();
    if (value) {
      normalized.add(value);
    }
  }

  return normalized.size ? Array.from(normalized) : null;
};

const cloneJsonValue = <T>(value: T): T => {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
};

const isModelSupportedByProxyProvider = (
  internalProvider: ProxyMapping["internalProvider"],
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
    const providerOverrides = getObjectProperty(model, "provider") ?? {};

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

const filterProviderModels = (input: {
  sourceModels: Record<string, unknown>;
  shouldIncludeModel: (modelId: string) => boolean;
}): JsonObject => {
  const models: JsonObject = {};
  for (const [modelId, modelValue] of Object.entries(input.sourceModels)) {
    if (!input.shouldIncludeModel(modelId)) {
      continue;
    }

    models[modelId] = cloneJsonValue(modelValue);
  }

  return models;
};

const resolveAllowedMappings = (input: {
  configuredProviders: ReadonlySet<Provider>;
  providerScopes: readonly string[] | null;
}): ProxyMapping[] => {
  return proxyProviderMappings.filter((mapping) => {
    if (!input.configuredProviders.has(mapping.internalProvider)) {
      return false;
    }

    if (
      input.providerScopes &&
      !input.providerScopes.includes(mapping.internalProvider)
    ) {
      return false;
    }

    return true;
  });
};

const buildScopedUpstreamRegistry = (input: {
  upstreamRegistry: ModelsDevRegistry;
  mappings: readonly ProxyMapping[];
  modelScopes: readonly string[] | null;
}): ModelsDevRegistry => {
  const registry: ModelsDevRegistry = {};

  for (const mapping of input.mappings) {
    const sourceProvider = getObjectProperty(
      input.upstreamRegistry,
      mapping.canonicalProvider
    );
    if (!sourceProvider) {
      continue;
    }

    const route = modelScopeRouteByCanonicalProvider.get(
      mapping.canonicalProvider
    );
    if (!route) {
      continue;
    }

    const providerModels = filterProviderModels({
      sourceModels: getObjectProperty(sourceProvider, "models") ?? {},
      shouldIncludeModel: (modelId) =>
        isModelSupportedByProxyProvider(mapping.internalProvider, modelId) &&
        isModelInScope({
          model: modelId,
          route,
          modelScopes: input.modelScopes,
        }),
    });
    if (!Object.keys(providerModels).length) {
      continue;
    }

    const provider = cloneJsonValue(sourceProvider);
    provider.models = providerModels;
    registry[mapping.canonicalProvider] = provider;
  }

  return registry;
};

const mergeKleisProviderModels = (input: {
  registry: ModelsDevRegistry;
  baseOrigin: string;
  mappings: readonly ProxyMapping[];
}): JsonObject => {
  const models: JsonObject = {};

  for (const mapping of input.mappings) {
    const sourceProvider = getObjectProperty(
      input.registry,
      mapping.canonicalProvider
    );
    if (!sourceProvider) {
      continue;
    }

    Object.assign(
      models,
      cloneProviderModels({
        sourceModels: getObjectProperty(sourceProvider, "models") ?? {},
        apiUrl: `${input.baseOrigin}${mapping.routeBasePath}`,
        npm: mapping.npm,
        modelPrefix: mapping.canonicalProvider,
        sourceLabel: mapping.canonicalProvider,
        shouldIncludeModel: (modelId) =>
          isModelSupportedByProxyProvider(mapping.internalProvider, modelId),
      })
    );
  }

  return models;
};

const toKleisProviderEntry = (input: {
  registry: ModelsDevRegistry;
  baseOrigin: string;
  mappings: readonly ProxyMapping[];
}): JsonObject => {
  return {
    id: KLEIS_PROVIDER_ID,
    name: KLEIS_PROVIDER_NAME,
    env: [PROXY_API_KEY_ENV],
    models: mergeKleisProviderModels(input),
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
  existingProvider: JsonObject,
  generatedProvider: JsonObject
): JsonObject => {
  const provider = cloneJsonValue(existingProvider);
  const existingModels = getObjectProperty(provider, "models") ?? {};
  const generatedModels = getObjectProperty(generatedProvider, "models") ?? {};

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
  mappings: readonly ProxyMapping[];
}): void => {
  const generatedProvider = toKleisProviderEntry({
    registry: input.registry,
    baseOrigin: input.baseOrigin,
    mappings: input.mappings,
  });
  const existingProvider = getObjectProperty(input.registry, KLEIS_PROVIDER_ID);

  if (!existingProvider) {
    input.registry[KLEIS_PROVIDER_ID] = generatedProvider;
    return;
  }

  input.registry[KLEIS_PROVIDER_ID] = mergeKleisProviderEntries(
    existingProvider,
    generatedProvider
  );
};

export const buildProxyModelsRegistry = (
  input: BuildProxyModelsRegistryInput
): ModelsDevRegistry => {
  const providerScopes = normalizeScopeList(input.apiKeyScopes?.providerScopes);
  const modelScopes = normalizeScopeList(input.apiKeyScopes?.modelScopes);
  const mappings = resolveAllowedMappings({
    configuredProviders: new Set(input.configuredProviders),
    providerScopes,
  });
  const baseOrigin = normalizeOrigin(input.baseOrigin);

  const registry: ModelsDevRegistry = input.apiKeyScopes
    ? buildScopedUpstreamRegistry({
        upstreamRegistry: input.upstreamRegistry,
        mappings,
        modelScopes,
      })
    : cloneJsonValue(input.upstreamRegistry);

  appendKleisProviderEntry({
    registry,
    baseOrigin,
    mappings,
  });

  return registry;
};
