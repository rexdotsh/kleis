import { Hono, type Context } from "hono";

import { getRuntimeConfig } from "../../config/runtime";
import {
  buildProxyModelsRegistry,
  getModelsDevRegistry,
} from "../../domain/models/models-dev";
import type { AppEnv } from "../app-env";

const resolveProxyRegistry = async (context: Context<AppEnv>) => {
  const config = getRuntimeConfig(context.env);
  const upstreamRegistry = await getModelsDevRegistry(config);
  return buildProxyModelsRegistry({
    upstreamRegistry,
    baseOrigin: new URL(context.req.url).origin,
  });
};

export const modelsRoutes = new Hono<AppEnv>().get(
  "/api.json",
  async (context) => {
    const registry = await resolveProxyRegistry(context);
    return context.json(registry);
  }
);
