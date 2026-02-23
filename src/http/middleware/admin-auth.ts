import { createMiddleware } from "hono/factory";

import type { AppEnv } from "../app-env";
import { parseBearerToken } from "../utils/bearer";

export const requireAdminAuth = createMiddleware<AppEnv>(
  async (context, next) => {
    const configuredToken = context.env.ADMIN_TOKEN;
    if (typeof configuredToken !== "string" || !configuredToken.trim()) {
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
