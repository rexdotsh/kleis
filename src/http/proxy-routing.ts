import type { Provider } from "../db/schema";
import {
  buildProxyRoutePath,
  requireProxyProviderByCanonical,
} from "../providers/proxy-provider";
import { isObjectRecord } from "../utils/object";

export type ProxyEndpoint = "chat_completions" | "responses" | "messages";

export type ProxyRoute = {
  path: string;
  publicProvider: "openai" | "anthropic" | "github-copilot";
  provider: Provider;
  endpoint: ProxyEndpoint;
  upstreamPath: "/v1/chat/completions" | "/v1/responses" | "/v1/messages";
};

type ParsedModelRoute = {
  rawModel: string | null;
  upstreamModel: string | null;
};

const toProxyRoute = (input: {
  provider: "openai" | "anthropic" | "github-copilot";
  suffix: "/responses" | "/messages" | "/chat/completions";
  endpoint: ProxyEndpoint;
}): ProxyRoute => ({
  path: buildProxyRoutePath(input.provider, input.suffix),
  publicProvider: input.provider,
  provider: requireProxyProviderByCanonical(input.provider).internalProvider,
  endpoint: input.endpoint,
  upstreamPath: `/v1${input.suffix}`,
});

export const proxyRouteTable: readonly ProxyRoute[] = [
  toProxyRoute({
    provider: "openai",
    suffix: "/responses",
    endpoint: "responses",
  }),
  toProxyRoute({
    provider: "anthropic",
    suffix: "/messages",
    endpoint: "messages",
  }),
  toProxyRoute({
    provider: "github-copilot",
    suffix: "/chat/completions",
    endpoint: "chat_completions",
  }),
  toProxyRoute({
    provider: "github-copilot",
    suffix: "/responses",
    endpoint: "responses",
  }),
] as const;

const proxyRouteByPath = new Map<string, ProxyRoute>(
  proxyRouteTable.map((route) => [route.path, route])
);

export const resolveProxyRoute = (path: string): ProxyRoute | null =>
  proxyRouteByPath.get(path) ?? null;

export const readModelFromBody = (body: unknown): string | null => {
  if (!isObjectRecord(body) || typeof body.model !== "string") {
    return null;
  }

  const model = body.model.trim();
  return model || null;
};

export const parseModelForProxyRoute = (
  model: string | null | undefined,
  route: ProxyRoute
): ParsedModelRoute => {
  const rawModel = model?.trim() ?? "";
  if (!rawModel) {
    return {
      rawModel: null,
      upstreamModel: null,
    };
  }

  const [prefix, ...rest] = rawModel.split("/");
  if (
    rest.length > 0 &&
    (prefix === route.publicProvider || prefix === route.provider)
  ) {
    const upstreamModel = rest.join("/").trim();
    if (!upstreamModel) {
      return {
        rawModel,
        upstreamModel: rawModel,
      };
    }

    return {
      rawModel,
      upstreamModel,
    };
  }

  return {
    rawModel,
    upstreamModel: rawModel,
  };
};

export const modelScopeCandidates = (
  parsedModel: ParsedModelRoute,
  route: ProxyRoute
): string[] => {
  const candidates = new Set<string>();

  if (parsedModel.rawModel) {
    candidates.add(parsedModel.rawModel);
  }

  if (parsedModel.upstreamModel) {
    candidates.add(parsedModel.upstreamModel);
    candidates.add(`${route.publicProvider}/${parsedModel.upstreamModel}`);
    candidates.add(`${route.provider}/${parsedModel.upstreamModel}`);
  }

  return Array.from(candidates);
};
