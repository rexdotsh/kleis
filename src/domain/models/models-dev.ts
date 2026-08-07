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
// Match OpenCode's ChatGPT OAuth model gate.
// https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/plugin/openai/codex.ts#L276-L315
const CODEX_ALLOWED_OPENAI_MODEL_IDS = new Set([
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
]);
const CODEX_DISALLOWED_OPENAI_MODEL_IDS = new Set(["gpt-5.5-pro", "gpt-5.6"]);
const CODEX_DYNAMIC_GPT_VERSION_THRESHOLD = 5.4;

const CODEX_MODEL_LIMIT_OVERRIDES: Record<string, JsonObject> = {
  // Match OpenCode's Codex OAuth metadata so clients compact at the same point:
  // https://github.com/anomalyco/opencode/blob/4a57013cf8cb163f58638273fd9da8538cd33cb7/packages/opencode/src/plugin/openai/codex.ts#L293-L312
  "gpt-5.5": {
    context: 400_000,
    input: 272_000,
    output: 128_000,
  },
};
// The ChatGPT backend accepts GPT-5.6 variants with a smaller context window
// than the public API. Advertising the public limit starves long turns of
// output tokens before OpenCode knows it needs to compact.
const CODEX_GPT_56_LIMIT_OVERRIDE: JsonObject = {
  context: 500_000,
  input: 372_000,
  output: 128_000,
};
const CODEX_SUBSCRIPTION_COST: JsonObject = {
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
};

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
  if (CODEX_DISALLOWED_OPENAI_MODEL_IDS.has(normalizedModelId)) {
    return false;
  }

  const gptVersion = normalizedModelId.match(/^gpt-(\d+\.\d+)/u)?.[1];
  return (
    CODEX_ALLOWED_OPENAI_MODEL_IDS.has(normalizedModelId) ||
    (gptVersion !== undefined &&
      Number.parseFloat(gptVersion) > CODEX_DYNAMIC_GPT_VERSION_THRESHOLD)
  );
};

const cloneProviderModels = (input: {
  sourceModels: Record<string, unknown>;
  apiUrl: string;
  npm: string;
  modelPrefix?: string;
  sourceLabel?: string;
  shouldIncludeModel?: (modelId: string) => boolean;
  transformModel?: (modelId: string, model: JsonObject) => void;
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
    input.transformModel?.(modelId, model);

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
        transformModel: (modelId, model) => {
          if (mapping.internalProvider !== "codex") {
            return;
          }

          const limitOverride = modelId.includes("gpt-5.6")
            ? CODEX_GPT_56_LIMIT_OVERRIDE
            : CODEX_MODEL_LIMIT_OVERRIDES[modelId];
          if (limitOverride) {
            model.limit = limitOverride;
          }
          model.cost = CODEX_SUBSCRIPTION_COST;
        },
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
