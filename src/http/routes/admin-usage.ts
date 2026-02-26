import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { db } from "../../db";
import { getDashboardUsage } from "../../db/repositories/dashboard-usage";
import { resolveUsageWindow, usageWindowQuerySchema } from "./usage-window";

export const adminUsageRoutes = new Hono().get(
  "/dashboard",
  zValidator("query", usageWindowQuerySchema),
  async (context) => {
    const query = context.req.valid("query");
    const { windowMs, now, since } = resolveUsageWindow(query.windowMs);
    const data = await getDashboardUsage(db, since, windowMs);

    return context.json({
      windowMs,
      since,
      now,
      ...data,
    });
  }
);
