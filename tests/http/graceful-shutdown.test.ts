import { describe, expect, test } from "bun:test";

import { createGracefulShutdown } from "../../src/http/graceful-shutdown";
import { createHealthRoutes } from "../../src/http/routes/health";

describe("graceful shutdown", () => {
  test("fails health checks, then waits for in-flight requests before stopping", async () => {
    const shutdown = createGracefulShutdown();
    const health = createHealthRoutes(shutdown.isDraining);
    expect((await health.request("/healthz")).status).toBe(200);

    const events: string[] = [];
    let finishInFlight: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      finishInFlight = resolve;
    });
    shutdown.trackServer({
      stop: async () => {
        events.push("stop");
        await inFlight;
        events.push("in-flight finished");
      },
    });
    const drained = shutdown.drain({ graceMs: 10, timeoutMs: 5000 });

    const draining = await health.request("/healthz");
    expect(draining.status).toBe(503);
    expect(await draining.json()).toMatchObject({ ok: false, draining: true });
    expect(events).toEqual([]);

    await Bun.sleep(30);
    expect(events).toEqual(["stop"]);
    expect(shutdown.drain({ graceMs: 0, timeoutMs: 0 })).toBe(drained);
    finishInFlight?.();
    expect(await drained).toBe("drained");
    expect(events).toEqual(["stop", "in-flight finished"]);
  });

  test("closes the remaining connections after the drain timeout", async () => {
    const shutdown = createGracefulShutdown();
    const stops: (boolean | undefined)[] = [];
    shutdown.trackServer({
      stop: (closeActiveConnections?: boolean) => {
        stops.push(closeActiveConnections);
        return closeActiveConnections
          ? Promise.resolve()
          : new Promise<void>(() => undefined);
      },
    });

    expect(await shutdown.drain({ graceMs: 0, timeoutMs: 20 })).toBe(
      "timed_out"
    );
    expect(stops).toEqual([undefined, true]);
  });
});
