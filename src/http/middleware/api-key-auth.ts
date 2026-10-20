import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import { db } from "../../db";
import {
  findActiveApiKeyByValue,
  type ApiKeyRecord,
} from "../../db/repositories/api-keys";
import { hasLiveGrant } from "../../db/repositories/grants";
import { splitOwnerSuffix } from "../../domain/owners";
import { parseBearerToken } from "../utils/bearer";
import {
  isModelInScope,
  readProxyRequestBody,
  resolveProxyRoute,
} from "../proxy-routing";

const authenticateApiKey = async (
  context: Context
): Promise<ApiKeyRecord | Response> => {
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
  return (
    apiKey ??
    context.json(
      {
        error: "unauthorized",
        message: "Invalid or expired API key",
      },
      401
    )
  );
};

const apiKeyMiddleware = (delegateOnly: boolean) =>
  createMiddleware(async (context, next) => {
    const apiKey = await authenticateApiKey(context);
    if (apiKey instanceof Response) {
      return apiKey;
    }
    if (delegateOnly && !apiKey.delegate) {
      return context.json(
        { error: "forbidden", message: "API key is not a delegate key" },
        403
      );
    }
    context.set("apiKey", apiKey);
    await next();
  });

export const requireApiKey = apiKeyMiddleware(false);
export const requireDelegateApiKey = apiKeyMiddleware(true);

export const requireProxyApiKey = createMiddleware(async (context, next) => {
  const apiKey = await authenticateApiKey(context);
  if (apiKey instanceof Response) {
    return apiKey;
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

  const owner = requestedModel ? splitOwnerSuffix(requestedModel).owner : null;
  if (owner && !apiKey.delegate) {
    return context.json(
      {
        error: "forbidden",
        message: "Only delegate API keys can use per-owner model names",
      },
      403
    );
  }
  if (owner && !(await hasLiveGrant(db, apiKey.id, owner, Date.now()))) {
    return context.json(
      {
        error: "grant_missing",
        message: `This API key has no live grant for ${owner}. Ask for a grant before using their model names.`,
      },
      403
    );
  }

  context.set("proxyApiKeyId", apiKey.id);
  context.set("proxyApiKeyAccountScopeIds", apiKey.accountScopes);
  context.set("proxyOwnerId", owner);
  await next();
});
