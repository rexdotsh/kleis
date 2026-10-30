import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import { db } from "../../db";
import { lookupCacheGeneration } from "../../db/lookup-cache";
import {
  findActiveApiKeyByValue,
  type ApiKeyRecord,
} from "../../db/repositories/api-keys";
import { parseBearerToken } from "../utils/bearer";
import {
  isModelInScope,
  readProxyRequestBody,
  resolveProxyRoute,
} from "../proxy-routing";

const invalidApiKeyResponse = (context: Context): Response =>
  context.json(
    {
      error: "unauthorized",
      message: "Invalid or expired API key",
    },
    401
  );

type AuthenticatedApiKey = {
  apiKey: ApiKeyRecord;
  token: string;
  generation: number;
};

const authenticateApiKey = async (
  context: Context
): Promise<AuthenticatedApiKey | Response> => {
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

  const generation = lookupCacheGeneration();
  const apiKey = await findActiveApiKeyByValue(db, token, Date.now());
  return apiKey
    ? { apiKey, token, generation }
    : invalidApiKeyResponse(context);
};

// A rotation or revoke during the lookup or a slow body upload bumps the
// generation, so the key is looked up again before the request is forwarded.
const reauthenticateIfChanged = async (
  auth: AuthenticatedApiKey
): Promise<ApiKeyRecord | null> => {
  let { apiKey, generation } = auth;
  while (generation !== lookupCacheGeneration()) {
    generation = lookupCacheGeneration();
    const current = await findActiveApiKeyByValue(db, auth.token, Date.now());
    if (!current) {
      return null;
    }
    apiKey = current;
  }
  return apiKey;
};

export const requireApiKey = createMiddleware(async (context, next) => {
  const auth = await authenticateApiKey(context);
  if (auth instanceof Response) {
    return auth;
  }
  context.set("apiKey", auth.apiKey);
  await next();
});

export const requireProxyApiKey = createMiddleware(async (context, next) => {
  const auth = await authenticateApiKey(context);
  if (auth instanceof Response) {
    return auth;
  }

  const route = resolveProxyRoute(context.req.path);

  const isProxyRequest = context.req.method === "POST" && route !== null;

  let requestedModel: string | null = null;
  if (isProxyRequest) {
    const requestBody = await readProxyRequestBody(context.req.raw);
    if (!("text" in requestBody)) {
      return context.json(
        { error: "bad_request", message: requestBody.message },
        requestBody.status
      );
    }
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

  const apiKey = await reauthenticateIfChanged(auth);
  if (!apiKey) {
    return invalidApiKeyResponse(context);
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
