import { sql } from "drizzle-orm";

import { providers, type requestUsageBuckets, type Provider } from "../schema";

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

type UsageBucketsTable = typeof requestUsageBuckets;

export const selectUsageCounterSums = (table: UsageBucketsTable) => ({
  requestCount: sql<number>`sum(${table.requestCount})`,
  successCount: sql<number>`sum(${table.successCount})`,
  clientErrorCount: sql<number>`sum(${table.clientErrorCount})`,
  serverErrorCount: sql<number>`sum(${table.serverErrorCount})`,
  authErrorCount: sql<number>`sum(${table.authErrorCount})`,
  rateLimitCount: sql<number>`sum(${table.rateLimitCount})`,
});

export const selectUsageLatencySums = (table: UsageBucketsTable) => ({
  totalLatencyMs: sql<number>`sum(${table.totalLatencyMs})`,
  maxLatencyMs: sql<number>`max(${table.maxLatencyMs})`,
});

export const selectUsageTokenSums = (table: UsageBucketsTable) => ({
  inputTokens: sql<number>`sum(${table.inputTokens})`,
  outputTokens: sql<number>`sum(${table.outputTokens})`,
  cacheReadTokens: sql<number>`sum(${table.cacheReadTokens})`,
  cacheWriteTokens: sql<number>`sum(${table.cacheWriteTokens})`,
});

export const selectUsageLastRequestAtMax = (table: UsageBucketsTable) => ({
  lastRequestAt: sql<number>`max(${table.lastRequestAt})`,
});

export type UsageTotals = {
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
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
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
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
  target.inputTokens += toNonNegativeInteger(row.inputTokens);
  target.outputTokens += toNonNegativeInteger(row.outputTokens);
  target.cacheReadTokens += toNonNegativeInteger(row.cacheReadTokens);
  target.cacheWriteTokens += toNonNegativeInteger(row.cacheWriteTokens);
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
  inputTokens: totals.inputTokens,
  outputTokens: totals.outputTokens,
  cacheReadTokens: totals.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens,
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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type UsageProviderSummaryRow = {
  provider: string;
  requestCount: unknown;
  successCount: unknown;
  clientErrorCount: unknown;
  serverErrorCount: unknown;
  authErrorCount?: unknown;
  rateLimitCount?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
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
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
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
  target.inputTokens += toNonNegativeInteger(row.inputTokens);
  target.outputTokens += toNonNegativeInteger(row.outputTokens);
  target.cacheReadTokens += toNonNegativeInteger(row.cacheReadTokens);
  target.cacheWriteTokens += toNonNegativeInteger(row.cacheWriteTokens);
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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  lastRequestAt: number | null;
};

type UsageEndpointRow = UsageProviderSummaryRow & {
  endpoint: string;
  totalLatencyMs: unknown;
  maxLatencyMs: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
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
      inputTokens: toNonNegativeInteger(row.inputTokens),
      outputTokens: toNonNegativeInteger(row.outputTokens),
      cacheReadTokens: toNonNegativeInteger(row.cacheReadTokens),
      cacheWriteTokens: toNonNegativeInteger(row.cacheWriteTokens),
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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type UsageBucketSummaryRow = {
  bucketStart: unknown;
  requestCount: unknown;
  successCount: unknown;
  clientErrorCount: unknown;
  serverErrorCount: unknown;
  authErrorCount?: unknown;
  rateLimitCount?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
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
        inputTokens: toNonNegativeInteger(row.inputTokens),
        outputTokens: toNonNegativeInteger(row.outputTokens),
        cacheReadTokens: toNonNegativeInteger(row.cacheReadTokens),
        cacheWriteTokens: toNonNegativeInteger(row.cacheWriteTokens),
      })
    )
    .reverse();

export type UsageModelBreakdown = {
  provider: Provider;
  endpoint: string;
  model: string;
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  lastRequestAt: number | null;
};

type UsageModelRow = UsageEndpointRow & {
  model: string;
};

export const mapModelUsageRows = (
  rows: readonly UsageModelRow[]
): UsageModelBreakdown[] => {
  const models: UsageModelBreakdown[] = [];

  for (const row of rows) {
    const provider = parseProvider(row.provider);
    if (!provider) {
      continue;
    }

    const requestCount = toNonNegativeInteger(row.requestCount);
    const totalLatencyMs = toNonNegativeInteger(row.totalLatencyMs);
    models.push({
      provider,
      endpoint: row.endpoint,
      model: row.model,
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
      inputTokens: toNonNegativeInteger(row.inputTokens),
      outputTokens: toNonNegativeInteger(row.outputTokens),
      cacheReadTokens: toNonNegativeInteger(row.cacheReadTokens),
      cacheWriteTokens: toNonNegativeInteger(row.cacheWriteTokens),
      lastRequestAt:
        row.lastRequestAt === null
          ? null
          : toNonNegativeInteger(row.lastRequestAt),
    });
  }

  models.sort((left, right) => {
    const leftQuality =
      (left.model.trim().length > 0 ? 2 : 0) + (left.successCount > 0 ? 1 : 0);
    const rightQuality =
      (right.model.trim().length > 0 ? 2 : 0) +
      (right.successCount > 0 ? 1 : 0);
    const qualityDifference = rightQuality - leftQuality;
    if (qualityDifference !== 0) {
      return qualityDifference;
    }

    const requestDifference = right.requestCount - left.requestCount;
    if (requestDifference !== 0) {
      return requestDifference;
    }

    const outputDifference = right.outputTokens - left.outputTokens;
    if (outputDifference !== 0) {
      return outputDifference;
    }

    const inputDifference = right.inputTokens - left.inputTokens;
    if (inputDifference !== 0) {
      return inputDifference;
    }

    return (right.lastRequestAt ?? 0) - (left.lastRequestAt ?? 0);
  });

  return models;
};
