import { providers, type Provider } from "../schema";

const USAGE_BUCKET_MS = 60_000;
export const DETAIL_BUCKET_LIMIT = 60;

const toInteger = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.trunc(parsed);
};

export const toNonNegativeInteger = (value: unknown): number =>
  Math.max(0, toInteger(value));

export const toUsageBucketStart = (timestampMs: number): number =>
  timestampMs - (timestampMs % USAGE_BUCKET_MS);

const maxTimestamp = (left: number | null, right: unknown): number | null => {
  if (right === null || right === undefined) {
    return left;
  }

  const rightValue = toNonNegativeInteger(right);
  if (left === null || rightValue > left) {
    return rightValue;
  }

  return left;
};

export const parseProvider = (value: string): Provider | null => {
  for (const provider of providers) {
    if (provider === value) {
      return provider;
    }
  }

  return null;
};

export type UsageTotals = {
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  lastRequestAt: number | null;
};

export const emptyUsageTotals = (): UsageTotals => ({
  requestCount: 0,
  successCount: 0,
  clientErrorCount: 0,
  serverErrorCount: 0,
  authErrorCount: 0,
  rateLimitCount: 0,
  totalLatencyMs: 0,
  maxLatencyMs: 0,
  lastRequestAt: null,
});

type UsageTotalsRow = {
  requestCount: unknown;
  successCount: unknown;
  clientErrorCount: unknown;
  serverErrorCount: unknown;
  authErrorCount?: unknown;
  rateLimitCount?: unknown;
  totalLatencyMs: unknown;
  maxLatencyMs: unknown;
  lastRequestAt: unknown;
};

export const applyTotalsRow = (
  target: UsageTotals,
  row: UsageTotalsRow
): void => {
  target.requestCount += toNonNegativeInteger(row.requestCount);
  target.successCount += toNonNegativeInteger(row.successCount);
  target.clientErrorCount += toNonNegativeInteger(row.clientErrorCount);
  target.serverErrorCount += toNonNegativeInteger(row.serverErrorCount);
  target.authErrorCount += toNonNegativeInteger(row.authErrorCount);
  target.rateLimitCount += toNonNegativeInteger(row.rateLimitCount);
  target.totalLatencyMs += toNonNegativeInteger(row.totalLatencyMs);
  target.maxLatencyMs = Math.max(
    target.maxLatencyMs,
    toNonNegativeInteger(row.maxLatencyMs)
  );
  target.lastRequestAt = maxTimestamp(target.lastRequestAt, row.lastRequestAt);
};

export const toAveragedTotals = (
  totals: UsageTotals
): {
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  lastRequestAt: number | null;
} => ({
  requestCount: totals.requestCount,
  successCount: totals.successCount,
  clientErrorCount: totals.clientErrorCount,
  serverErrorCount: totals.serverErrorCount,
  authErrorCount: totals.authErrorCount,
  rateLimitCount: totals.rateLimitCount,
  avgLatencyMs:
    totals.requestCount > 0
      ? Math.round(totals.totalLatencyMs / totals.requestCount)
      : 0,
  maxLatencyMs: totals.maxLatencyMs,
  lastRequestAt: totals.lastRequestAt,
});
