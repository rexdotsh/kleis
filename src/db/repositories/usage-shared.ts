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

const parseProvider = (value: string): Provider | null => {
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

type AveragedUsageTotals = {
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
  avgLatencyMs: number;
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

export const toAveragedTotals = (totals: UsageTotals): AveragedUsageTotals => ({
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

export type UsageProviderSummary = {
  provider: Provider;
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
};

type UsageProviderSummaryRow = {
  provider: string;
  requestCount: unknown;
  successCount: unknown;
  clientErrorCount: unknown;
  serverErrorCount: unknown;
  authErrorCount?: unknown;
  rateLimitCount?: unknown;
};

const ensureProviderSummary = (
  providersByName: Map<Provider, UsageProviderSummary>,
  provider: Provider
): UsageProviderSummary => {
  const existing = providersByName.get(provider);
  if (existing) {
    return existing;
  }

  const created: UsageProviderSummary = {
    provider,
    requestCount: 0,
    successCount: 0,
    clientErrorCount: 0,
    serverErrorCount: 0,
    authErrorCount: 0,
    rateLimitCount: 0,
  };
  providersByName.set(provider, created);
  return created;
};

const applyProviderSummaryRow = (
  target: UsageProviderSummary,
  row: UsageProviderSummaryRow
): void => {
  target.requestCount += toNonNegativeInteger(row.requestCount);
  target.successCount += toNonNegativeInteger(row.successCount);
  target.clientErrorCount += toNonNegativeInteger(row.clientErrorCount);
  target.serverErrorCount += toNonNegativeInteger(row.serverErrorCount);
  target.authErrorCount += toNonNegativeInteger(row.authErrorCount);
  target.rateLimitCount += toNonNegativeInteger(row.rateLimitCount);
};

type MutableGroupedUsageSummary = {
  totals: UsageTotals;
  providers: Map<Provider, UsageProviderSummary>;
};

type GroupedUsageTotalsRow = UsageTotalsRow & {
  groupKey: string;
};

type GroupedUsageProviderRow = UsageProviderSummaryRow & {
  groupKey: string;
};

export const summarizeGroupedUsageRows = (input: {
  totalsRows: readonly GroupedUsageTotalsRow[];
  providerRows: readonly GroupedUsageProviderRow[];
}): Array<{
  groupKey: string;
  totals: AveragedUsageTotals;
  providers: UsageProviderSummary[];
}> => {
  const summariesByGroup = new Map<string, MutableGroupedUsageSummary>();

  const ensureSummary = (groupKey: string): MutableGroupedUsageSummary => {
    const existing = summariesByGroup.get(groupKey);
    if (existing) {
      return existing;
    }

    const created: MutableGroupedUsageSummary = {
      totals: emptyUsageTotals(),
      providers: new Map(),
    };
    summariesByGroup.set(groupKey, created);
    return created;
  };

  for (const row of input.totalsRows) {
    const summary = ensureSummary(row.groupKey);
    applyTotalsRow(summary.totals, row);
  }

  for (const row of input.providerRows) {
    const provider = parseProvider(row.provider);
    if (!provider) {
      continue;
    }

    const summary = ensureSummary(row.groupKey);
    const providerSummary = ensureProviderSummary(summary.providers, provider);
    applyProviderSummaryRow(providerSummary, row);
  }

  const summaries = Array.from(summariesByGroup.entries()).map(
    ([groupKey, summary]) => ({
      groupKey,
      totals: toAveragedTotals(summary.totals),
      providers: Array.from(summary.providers.values()).sort(
        (left, right) => right.requestCount - left.requestCount
      ),
    })
  );

  summaries.sort(
    (left, right) =>
      right.totals.requestCount - left.totals.requestCount ||
      (right.totals.lastRequestAt ?? 0) - (left.totals.lastRequestAt ?? 0)
  );

  return summaries;
};

export type UsageEndpointBreakdown = {
  provider: Provider;
  endpoint: string;
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  lastRequestAt: number | null;
};

type UsageEndpointRow = UsageProviderSummaryRow & {
  endpoint: string;
  totalLatencyMs: unknown;
  maxLatencyMs: unknown;
  lastRequestAt: unknown;
};

export const mapEndpointUsageRows = (
  rows: readonly UsageEndpointRow[]
): UsageEndpointBreakdown[] => {
  const endpoints: UsageEndpointBreakdown[] = [];

  for (const row of rows) {
    const provider = parseProvider(row.provider);
    if (!provider) {
      continue;
    }

    const requestCount = toNonNegativeInteger(row.requestCount);
    const totalLatencyMs = toNonNegativeInteger(row.totalLatencyMs);
    endpoints.push({
      provider,
      endpoint: row.endpoint,
      requestCount,
      successCount: toNonNegativeInteger(row.successCount),
      clientErrorCount: toNonNegativeInteger(row.clientErrorCount),
      serverErrorCount: toNonNegativeInteger(row.serverErrorCount),
      authErrorCount: toNonNegativeInteger(row.authErrorCount),
      rateLimitCount: toNonNegativeInteger(row.rateLimitCount),
      avgLatencyMs: requestCount
        ? Math.round(totalLatencyMs / requestCount)
        : 0,
      maxLatencyMs: toNonNegativeInteger(row.maxLatencyMs),
      lastRequestAt:
        row.lastRequestAt === null
          ? null
          : toNonNegativeInteger(row.lastRequestAt),
    });
  }

  endpoints.sort((left, right) => right.requestCount - left.requestCount);
  return endpoints;
};

export type UsageBucketRow = {
  bucketStart: number;
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
};

type UsageBucketSummaryRow = {
  bucketStart: unknown;
  requestCount: unknown;
  successCount: unknown;
  clientErrorCount: unknown;
  serverErrorCount: unknown;
  authErrorCount?: unknown;
  rateLimitCount?: unknown;
};

export const mapUsageBucketRows = (
  rows: readonly UsageBucketSummaryRow[]
): UsageBucketRow[] =>
  rows
    .map(
      (row): UsageBucketRow => ({
        bucketStart: toNonNegativeInteger(row.bucketStart),
        requestCount: toNonNegativeInteger(row.requestCount),
        successCount: toNonNegativeInteger(row.successCount),
        clientErrorCount: toNonNegativeInteger(row.clientErrorCount),
        serverErrorCount: toNonNegativeInteger(row.serverErrorCount),
        authErrorCount: toNonNegativeInteger(row.authErrorCount),
        rateLimitCount: toNonNegativeInteger(row.rateLimitCount),
      })
    )
    .reverse();
