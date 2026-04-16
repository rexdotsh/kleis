import { Hono, type Context } from "hono";

import { db } from "../../db";
import { findActiveApiKeyByModelsDiscoveryToken } from "../../db/repositories/api-keys";
import {
  findProviderAccountsByIds,
  listConfiguredProviders,
} from "../../db/repositories/provider-accounts";
import type { Provider } from "../../db/schema";
import {
  buildProxyModelsRegistry,
  fetchModelsDevRegistry,
} from "../../domain/models/models-dev";
import { resolveExternalRequestUrl } from "../utils/request-origin";

const MODELS_ROUTE_PATH = "/api.json";
const SCOPED_MODELS_ROUTE_PATH = "/api/:modelsToken/api.json";
const SCOPED_MODELS_NOT_FOUND = {
  error: "not_found",
  message: "Scoped models URL was not found",
} as const;

type ApiKeyScopes = {
  providerScopes: readonly string[] | null;
  modelScopes: readonly string[] | null;
  accountProviderScopes: readonly Provider[] | null;
};

const shouldForceRefreshModelsRegistry = (requestUrl: URL): boolean => {
  const refresh = requestUrl.searchParams.get("refresh")?.trim();
  return refresh === "1" || refresh?.toLowerCase() === "true";
};

const resolveBaseOriginWithPath = (requestUrl: URL): string => {
  const scopedSuffixMatch = requestUrl.pathname.match(
    /\/api\/[^/]+\/api\.json$/u
  );
  if (scopedSuffixMatch) {
    return `${requestUrl.origin}${requestUrl.pathname.slice(0, -scopedSuffixMatch[0].length)}`;
  }

  const basePath = requestUrl.pathname.endsWith(MODELS_ROUTE_PATH)
    ? requestUrl.pathname.slice(0, -MODELS_ROUTE_PATH.length)
    : "";
  return `${requestUrl.origin}${basePath}`;
};

const parseModelsTokenParam = (value: string | undefined): string | null => {
  const token = value?.trim();
  if (!token || token.length > 120 || !/^[a-zA-Z0-9_]+$/u.test(token)) {
    return null;
  }

  return token;
};

const buildRegistryForRequest = async (
  context: Context,
  apiKeyScopes?: ApiKeyScopes
) => {
  const requestUrl = resolveExternalRequestUrl(context.req.raw);
  const forceRefresh = shouldForceRefreshModelsRegistry(requestUrl);
  const [upstreamRegistry, configuredProviders] = await Promise.all([
    fetchModelsDevRegistry({ forceRefresh }),
    listConfiguredProviders(db),
  ]);

  return buildProxyModelsRegistry({
    upstreamRegistry,
    baseOrigin: resolveBaseOriginWithPath(requestUrl),
    configuredProviders,
    ...(apiKeyScopes ? { apiKeyScopes } : {}),
  });
};

const findApiKeyScopesByToken = async (
  modelsToken: string
): Promise<ApiKeyScopes | null> => {
  const apiKey = await findActiveApiKeyByModelsDiscoveryToken(
    db,
    modelsToken,
    Date.now()
  );
  if (!apiKey) {
    return null;
  }

  const accountProviderScopes = apiKey.accountScopes
    ? Array.from(
        new Set(
          (await findProviderAccountsByIds(db, apiKey.accountScopes)).map(
            (account) => account.provider
          )
        )
      )
    : null;

  return {
    providerScopes: apiKey.providerScopes,
    modelScopes: apiKey.modelScopes,
    accountProviderScopes,
  };
};

export const modelsRoutes = new Hono()
  .get(MODELS_ROUTE_PATH, async (context) => {
    const registry = await buildRegistryForRequest(context);
    return context.json(registry, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  })
  .get(SCOPED_MODELS_ROUTE_PATH, async (context) => {
    const modelsToken = parseModelsTokenParam(context.req.param("modelsToken"));
    if (!modelsToken) {
      return context.json(SCOPED_MODELS_NOT_FOUND, 404);
    }

    const apiKeyScopes = await findApiKeyScopesByToken(modelsToken);
    if (!apiKeyScopes) {
      return context.json(SCOPED_MODELS_NOT_FOUND, 404);
    }

    const registry = await buildRegistryForRequest(context, apiKeyScopes);
    return context.json(registry, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  });
