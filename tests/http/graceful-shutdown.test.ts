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
    expect(server.pendingRequests).toBe(1);
    expect(await shutdown.drain({ graceMs: 0, timeoutMs: 20 })).toBe(
      "timed_out"
    );
    expect(cancelled).toBe(true);
  });

  test("pendingRequests tracks a live stream until it finishes during draining", async () => {
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              source = controller;
              controller.enqueue(new TextEncoder().encode("data: x\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        ),
    });
    try {
      const response = await fetch(server.url);
      const reader = response.body?.getReader();
      if (!reader || !source) {
        throw new Error("Missing response stream");
      }
      await reader.read();
      expect(server.pendingRequests).toBe(1);

      const shutdown = createGracefulShutdown();
      shutdown.trackServer(server);
      const drained = shutdown.drain({ graceMs: 0, timeoutMs: 2000 });
      source.close();
      expect((await reader.read()).done).toBe(true);
      expect(await drained).toBe("drained");
      expect(server.pendingRequests).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
});
