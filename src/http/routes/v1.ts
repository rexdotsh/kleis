import { Hono } from "hono";

import { getRuntimeConfig } from "../../config/runtime";
import {
  getModelsDevRegistry,
  toOpenAiModelList,
} from "../../domain/models/models-dev";
import type { AppEnv } from "../app-env";

const notImplementedProxyResponse = (endpoint: string) => ({
  error: {
    message: `${endpoint} proxy is not implemented yet`,
    type: "not_implemented",
  },
});

export const v1Routes = new Hono<AppEnv>()
  .get("/models", async (context) => {
    const config = getRuntimeConfig(context.env);
    const registry = await getModelsDevRegistry(config);
    return context.json(toOpenAiModelList(registry));
  })
  .post("/chat/completions", (context) =>
    context.json(notImplementedProxyResponse("chat_completions"), 501)
  )
  .post("/responses", (context) =>
    context.json(notImplementedProxyResponse("responses"), 501)
  )
  .post("/messages", (context) =>
    context.json(notImplementedProxyResponse("messages"), 501)
  );
