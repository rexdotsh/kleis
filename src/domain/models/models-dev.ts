import type { Provider } from "../../db/schema";
import { isModelInScope } from "../../http/proxy-routing";
import { proxyProviderMappings } from "../../providers/proxy-provider";
import { readResponseJson } from "../../utils/response-json";
import { normalizeStringList } from "../../utils/string-list";
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
const MODELS_DEV_CACHE_TTL_MS = 5 * 60 * 1000;
// Match OpenCode's ChatGPT OAuth model gate.
// https://github.com/anomalyco/opencode/blob/68b28bdb98bbe9ca5046e5c8485417c9b9460537/packages/core/src/plugin/provider/openai.ts#L22-L25
const CODEX_ALLOWED_OPENAI_MODEL_IDS = new Set([
  "gpt-5.3-codex-spark",
  "gpt-5.5",
]);
const CODEX_DISALLOWED_OPENAI_MODEL_IDS = new Set(["gpt-5.5-pro", "gpt-5.6"]);
const CODEX_DYNAMIC_GPT_VERSION_THRESHOLD = { major: 5, minor: 4 };

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
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `models.dev request failed with status ${response.status}`
      );
    }

    return parseRegistry(
      await readResponseJson(response, "models.dev response")
    );
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

  if (CODEX_ALLOWED_OPENAI_MODEL_IDS.has(normalizedModelId)) {
    return true;
  }

  const gptVersion = normalizedModelId.match(/^gpt-(\d+)(?:\.(\d+))?/u);
  if (!gptVersion) {
    return false;
  }

  const major = Number(gptVersion[1]);
  const minor = Number(gptVersion[2] ?? 0);
  return (
    major > CODEX_DYNAMIC_GPT_VERSION_THRESHOLD.major ||
    (major === CODEX_DYNAMIC_GPT_VERSION_THRESHOLD.major &&
      minor > CODEX_DYNAMIC_GPT_VERSION_THRESHOLD.minor)
  );
};

// OpenCode turns models.dev experimental modes into separate `<model>-<mode>`
// models and disables pro reasoning mode for ChatGPT OAuth accounts.
// https://github.com/anomalyco/opencode/blob/4617210822/packages/core/src/plugin/provider/openai.ts#L279-L282
const removeProReasoningModes = (model: JsonObject): void => {
  const modes = getObjectProperty(
    getObjectProperty(model, "experimental"),
    "modes"
  );
  if (!modes) {
    return;
  }

  for (const [mode, options] of Object.entries(modes)) {
    const body = getObjectProperty(
      getObjectProperty(options, "provider"),
      "body"
    );
    if (getObjectProperty(body, "reasoning")?.mode === "pro") {
      delete modes[mode];
    }
  }
};

// ChatGPT's Codex models endpoint (context_window) and OpenCode's ChatGPT
// OAuth transform: GPT-6.1 Sol has a 500k input window, every other model 272k.
const DEFAULT_CODEX_LIMITS = { context: 400_000, input: 272_000 };
const CODEX_SUBSCRIPTION_LIMITS: Record<string, typeof DEFAULT_CODEX_LIMITS> = {
  "gpt-6.1-sol": { context: 628_000, input: 500_000 },
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

    const route = {
      publicProvider: mapping.canonicalProvider,
      provider: mapping.internalProvider,
    };
    for (const [modelId, modelValue] of Object.entries(
      getObjectProperty(sourceProvider, "models") ?? {}
    )) {
      if (
        !isModelSupportedByProxyProvider(mapping.internalProvider, modelId) ||
        !isModelInScope({
          model: modelId,
          route,
          modelScopes: input.modelScopes,
        })
      ) {
        continue;
      }

      // The SDK detects GPT reasoning from unprefixed IDs; other providers
      // stay prefixed to avoid collisions with same-named OpenAI models.
      const proxyModelId =
        mapping.internalProvider === "codex"
          ? modelId
          : `${mapping.canonicalProvider}/${modelId}`;
      if (!isObjectRecord(modelValue)) {
        models[proxyModelId] = modelValue;
        continue;
      }

      const model = cloneJsonValue(modelValue);
      if (mapping.internalProvider === "codex") {
        // Preserve models.dev's output limit while applying subscription limits.
        model.limit = {
          ...getObjectProperty(model, "limit"),
          ...(CODEX_SUBSCRIPTION_LIMITS[modelId] ?? DEFAULT_CODEX_LIMITS),
        };
        removeProReasoningModes(model);
      }
      model.id = proxyModelId;
      model.name =
        typeof model.name === "string" && model.name.trim()
          ? model.name
          : modelId;
      model.provider = {
        ...getObjectProperty(model, "provider"),
        api: `${input.baseOrigin}${mapping.routeBasePath}`,
        npm: mapping.npm,
      };
      models[proxyModelId] = model;
    }
  }

  return models;
};

export const buildProxyModelsRegistry = (
  input: BuildProxyModelsRegistryInput
): ModelsDevRegistry => {
  const providerScopes = normalizeStringList(
    input.apiKeyScopes?.providerScopes
  );
  const modelScopes = normalizeStringList(input.apiKeyScopes?.modelScopes);
  const mappings = proxyProviderMappings.filter(
    (mapping) =>
      input.configuredProviders.includes(mapping.internalProvider) &&
      (!providerScopes || providerScopes.includes(mapping.internalProvider))
  );
  const registry = cloneJsonValue(input.upstreamRegistry);
  const generatedModels = mergeKleisProviderModels({
    upstreamRegistry: input.upstreamRegistry,
    baseOrigin: normalizeOrigin(input.baseOrigin),
    mappings,
    modelScopes,
  });
  const generatedProvider = {
    id: KLEIS_PROVIDER_ID,
    name: KLEIS_PROVIDER_NAME,
    env: [PROXY_API_KEY_ENV],
    models: generatedModels,
  };
  const existingProvider = getObjectProperty(registry, KLEIS_PROVIDER_ID);

  if (!existingProvider) {
    registry[KLEIS_PROVIDER_ID] = generatedProvider;
    return registry;
  }

  const existingModels = getObjectProperty(existingProvider, "models") ?? {};
  const existingEnv = Array.isArray(existingProvider.env)
    ? existingProvider.env.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0
      )
    : [];

  if (!existingEnv.includes(PROXY_API_KEY_ENV)) {
    existingEnv.push(PROXY_API_KEY_ENV);
  }

  registry[KLEIS_PROVIDER_ID] = {
    ...generatedProvider,
    ...cloneJsonValue(existingProvider),
    env: existingEnv,
    models: {
      ...cloneJsonValue(generatedModels),
      ...cloneJsonValue(existingModels),
    },
  };
  return registry;
};
