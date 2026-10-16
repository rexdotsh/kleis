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
  for (const failure of ["stop", "hook"] as const) {
    test(`logs and exits cleanly when ${failure} fails during SIGTERM`, async () => {
      const moduleUrl = new URL(
        "../../src/http/graceful-shutdown.ts",
        import.meta.url
      ).href;
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `import { createGracefulShutdown } from ${JSON.stringify(moduleUrl)};
          const shutdown = createGracefulShutdown();
          shutdown.trackServer({
            pendingRequests: 0,
            stop: () => ${failure === "stop" ? 'Promise.reject(new Error("stop failed"))' : "Promise.resolve()"},
          });
          shutdown.beforeExit(() => { throw new Error("hook failed"); });
          shutdown.install();
          process.emit("SIGTERM");`,
        ],
        {
          env: { ...process.env, DRAIN_GRACE_MS: "0", DRAIN_TIMEOUT_MS: "0" },
          stdout: "ignore",
          stderr: "pipe",
        }
      );
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(1);
      expect(stderr).toContain('"event":"server_shutdown_failed"');
      expect(stderr).toContain(`${failure} failed`);
      expect(stderr).not.toContain("Unhandled");
    });
  }

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

  test("lets an in-flight SSE response finish before completing its drain", async () => {
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstream = controller;
              controller.enqueue(encoder.encode("data: first\n\n"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        ),
    });
    try {
      const response = await fetch(server.url);
      const reader = response.body?.getReader();
      expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(
        "data: first\n\n"
      );
      const shutdown = createGracefulShutdown();
      shutdown.trackServer(server);
      const draining = shutdown.drain({ graceMs: 0, timeoutMs: 2000 });
      await Bun.sleep(20);
      upstream?.enqueue(encoder.encode("data: last\n\n"));
      upstream?.close();
      expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(
        "data: last\n\n"
      );
      expect((await reader?.read())?.done).toBe(true);
      expect(await draining).toBe("drained");
      expect(cancelled).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
});
