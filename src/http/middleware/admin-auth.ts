import { createMiddleware } from "hono/factory";

import type { AppEnv } from "../app-env";
import {
  authRateLimitedResponse,
  authRateLimitRetryAfter,
  clearAuthRateLimit,
  registerAuthRateLimitFailure,
  type AuthRateLimitPolicy,
} from "../security/auth-rate-limit";
import { parseBearerToken } from "../utils/bearer";

const ADMIN_AUTH_RATE_LIMIT: AuthRateLimitPolicy = {
  scope: "admin",
  maxFailures: 12,
  windowMs: 60_000,
  blockMs: 5 * 60_000,
  message: "Too many invalid admin auth attempts",
};

export const requireAdminAuth = createMiddleware<AppEnv>(
  async (context, next) => {
    const retryAfter = authRateLimitRetryAfter(
      ADMIN_AUTH_RATE_LIMIT,
      context.req.raw.headers
    );
    if (retryAfter !== null) {
      return authRateLimitedResponse(
        context,
        retryAfter,
        ADMIN_AUTH_RATE_LIMIT.message
      );
    }

    const configuredToken = context.env.ADMIN_TOKEN;
    if (typeof configuredToken !== "string" || !configuredToken.trim()) {
      context.header("Cache-Control", "no-store");
      return context.json(
        {
          error: "admin_token_not_configured",
          message: "ADMIN_TOKEN is not configured",
        },
        503
      );
    }

    const token = parseBearerToken(context.req.header("authorization"));
    if (!token || token !== configuredToken) {
      const blockedAfter = registerAuthRateLimitFailure(
        ADMIN_AUTH_RATE_LIMIT,
        context.req.raw.headers
      );
      if (blockedAfter !== null) {
        return authRateLimitedResponse(
          context,
          blockedAfter,
          ADMIN_AUTH_RATE_LIMIT.message
        );
      }

      context.header("Cache-Control", "no-store");
      return context.json(
        {
          error: "unauthorized",
          message: "Missing or invalid admin bearer token",
        },
        401
      );
    }

    clearAuthRateLimit(ADMIN_AUTH_RATE_LIMIT, context.req.raw.headers);
    context.header("Cache-Control", "no-store");
    await next();
  }
);
