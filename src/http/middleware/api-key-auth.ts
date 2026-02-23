import { createMiddleware } from "hono/factory";

import { dbFromContext } from "../../db/client";
import { findActiveApiKeyByValue } from "../../db/repositories/api-keys";
import type { AppEnv } from "../app-env";
import {
  authRateLimitedResponse,
  authRateLimitRetryAfter,
  clearAuthRateLimit,
  registerAuthRateLimitFailure,
  type AuthRateLimitPolicy,
} from "../security/auth-rate-limit";
import { parseBearerToken } from "../utils/bearer";
import {
  modelScopeCandidates,
  parseModelForProxyRoute,
  readModelFromBody,
  resolveProxyRoute,
} from "../proxy-routing";

const PROXY_AUTH_RATE_LIMIT: AuthRateLimitPolicy = {
  scope: "proxy",
  maxFailures: 120,
  windowMs: 60_000,
  blockMs: 60_000,
  message: "Too many invalid API key attempts",
};

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

export const requireProxyApiKey = createMiddleware<AppEnv>(
  async (context, next) => {
    const retryAfter = authRateLimitRetryAfter(
      PROXY_AUTH_RATE_LIMIT,
      context.req.raw.headers
    );
    if (retryAfter !== null) {
      return authRateLimitedResponse(
        context,
        retryAfter,
        PROXY_AUTH_RATE_LIMIT.message
      );
    }

    const token =
      parseBearerToken(context.req.header("authorization")) ??
      context.req.header("x-api-key")?.trim() ??
      null;
    if (!token) {
      const blockedAfter = registerAuthRateLimitFailure(
        PROXY_AUTH_RATE_LIMIT,
        context.req.raw.headers
      );
      if (blockedAfter !== null) {
        return authRateLimitedResponse(
          context,
          blockedAfter,
          PROXY_AUTH_RATE_LIMIT.message
        );
      }

      return context.json(
        {
          error: "unauthorized",
          message: "Missing API key",
        },
        401
      );
    }

    const database = dbFromContext(context);
    const apiKey = await findActiveApiKeyByValue(database, token, Date.now());
    if (!apiKey) {
      const blockedAfter = registerAuthRateLimitFailure(
        PROXY_AUTH_RATE_LIMIT,
        context.req.raw.headers
      );
      if (blockedAfter !== null) {
        return authRateLimitedResponse(
          context,
          blockedAfter,
          PROXY_AUTH_RATE_LIMIT.message
        );
      }

      return context.json(
        {
          error: "unauthorized",
          message: "Invalid or expired API key",
        },
        401
      );
    }

    const route = resolveProxyRoute(context.req.path);
    const requestedModel = route
      ? await readRequestedModel(context.req.raw)
      : null;
    const requestedModelRoute = route
      ? parseModelForProxyRoute(requestedModel, route)
      : {
          rawModel: null,
          upstreamModel: null,
        };

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
      const modelCandidates = modelScopeCandidates(requestedModelRoute, route);
      const allowed = modelCandidates.some((candidate) =>
        apiKey.modelScopes?.includes(candidate)
      );
      if (!allowed) {
        const deniedModel = requestedModelRoute.rawModel ?? null;
        return context.json(
          {
            error: "forbidden",
            message: deniedModel
              ? `API key is not allowed to access model: ${deniedModel}`
              : "API key model scope requires an explicit model field",
          },
          403
        );
      }
    }

    clearAuthRateLimit(PROXY_AUTH_RATE_LIMIT, context.req.raw.headers);
    await next();
  }
);
