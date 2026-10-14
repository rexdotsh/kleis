import type { Provider } from "../db/schema";
import { logError, logWarn } from "../utils/log";

const LOG_INTERVAL_MS = 60_000;
const MAX_FAILURE_KEYS = 256;
const FLUSH_INTERVAL_MS = 1000;

type UpstreamFailureFields = {
  provider: Provider;
  providerAccountId: string;
  endpoint: string;
  status: number;
  errorType: string | null;
  errorCode: string | null;
  elapsedMs: number;
  requestIdHash: string | null;
};

type FailureEntry = {
  fields: UpstreamFailureFields;
  loggedAt: number;
  suppressedCount: number;
};

type SummaryReason = "window_expired" | "evicted" | "shutdown";

export const createUpstreamFailureLogger = (
  options: { now?: () => number; flushIntervalMs?: number } = {}
) => {
  const now = options.now ?? Date.now;
  const entries = new Map<string, FailureEntry>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const summarize = (entry: FailureEntry, reason: SummaryReason): void => {
    if (!entry.suppressedCount) {
      return;
    }
    const log = entry.fields.status >= 500 ? logError : logWarn;
    log("proxy_upstream_response_failed", {
      ...entry.fields,
      suppressedCount: entry.suppressedCount,
      summaryReason: reason,
      windowMs: now() - entry.loggedAt,
    });
  };

  const flush = (reason: "window_expired" | "shutdown"): void => {
    const time = now();
    for (const [key, entry] of entries) {
      if (
        reason === "window_expired" &&
        time - entry.loggedAt < LOG_INTERVAL_MS
      ) {
        continue;
      }
      summarize(entry, reason);
      entries.delete(key);
    }
    if (!entries.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const record = (fields: UpstreamFailureFields): void => {
    const key = [
      fields.provider,
      fields.providerAccountId,
      fields.endpoint,
      fields.status,
      fields.errorType,
      fields.errorCode,
    ].join("\0");
    const time = now();
    const previous = entries.get(key);
    if (previous && time - previous.loggedAt < LOG_INTERVAL_MS) {
      previous.suppressedCount++;
      previous.fields = fields;
      return;
    }
    if (previous) {
      summarize(previous, "window_expired");
    } else if (entries.size === MAX_FAILURE_KEYS) {
      const oldest = entries.entries().next().value;
      if (oldest !== undefined) {
        summarize(oldest[1], "evicted");
        entries.delete(oldest[0]);
      }
    }
    entries.set(key, { fields, loggedAt: time, suppressedCount: 0 });
    const log = fields.status >= 500 ? logError : logWarn;
    log("proxy_upstream_response_failed", fields);
    if (!timer) {
      timer = setInterval(
        () => flush("window_expired"),
        options.flushIntervalMs ?? FLUSH_INTERVAL_MS
      );
      timer.unref();
    }
  };

  return { log: record, flush: (): void => flush("shutdown") };
};
