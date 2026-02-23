import { createMiddleware } from "hono/factory";

import { dbFromContext } from "../../db/client";
import { findActiveApiKeyByValue } from "../../db/repositories/api-keys";
import type { AppEnv } from "../app-env";
import { parseBearerToken } from "../utils/bearer";
import {
  endpointFromPath,
  resolveTargetProvider,
  toProvider,
  V1_PROVIDER_HEADER,
} from "../v1-routing";

type JsonObject = Record<string, unknown>;

const isObjectRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readRequestedModel = async (request: Request): Promise<string | null> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return null;
  }

  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null;
  }

  if (!isObjectRecord(body) || typeof body.model !== "string") {
    return null;
  }

  const model = body.model.trim();
  return model || null;
};

export const requireProxyApiKey = createMiddleware<AppEnv>(
  async (context, next) => {
    const token = parseBearerToken(context.req.header("authorization"));
    if (!token) {
      return context.json(
        {
          error: "unauthorized",
          message: "Missing bearer API key",
        },
        401
      );
    }

    const database = dbFromContext(context);
    const apiKey = await findActiveApiKeyByValue(database, token, Date.now());
    if (!apiKey) {
      return context.json(
        {
          error: "unauthorized",
          message: "Invalid or expired API key",
        },
        401
      );
    }

    const endpoint = endpointFromPath(context.req.path);
    const providerOverride = toProvider(context.req.header(V1_PROVIDER_HEADER));

    if (apiKey.providerScopes?.length) {
      const targetProvider = endpoint
        ? resolveTargetProvider(endpoint, providerOverride)
        : providerOverride;
      if (targetProvider && !apiKey.providerScopes.includes(targetProvider)) {
        return context.json(
          {
            error: "forbidden",
            message: `API key is not allowed to access provider: ${targetProvider}`,
          },
          403
        );
      }
    }

    if (endpoint && apiKey.modelScopes?.length) {
      const model = await readRequestedModel(context.req.raw);
      if (!model || !apiKey.modelScopes.includes(model)) {
        return context.json(
          {
            error: "forbidden",
            message: model
              ? `API key is not allowed to access model: ${model}`
              : "API key model scope requires an explicit model field",
          },
          403
        );
      }
    }

    await next();
  }
);
