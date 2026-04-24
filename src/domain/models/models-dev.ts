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
  accountProviderScopes: readonly Provider[] | null;
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
const MODELS_DEV_CACHE_TTL_MS = 5 * 60 * 1000;
// https://github.com/anomalyco/opencode/blob/97300085437899af8af6c2bbf6ebc6bdab110174/packages/opencode/src/plugin/codex.ts#L361
const CODEX_ALLOWED_OPENAI_MODEL_IDS = new Set([
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
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

let cachedModelsDevRegistry: ModelsDevRegistry | null = null;
let cachedModelsDevRegistryExpiresAt = 0;
let inFlightModelsDevRegistryRequest: Promise<ModelsDevRegistry> | null = null;

const fetchModelsDevRegistryFromUpstream =
  async (): Promise<ModelsDevRegistry> => {
    const response = await fetch(MODELS_DEV_URL, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `models.dev request failed with status ${response.status}`
      );
    }

    return parseRegistry(await response.json());
  };

export const fetchModelsDevRegistry = async (options?: {
  forceRefresh?: boolean;
}): Promise<ModelsDevRegistry> => {
  if (options?.forceRefresh) {
    cachedModelsDevRegistryExpiresAt = 0;
  }

  const now = Date.now();
  if (cachedModelsDevRegistry && now < cachedModelsDevRegistryExpiresAt) {
    return cachedModelsDevRegistry;
  }

  if (!inFlightModelsDevRegistryRequest) {
    inFlightModelsDevRegistryRequest = fetchModelsDevRegistryFromUpstream()
      .then((registry) => {
        cachedModelsDevRegistry = registry;
        cachedModelsDevRegistryExpiresAt = Date.now() + MODELS_DEV_CACHE_TTL_MS;
        return registry;
      })
      .finally(() => {
        inFlightModelsDevRegistryRequest = null;
      });
  }

  try {
    return await inFlightModelsDevRegistryRequest;
  } catch (error) {
    if (cachedModelsDevRegistry) {
      return cachedModelsDevRegistry;
    }

    throw error;
  }
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

const resolveAllowedMappings = (input: {
  configuredProviders: ReadonlySet<Provider>;
  providerScopes: readonly string[] | null;
  accountProviderScopes: readonly Provider[] | null;
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

    if (
      input.accountProviderScopes &&
      !input.accountProviderScopes.includes(mapping.internalProvider)
    ) {
      return false;
    }

    return true;
  });
};

const mergeKleisProviderModels = (input: {
  upstreamRegistry: ModelsDevRegistry;
  baseOrigin: string;
  mappings: readonly ProxyMapping[];
  modelScopes: readonly string[] | null;
}): JsonObject => {
  const models: JsonObject = {};

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

    Object.assign(
      models,
      cloneProviderModels({
        sourceModels: getObjectProperty(sourceProvider, "models") ?? {},
        apiUrl: `${input.baseOrigin}${mapping.routeBasePath}`,
        npm: mapping.npm,
        // Keep the aggregate registry key equal to model.id. Codex/OpenAI must
        // stay unprefixed because @ai-sdk/openai detects GPT-5 reasoning from
        // ids that start with "gpt-5"; other providers stay prefixed to avoid
        // collisions with same-named OpenAI models in clients like opencode.
        ...(mapping.internalProvider === "codex"
          ? {}
          : { modelPrefix: mapping.canonicalProvider }),
        sourceLabel: mapping.canonicalProvider,
        shouldIncludeModel: (modelId) =>
          isModelSupportedByProxyProvider(mapping.internalProvider, modelId) &&
          isModelInScope({
            model: modelId,
            route,
            modelScopes: input.modelScopes,
          }),
      })
    );
  }

  return models;
};

const toKleisProviderEntry = (input: {
  upstreamRegistry: ModelsDevRegistry;
  baseOrigin: string;
  mappings: readonly ProxyMapping[];
  modelScopes: readonly string[] | null;
}): JsonObject => {
  return {
    id: KLEIS_PROVIDER_ID,
    name: KLEIS_PROVIDER_NAME,
    env: [PROXY_API_KEY_ENV],
    models: mergeKleisProviderModels(input),
  };
};

const appendKleisProviderEntry = (input: {
  registry: ModelsDevRegistry;
  upstreamRegistry: ModelsDevRegistry;
  baseOrigin: string;
  mappings: readonly ProxyMapping[];
  modelScopes: readonly string[] | null;
}): void => {
  const generatedProvider = toKleisProviderEntry({
    upstreamRegistry: input.upstreamRegistry,
    baseOrigin: input.baseOrigin,
    mappings: input.mappings,
    modelScopes: input.modelScopes,
  });
  const existingProvider = getObjectProperty(input.registry, KLEIS_PROVIDER_ID);

  if (!existingProvider) {
    input.registry[KLEIS_PROVIDER_ID] = generatedProvider;
    return;
  }

  const existingModels = getObjectProperty(existingProvider, "models") ?? {};
  const generatedModels = getObjectProperty(generatedProvider, "models") ?? {};
  const existingEnv = Array.isArray(existingProvider.env)
    ? existingProvider.env.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0
      )
    : [];

  if (!existingEnv.includes(PROXY_API_KEY_ENV)) {
    existingEnv.push(PROXY_API_KEY_ENV);
  }

  input.registry[KLEIS_PROVIDER_ID] = {
    ...generatedProvider,
    ...cloneJsonValue(existingProvider),
    env: existingEnv,
    models: {
      ...cloneJsonValue(generatedModels),
      ...cloneJsonValue(existingModels),
    },
  };
};

export const buildProxyModelsRegistry = (
  input: BuildProxyModelsRegistryInput
): ModelsDevRegistry => {
  const providerScopes = normalizeScopeList(input.apiKeyScopes?.providerScopes);
  const modelScopes = normalizeScopeList(input.apiKeyScopes?.modelScopes);
  const accountProviderScopes =
    input.apiKeyScopes?.accountProviderScopes ?? null;
  const mappings = resolveAllowedMappings({
    configuredProviders: new Set(input.configuredProviders),
    providerScopes,
    accountProviderScopes,
  });
  const registry = cloneJsonValue(input.upstreamRegistry);
  const baseOrigin = normalizeOrigin(input.baseOrigin);

  appendKleisProviderEntry({
    registry,
    upstreamRegistry: input.upstreamRegistry,
    baseOrigin,
    mappings,
    modelScopes,
  });

  return registry;
};
