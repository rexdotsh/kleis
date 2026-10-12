import { Hono } from "hono";

import { isDraining } from "../graceful-shutdown";

export const healthRoutes = new Hono().get("/healthz", (context) => {
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
