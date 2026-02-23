import { createMiddleware } from "hono/factory";

import { getAdminToken } from "../../config/runtime";
import type { AppEnv } from "../app-env";

const BEARER_PREFIX = "Bearer ";

const parseBearerToken = (
  authorizationHeader: string | undefined
): string | null => {
  if (!authorizationHeader?.startsWith(BEARER_PREFIX)) {
    return null;
  }

  return authorizationHeader.slice(BEARER_PREFIX.length).trim() || null;
};

export const requireAdminAuth = createMiddleware<AppEnv>(
  async (context, next) => {
    const configuredToken = getAdminToken(context.env);
    if (!configuredToken) {
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
      return context.json(
        {
          error: "unauthorized",
          message: "Missing or invalid admin bearer token",
        },
        401
      );
    }

    await next();
  }
);
