import { Hono, type Context } from "hono";

import { db } from "../../db";
import { listConfiguredProviders } from "../../db/repositories/provider-accounts";
import {
  buildProxyModelsRegistry,
  fetchModelsDevRegistry,
} from "../../domain/models/models-dev";
import { modelsRegistryCacheHeaders } from "../utils/models-cache";

const MODELS_ROUTE_PATH = "/api.json";

const resolveBaseOriginWithPath = (requestUrl: URL): string => {
  const basePath = requestUrl.pathname.endsWith(MODELS_ROUTE_PATH)
    ? requestUrl.pathname.slice(0, -MODELS_ROUTE_PATH.length)
    : "";
  return `${requestUrl.origin}${basePath}`;
};

const resolveProxyRegistry = async (context: Context) => {
  const upstreamRegistry = await fetchModelsDevRegistry();
  const configuredProviders = await listConfiguredProviders(db);
  const requestUrl = new URL(context.req.url);
  return buildProxyModelsRegistry({
    upstreamRegistry,
    baseOrigin: resolveBaseOriginWithPath(requestUrl),
    configuredProviders,
  });
};

export const modelsRoutes = new Hono().get(
  MODELS_ROUTE_PATH,
  async (context) => {
    const registry = await resolveProxyRegistry(context);
    return context.json(registry, { headers: modelsRegistryCacheHeaders });
  }
);
