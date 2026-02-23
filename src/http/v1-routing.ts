import type { Provider } from "../db/schema";
import { isObjectRecord } from "../utils/object";

export type V1ProxyEndpoint = "chat_completions" | "responses" | "messages";

type ParsedModelRoute = {
  rawModel: string | null;
  provider: Provider | null;
  upstreamModel: string | null;
};

type EndpointConfig = {
  pathSuffix: string;
  defaultProvider: Provider;
  allowedProviders: readonly Provider[];
};

const endpointConfigs: Record<V1ProxyEndpoint, EndpointConfig> = {
  chat_completions: {
    pathSuffix: "/chat/completions",
    defaultProvider: "copilot",
    allowedProviders: ["copilot", "codex"],
  },
  responses: {
    pathSuffix: "/responses",
    defaultProvider: "codex",
    allowedProviders: ["copilot", "codex"],
  },
  messages: {
    pathSuffix: "/messages",
    defaultProvider: "claude",
    allowedProviders: ["claude"],
  },
};

const endpointEntries = Object.entries(endpointConfigs) as [
  V1ProxyEndpoint,
  EndpointConfig,
][];

const toProvider = (value: string | null | undefined): Provider | null => {
  if (value === "copilot" || value === "codex" || value === "claude") {
    return value;
  }

  return null;
};

export const parseProviderPrefixedModel = (
  value: string | null | undefined
): ParsedModelRoute => {
  const model = value?.trim() ?? "";
  if (!model) {
    return {
      rawModel: null,
      provider: null,
      upstreamModel: null,
    };
  }

  const [providerSegment, ...rest] = model.split("/");
  const provider = toProvider(providerSegment);
  if (!provider || rest.length === 0) {
    return {
      rawModel: model,
      provider: null,
      upstreamModel: model,
    };
  }

  const upstreamModel = rest.join("/").trim();
  if (!upstreamModel) {
    return {
      rawModel: model,
      provider: null,
      upstreamModel: model,
    };
  }

  return {
    rawModel: model,
    provider,
    upstreamModel,
  };
};

export const readModelFromBody = (body: unknown): string | null => {
  if (!isObjectRecord(body) || typeof body.model !== "string") {
    return null;
  }

  const model = body.model.trim();
  return model || null;
};

export const endpointFromPath = (path: string): V1ProxyEndpoint | null => {
  for (const [endpoint, config] of endpointEntries) {
    if (path.endsWith(config.pathSuffix)) {
      return endpoint;
    }
  }

  return null;
};

export const endpointPathSuffix = (endpoint: V1ProxyEndpoint): string =>
  endpointConfigs[endpoint].pathSuffix;

export const resolveTargetProvider = (
  endpoint: V1ProxyEndpoint,
  requestedProvider: Provider | null
): Provider => requestedProvider ?? endpointConfigs[endpoint].defaultProvider;

export const isProviderSupportedForEndpoint = (
  endpoint: V1ProxyEndpoint,
  provider: Provider
): boolean => endpointConfigs[endpoint].allowedProviders.includes(provider);
