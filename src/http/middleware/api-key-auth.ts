import { createMiddleware } from "hono/factory";

import { db } from "../../db";
import { findActiveApiKeyByValue } from "../../db/repositories/api-keys";
import { parseBearerToken } from "../utils/bearer";
import {
  isModelInScope,
  readProxyRequestBody,
  resolveProxyRoute,
} from "../proxy-routing";

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

  const isProxyRequest = context.req.method === "POST" && route !== null;

  let requestedModel: string | null = null;
  if (isProxyRequest) {
    const requestBody = await readProxyRequestBody(context.req.raw);
    requestedModel = requestBody.model;
    if (!requestedModel) {
      return context.json(
        {
          error: "bad_request",
          message: "Proxy requests must include a non-empty model field",
        },
        400
      );
    }
    context.set("proxyRequestBody", requestBody);
  }

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

  if (isProxyRequest && apiKey.modelScopes?.length) {
    const allowed = isModelInScope({
      model: requestedModel,
      route,
      modelScopes: apiKey.modelScopes,
    });
    if (!allowed) {
      return context.json(
        {
          error: "forbidden",
          message: `API key is not allowed to access model: ${requestedModel}`,
        },
        403
      );
    }
  }

  context.set("proxyApiKeyId", apiKey.id);
  context.set("proxyApiKeyAccountScopeIds", apiKey.accountScopes);
  await next();
});
