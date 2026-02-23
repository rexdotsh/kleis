import { Hono } from "hono";

import type { AppEnv } from "../app-env";

export const healthRoutes = new Hono<AppEnv>().get("/healthz", (context) =>
  context.json({
    ok: true,
    service: "kleis",
    now: Date.now(),
  })
);
