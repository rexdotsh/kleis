import { createMiddleware } from "hono/factory";

import { dbFromContext } from "../../db/client";
import { findActiveApiKeyByValue } from "../../db/repositories/api-keys";
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

    context.set("apiKeyId", apiKey.id);
    await next();
  }
);
