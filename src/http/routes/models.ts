import { Hono } from "hono";

import { getRuntimeConfig } from "../../config/runtime";
import { getModelsDevRegistry } from "../../domain/models/models-dev";
import type { AppEnv } from "../app-env";

export const modelsRoutes = new Hono<AppEnv>().get(
  "/models/api.json",
  async (context) => {
    const config = getRuntimeConfig(context.env);
    const registry = await getModelsDevRegistry(config);
    return context.json(registry);
  }
);
