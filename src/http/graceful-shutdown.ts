import { errorLogFields, logWarn } from "../utils/log";

// Longer than Caddy's 2s health-check interval.
const DRAIN_GRACE_MS = 6000;
const DRAIN_TIMEOUT_MS = 14 * 60 * 1000;
const EXIT_FLUSH_DELAY_MS = 3000;

type StoppableServer = Pick<Bun.Server<unknown>, "stop">;
type DrainOutcome = "drained" | "timed_out";

const readDurationMs = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const createGracefulShutdown = () => {
  let draining: Promise<DrainOutcome> | null = null;
  let server: StoppableServer | null = null;
  const beforeExitHooks: Array<() => Promise<void>> = [];

  const drain = (input: {
    graceMs: number;
    timeoutMs: number;
  }): Promise<DrainOutcome> => {
    draining ??= (async () => {
      const current = server;
      if (!current) {
        return "drained" as const;
      }
      await Bun.sleep(input.graceMs);
      const outcome = await Promise.race([
        current.stop().then(() => "drained" as const),
        Bun.sleep(input.timeoutMs).then(() => "timed_out" as const),
      ]);
      if (outcome === "timed_out") {
        // Closing the remaining connections cancels their streams, which
        // records them before the exit hooks flush usage.
        await current.stop(true);
      }
      return outcome;
    })();
    return draining;
  };

  return {
    isDraining: (): boolean => draining !== null,
    trackServer: (value: StoppableServer): void => {
      server ??= value;
    },
    drain,
    beforeExit: (hook: () => Promise<void>): void => {
      beforeExitHooks.push(hook);
    },
    install: (): void => {
      process.on("SIGTERM", async () => {
        if (draining) {
          return;
        }
        const graceMs = readDurationMs("DRAIN_GRACE_MS", DRAIN_GRACE_MS);
        const timeoutMs = readDurationMs("DRAIN_TIMEOUT_MS", DRAIN_TIMEOUT_MS);
        logWarn("server_draining", { graceMs, timeoutMs });
        const outcome = await drain({ graceMs, timeoutMs });
        logWarn("server_drained", { outcome });
        for (const hook of beforeExitHooks) {
          await hook().catch((error: unknown) => {
            logWarn("server_exit_hook_failed", errorLogFields(error));
          });
        }
        await Bun.sleep(EXIT_FLUSH_DELAY_MS);
        process.exit(0);
      });
    },
  };
};

export const gracefulShutdown = createGracefulShutdown();
