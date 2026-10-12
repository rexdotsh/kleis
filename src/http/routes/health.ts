import { Hono } from "hono";

import { gracefulShutdown } from "../graceful-shutdown";

export const createHealthRoutes = (isDraining: () => boolean) =>
  new Hono().get("/healthz", (context) => {
    if (isDraining()) {
      return context.json(
        { ok: false, service: "kleis", draining: true, now: Date.now() },
        503
      );
    }

    return context.json({
      ok: true,
      service: "kleis",
      now: Date.now(),
    });
  });

export const healthRoutes = createHealthRoutes(gracefulShutdown.isDraining);
