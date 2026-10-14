import { describe, expect, test } from "bun:test";

import { createGracefulShutdown } from "../../src/http/graceful-shutdown";
import { createHealthRoutes } from "../../src/http/routes/health";

const fakeServer = (pendingRequests: number) => {
  const stops: (boolean | undefined)[] = [];
  const server = {
    pendingRequests,
    stop: (closeActiveConnections?: boolean) => {
      stops.push(closeActiveConnections);
      return Promise.resolve();
    },
  };
  return { server, stops };
};

describe("graceful shutdown", () => {
  test("fails health checks, then waits for in-flight requests before stopping", async () => {
    const shutdown = createGracefulShutdown();
    const health = createHealthRoutes(shutdown.isDraining);
    expect((await health.request("/healthz")).status).toBe(200);

    const { server, stops } = fakeServer(1);
    shutdown.trackServer(server);
    const drained = shutdown.drain({ graceMs: 10, timeoutMs: 5000 });

    const draining = await health.request("/healthz");
    expect(draining.status).toBe(503);
    expect(await draining.json()).toMatchObject({ ok: false, draining: true });

    await Bun.sleep(150);
    expect(stops).toEqual([]);
    expect(shutdown.drain({ graceMs: 0, timeoutMs: 0 })).toBe(drained);
    server.pendingRequests = 0;
    expect(await drained).toBe("drained");
    expect(stops).toEqual([true]);
  });

  test("force-closes what is left after the drain timeout", async () => {
    const shutdown = createGracefulShutdown();
    const { server, stops } = fakeServer(1);
    shutdown.trackServer(server);

    expect(await shutdown.drain({ graceMs: 0, timeoutMs: 20 })).toBe(
      "timed_out"
    );
    expect(stops).toEqual([true]);
  });

  test("cancels an open response stream when the drain times out", async () => {
    let cancelled = false;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(new TextEncoder().encode("data: x\n\n"));
            },
            cancel(): void {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        ),
    });
    const response = await fetch(server.url);
    await response.body?.getReader().read();

    const shutdown = createGracefulShutdown();
    shutdown.trackServer(server);
    expect(await shutdown.drain({ graceMs: 0, timeoutMs: 20 })).toBe(
      "timed_out"
    );
    expect(cancelled).toBe(true);
  });
});
