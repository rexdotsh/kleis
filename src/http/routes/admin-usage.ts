import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";

import { db } from "../../db";
import { getDashboardUsage } from "../../db/repositories/dashboard-usage";
import { ownerIdSchema } from "../../domain/owners";
import { resolveUsageWindow, usageWindowQuerySchema } from "./usage-window";

const dashboardQuerySchema = usageWindowQuerySchema.extend({
  owner: ownerIdSchema.optional(),
});

export const adminUsageRoutes = new Hono().get(
  "/dashboard",
  zValidator("query", dashboardQuerySchema),
  async (context) => {
    const query = context.req.valid("query");
    const { windowMs, now, since } = resolveUsageWindow(query.windowMs);
    const data = await getDashboardUsage(db, since, windowMs, query.owner);

    return context.json({
      windowMs,
      since,
      now,
      ...data,
    });
  }
);
