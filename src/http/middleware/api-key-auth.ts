import { createMiddleware } from "hono/factory";

import { db } from "../../db";
import { findActiveApiKeyByValue } from "../../db/repositories/api-keys";
import { parseBearerToken } from "../utils/bearer";
import {
  isModelInScope,
  readModelFromBody,
  resolveProxyRoute,
} from "../proxy-routing";

const readRequestedModel = async (request: Request): Promise<string | null> => {
  const bodyText = await request.clone().text();
  if (!bodyText.trim()) {
    return null;
  }

  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(bodyText) as unknown;
  } catch {
    return null;
  }

  return readModelFromBody(bodyJson);
};

export const requireProxyApiKey = createMiddleware(async (context, next) => {
  const token =
    parseBearerToken(context.req.header("authorization")) ??
    context.req.header("x-api-key")?.trim() ??
    null;
  if (!token) {
    return context.json(
      {
        error: "unauthorized",
        message: "Missing API key",
      },
      401
    );
  }

  const apiKey = await findActiveApiKeyByValue(db, token, Date.now());
  if (!apiKey) {
    return context.json(
      {
        error: "unauthorized",
        message: "Invalid or expired API key",
      },
      401
    );
  }

  const route = resolveProxyRoute(context.req.path);

  if (route && apiKey.providerScopes?.length) {
    if (!apiKey.providerScopes.includes(route.provider)) {
      return context.json(
        {
          error: "forbidden",
          message: `API key is not allowed to access provider: ${route.provider}`,
        },
        403
      );
    }
  }

  if (route && apiKey.modelScopes?.length) {
    const requestedModel = await readRequestedModel(context.req.raw);
    const allowed = isModelInScope({
      model: requestedModel,
      route,
      modelScopes: apiKey.modelScopes,
    });
    if (!allowed) {
      return context.json(
        {
          error: "forbidden",
          message: requestedModel
            ? `API key is not allowed to access model: ${requestedModel}`
            : "API key model scope requires an explicit model field",
        },
        403
      );
    }
  }

  context.set("proxyApiKeyId", apiKey.id);
  await next();
});
