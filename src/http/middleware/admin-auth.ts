import { createMiddleware } from "hono/factory";

import { parseBearerToken } from "../utils/bearer";

export const requireAdminAuth = createMiddleware(async (context, next) => {
  const configuredToken = process.env.ADMIN_TOKEN;
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
    context.header("Cache-Control", "no-store");
    return context.json(
      {
        error: "unauthorized",
        message: "Missing or invalid admin bearer token",
      },
      401
    );
  }

  context.header("Cache-Control", "no-store");
  await next();
});
