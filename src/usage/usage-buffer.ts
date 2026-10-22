import type { Database } from "../db";
import {
  type UsageBucketWrite,
  upsertUsageRows,
} from "../db/repositories/request-usage";
import { errorLogFields, logError, logWarn } from "../utils/log";

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_AT_ROWS = 200;
const MAX_PENDING_ROWS = 20_000;

const SUMMED_FIELDS = [
  "requestCount",
  "successCount",
  "clientErrorCount",
  "serverErrorCount",
  "authErrorCount",
  "rateLimitCount",
  "proxyErrorCount",
  "upstreamErrorCount",
  "totalLatencyMs",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheRepaidTokens",
  "inputTotalTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

const bucketKey = (row: UsageBucketWrite): string =>
  [
    row.bucketStart,
    row.apiKeyId,
    row.providerAccountId,
    row.provider,
    row.endpoint,
    row.model,
  ].join("\u0000");

const mergeInto = (target: UsageBucketWrite, row: UsageBucketWrite): void => {
  for (const field of SUMMED_FIELDS) {
    target[field] += row[field];
  }
  target.maxLatencyMs = Math.max(target.maxLatencyMs, row.maxLatencyMs);
  target.lastRequestAt = Math.max(target.lastRequestAt, row.lastRequestAt);
};

// Proxied requests add usage here instead of writing to Turso one request at a
// time; rows for the same minute bucket merge and are written in one batch.
export const createUsageBuffer = (
  database: Database,
  options: { flushIntervalMs?: number } = {}
) => {
  let pending = new Map<string, UsageBucketWrite>();
  let flushing: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const merge = (row: UsageBucketWrite): void => {
    const key = bucketKey(row);
    const existing = pending.get(key);
    if (existing) {
      mergeInto(existing, row);
    } else {
      pending.set(key, { ...row });
    }
  };

  const flush = async (): Promise<void> => {
    while (flushing) {
      await flushing;
    }
    if (!pending.size) {
      return;
    }
    const rows = Array.from(pending.values());
    pending = new Map();
    flushing = upsertUsageRows(database, rows)
      .catch((error: unknown) => {
        if (pending.size + rows.length > MAX_PENDING_ROWS) {
          logError("usage_flush_dropped", {
            rows: rows.length,
            ...errorLogFields(error),
          });
          return;
        }
        logWarn("usage_flush_failed", {
          rows: rows.length,
          ...errorLogFields(error),
        });
        for (const row of rows) {
          merge(row);
        }
      })
      .finally(() => {
        flushing = null;
      });
    await flushing;
  };

  return {
    add(row: UsageBucketWrite): void {
      merge(row);
      if (!timer) {
        timer = setInterval(() => {
          flush().catch(() => undefined);
        }, options.flushIntervalMs ?? FLUSH_INTERVAL_MS);
        timer.unref?.();
      }
      if (pending.size >= FLUSH_AT_ROWS) {
        flush().catch(() => undefined);
      }
    },
    flush,
    pendingRows: (): number => pending.size,
  };
};
