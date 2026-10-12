import { logWarn } from "../utils/log";

// Must exceed the reverse proxy's active health-check interval so it stops
// routing new requests here before this process stops accepting connections.
const DEFAULT_DRAIN_GRACE_MS = 6000;
// Must stay below the container's stop grace period (15m in compose).
const DEFAULT_DRAIN_TIMEOUT_MS = 14 * 60 * 1000;
// Usage rows are written in the background after a response finishes.
const EXIT_FLUSH_DELAY_MS = 3000;

let draining = false;
let trackedServer: Bun.Server<unknown> | null = null;

const readDurationMs = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const isDraining = (): boolean => draining;

export const trackServer = (server: Bun.Server<unknown>): void => {
  trackedServer ??= server;
};

export const drainServer = async (input: {
  server: Pick<Bun.Server<unknown>, "stop"> | null;
  graceMs: number;
  timeoutMs: number;
}): Promise<"drained" | "timed_out"> => {
  draining = true;
  if (!input.server) {
    return "drained";
  }

  await Bun.sleep(input.graceMs);
  // Without `true`, stop() refuses new connections and resolves once
  // in-flight requests, including long SSE streams, have finished.
  const stopped = input.server.stop().then(() => "drained" as const);
  return await Promise.race([
    stopped,
    Bun.sleep(input.timeoutMs).then(() => "timed_out" as const),
  ]);
};

export const installGracefulShutdown = (): void => {
  process.once("SIGTERM", async () => {
    const graceMs = readDurationMs("DRAIN_GRACE_MS", DEFAULT_DRAIN_GRACE_MS);
    const timeoutMs = readDurationMs(
      "DRAIN_TIMEOUT_MS",
      DEFAULT_DRAIN_TIMEOUT_MS
    );
    logWarn("server_draining", { graceMs, timeoutMs });
    const outcome = await drainServer({
      server: trackedServer,
      graceMs,
      timeoutMs,
    });
    logWarn("server_drained", { outcome });
    await Bun.sleep(EXIT_FLUSH_DELAY_MS);
    process.exit(0);
  });
};
