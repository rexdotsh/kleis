import { Hono } from "hono";

export const healthRoutes = new Hono().get("/healthz", (context) =>
  context.json({
    ok: true,
    service: "kleis",
    now: Date.now(),
  })
);
