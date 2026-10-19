import { Hono } from "hono";

import type { Database } from "../../db";
import { summarizeProviderAccountHealth } from "../../domain/providers/provider-account-health";
import { gracefulShutdown } from "../graceful-shutdown";

export const createHealthRoutes = (
  isDraining: () => boolean,
  database?: Database
) =>
  new Hono().get("/healthz", async (context) => {
    if (isDraining()) {
      return context.json(
        { ok: false, service: "kleis", draining: true, now: Date.now() },
        503
      );
    }

    const accounts =
      context.req.query("accounts") === "1"
        ? await summarizeProviderAccountHealth(
            database ?? (await import("../../db")).db
          )
        : undefined;
    return context.json({
      ok: true,
      service: "kleis",
      now: Date.now(),
      ...(accounts ? { accounts } : {}),
    });
  });

export const healthRoutes = createHealthRoutes(gracefulShutdown.isDraining);
