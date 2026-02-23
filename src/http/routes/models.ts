import { Hono, type Context } from "hono";

import {
  buildProxyModelsRegistry,
  getModelsDevRegistry,
} from "../../domain/models/models-dev";

const resolveProxyRegistry = async (context: Context) => {
  const upstreamRegistry = await getModelsDevRegistry();
  return buildProxyModelsRegistry({
    upstreamRegistry,
    baseOrigin: new URL(context.req.url).origin,
  });
};

export const modelsRoutes = new Hono().get("/api.json", async (context) => {
  const registry = await resolveProxyRegistry(context);
  return context.json(registry);
});
