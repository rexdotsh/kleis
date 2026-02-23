import type { Provider } from "../db/schema";
import type { CanonicalProvider, ProxyRouteSuffix } from "./proxy-endpoints";

type ProxyProviderMapping = {
  internalProvider: Provider;
  canonicalProvider: CanonicalProvider;
  routeBasePath: "/openai/v1" | "/anthropic/v1" | "/copilot/v1";
  npm: string;
  defaultName: string;
};

export const proxyProviderMappings: readonly ProxyProviderMapping[] = [
  {
    internalProvider: "codex",
    canonicalProvider: "openai",
    routeBasePath: "/openai/v1",
    npm: "@ai-sdk/openai",
    defaultName: "OpenAI",
  },
  {
    internalProvider: "claude",
    canonicalProvider: "anthropic",
    routeBasePath: "/anthropic/v1",
    npm: "@ai-sdk/anthropic",
    defaultName: "Anthropic",
  },
  {
    internalProvider: "copilot",
    canonicalProvider: "github-copilot",
    routeBasePath: "/copilot/v1",
    npm: "@ai-sdk/github-copilot",
    defaultName: "GitHub Copilot",
  },
] as const;

export const requireProxyProviderByCanonical = (
  canonicalProvider: CanonicalProvider
): ProxyProviderMapping => {
  for (const mapping of proxyProviderMappings) {
    if (mapping.canonicalProvider === canonicalProvider) {
      return mapping;
    }
  }

  throw new Error(`Unknown canonical provider: ${canonicalProvider}`);
};

export const buildProxyRoutePath = (
  canonicalProvider: CanonicalProvider,
  suffix: ProxyRouteSuffix
): string => {
  const mapping = requireProxyProviderByCanonical(canonicalProvider);
  return `${mapping.routeBasePath}${suffix}`;
};
