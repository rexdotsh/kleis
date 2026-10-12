import { describe, expect, test } from "bun:test";

import { drainServer, isDraining } from "../../src/http/graceful-shutdown";
import { healthRoutes } from "../../src/http/routes/health";

describe("graceful shutdown", () => {
  test("fails health checks, then waits for in-flight requests before stopping", async () => {
    expect((await healthRoutes.request("/healthz")).status).toBe(200);

    const events: string[] = [];
    let finishInFlight: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      finishInFlight = resolve;
    });
    const drained = drainServer({
      server: {
        stop: async () => {
          events.push("stop");
          await inFlight;
          events.push("in-flight finished");
        },
      },
      graceMs: 10,
      timeoutMs: 5000,
    });

    expect(isDraining()).toBe(true);
    const health = await healthRoutes.request("/healthz");
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ok: false, draining: true });
    expect(events).toEqual([]);

    await Bun.sleep(30);
    expect(events).toEqual(["stop"]);
    finishInFlight?.();
    expect(await drained).toBe("drained");
    expect(events).toEqual(["stop", "in-flight finished"]);
  });

  test("gives up waiting after the drain timeout", async () => {
    const outcome = await drainServer({
      server: { stop: () => new Promise<void>(() => undefined) },
      graceMs: 0,
      timeoutMs: 20,
    });

    expect(outcome).toBe("timed_out");
  });
});
