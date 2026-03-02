import { createMiddleware } from "hono/factory";

import { parseBearerToken } from "../utils/bearer";

const requireBearerEnvAuth = (envVar: string, label: string) =>
  createMiddleware(async (context, next) => {
    context.header("Cache-Control", "no-store");

    const configured = process.env[envVar]?.trim();
    if (!configured) {
      return context.json(
        {
          error: `${envVar.toLowerCase()}_not_configured`,
          message: `${envVar} is not configured`,
        },
        503
      );
    }

    const token = parseBearerToken(context.req.header("authorization"));
    if (!token || token !== configured) {
      return context.json(
        {
          error: "unauthorized",
          message: `Missing or invalid ${label} bearer token`,
        },
        401
      );
    }

    await next();
  });

export const requireAdminAuth = requireBearerEnvAuth("ADMIN_TOKEN", "admin");
export const requireCronAuth = requireBearerEnvAuth("CRON_SECRET", "cron");
