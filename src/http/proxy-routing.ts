import type { Provider } from "../db/schema";
import {
  buildProxyRoutePath,
  requireProxyProviderByCanonical,
} from "../providers/proxy-provider";
import {
  proxyEndpointRoutes,
  type CanonicalProvider,
  type ProxyEndpoint,
} from "../providers/proxy-endpoints";
import { isObjectRecord } from "../utils/object";

export type ProxyRoute = {
  path: string;
  publicProvider: CanonicalProvider;
  provider: Provider;
  endpoint: ProxyEndpoint;
};

type ParsedModelRoute = {
  rawModel: string | null;
  upstreamModel: string | null;
};

export const proxyRouteTable: readonly ProxyRoute[] = proxyEndpointRoutes.map(
  (route) => ({
    path: buildProxyRoutePath(route.publicProvider, route.publicSuffix),
    publicProvider: route.publicProvider,
    provider: requireProxyProviderByCanonical(route.publicProvider)
      .internalProvider,
    endpoint: route.endpoint,
  })
);

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
  const rawModel = parsedModel.rawModel;
  const rawParts = rawModel?.split("/") ?? [];
  const rawPrefix = rawParts[0] ?? "";
  const rawHasPrefix = rawParts.length > 1;
  const rawMatchesRoutePrefix =
    rawPrefix === route.publicProvider || rawPrefix === route.provider;
  const allowRawCandidates = !rawHasPrefix || rawMatchesRoutePrefix;

  if (rawModel && allowRawCandidates) {
    candidates.add(rawModel);
  }

  if (parsedModel.upstreamModel && allowRawCandidates) {
    candidates.add(parsedModel.upstreamModel);
    candidates.add(`${route.publicProvider}/${parsedModel.upstreamModel}`);
    candidates.add(`${route.provider}/${parsedModel.upstreamModel}`);
  }

  return Array.from(candidates);
};
