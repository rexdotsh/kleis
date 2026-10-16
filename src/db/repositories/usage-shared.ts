import { desc, sql, type SQL } from "drizzle-orm";

import { calculateSuccessRate } from "../../usage/request-outcome";
import { toNonNegativeInteger } from "../../utils/number";
import type { Database } from "../index";
import { providers, requestUsageBuckets, type Provider } from "../schema";

const USAGE_BUCKET_MS = 60_000;
export const DETAIL_BUCKET_LIMIT = 60;

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
  return providers.find((provider) => provider === value) ?? null;
};

type UsageBucketsTable = typeof requestUsageBuckets;

export const selectUsageCounterSums = (table: UsageBucketsTable) => ({
  requestCount: sql<number>`sum(${table.requestCount})`,
  successCount: sql<number>`sum(${table.successCount})`,
  clientErrorCount: sql<number>`sum(${table.clientErrorCount})`,
  serverErrorCount: sql<number>`sum(${table.serverErrorCount})`,
  authErrorCount: sql<number>`sum(${table.authErrorCount})`,
  rateLimitCount: sql<number>`sum(${table.rateLimitCount})`,
  proxyErrorCount: sql<number>`sum(${table.proxyErrorCount})`,
  upstreamErrorCount: sql<number>`sum(${table.upstreamErrorCount})`,
});

export const selectUsageLatencySums = (table: UsageBucketsTable) => ({
  totalLatencyMs: sql<number>`sum(${table.totalLatencyMs})`,
  maxLatencyMs: sql<number>`max(${table.maxLatencyMs})`,
});

export const selectUsageTokenSums = (table: UsageBucketsTable) => ({
  inputTokens: sql<number>`sum(${table.inputTokens})`,
  inputTotalTokens: sql<number>`sum(coalesce(${table.inputTotalTokens}, ${table.inputTokens} + ${table.cacheReadTokens} + ${table.cacheWriteTokens}))`,
  outputTokens: sql<number>`sum(${table.outputTokens})`,
  reasoningTokens: sql<number>`sum(coalesce(${table.reasoningTokens}, 0))`,
  totalTokens: sql<number>`sum(coalesce(${table.totalTokens}, coalesce(${table.inputTotalTokens}, ${table.inputTokens} + ${table.cacheReadTokens} + ${table.cacheWriteTokens}) + ${table.outputTokens}))`,
  cacheReadTokens: sql<number>`sum(${table.cacheReadTokens})`,
  cacheWriteTokens: sql<number>`sum(${table.cacheWriteTokens})`,
});

export const selectUsageLastRequestAtMax = (table: UsageBucketsTable) => ({
  lastRequestAt: sql<number>`max(${table.lastRequestAt})`,
});

export const selectUsageTotals = (table: UsageBucketsTable) => ({
  ...selectUsageCounterSums(table),
  ...selectUsageLatencySums(table),
  ...selectUsageTokenSums(table),
  ...selectUsageLastRequestAtMax(table),
});

export const usageDetailQueries = (
  database: Database,
  filter: SQL | undefined
) =>
  [
    database
      .select({
        provider: requestUsageBuckets.provider,
        endpoint: requestUsageBuckets.endpoint,
        ...selectUsageTotals(requestUsageBuckets),
      })
      .from(requestUsageBuckets)
      .where(filter)
      .groupBy(requestUsageBuckets.provider, requestUsageBuckets.endpoint),
    database
      .select({
        provider: requestUsageBuckets.provider,
        endpoint: requestUsageBuckets.endpoint,
        model: requestUsageBuckets.model,
        ...selectUsageTotals(requestUsageBuckets),
      })
      .from(requestUsageBuckets)
      .where(filter)
      .groupBy(
        requestUsageBuckets.provider,
        requestUsageBuckets.endpoint,
        requestUsageBuckets.model
      ),
    database
      .select({
        bucketStart: requestUsageBuckets.bucketStart,
        ...selectUsageCounterSums(requestUsageBuckets),
        ...selectUsageTokenSums(requestUsageBuckets),
      })
      .from(requestUsageBuckets)
      .where(filter)
      .groupBy(requestUsageBuckets.bucketStart)
      .orderBy(desc(requestUsageBuckets.bucketStart))
      .limit(DETAIL_BUCKET_LIMIT),
  ] as const;

export type UsageTotals = {
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
  proxyErrorCount: number;
  upstreamErrorCount: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  inputTokens: number;
  inputTotalTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  lastRequestAt: number | null;
};

export type AveragedUsageTotals = Omit<UsageTotals, "totalLatencyMs"> & {
  successRate: number | null;
  avgLatencyMs: number;
};

export const emptyUsageTotals = (): UsageTotals => ({
  requestCount: 0,
  successCount: 0,
  clientErrorCount: 0,
  serverErrorCount: 0,
  authErrorCount: 0,
  rateLimitCount: 0,
  proxyErrorCount: 0,
  upstreamErrorCount: 0,
  totalLatencyMs: 0,
  maxLatencyMs: 0,
  inputTokens: 0,
  inputTotalTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
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
  proxyErrorCount?: unknown;
  upstreamErrorCount?: unknown;
  totalLatencyMs: unknown;
  maxLatencyMs: unknown;
  inputTokens?: unknown;
  inputTotalTokens?: unknown;
  outputTokens?: unknown;
  reasoningTokens?: unknown;
  totalTokens?: unknown;
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
  target.proxyErrorCount += toNonNegativeInteger(row.proxyErrorCount);
  target.upstreamErrorCount += toNonNegativeInteger(row.upstreamErrorCount);
  target.totalLatencyMs += toNonNegativeInteger(row.totalLatencyMs);
  target.maxLatencyMs = Math.max(
    target.maxLatencyMs,
    toNonNegativeInteger(row.maxLatencyMs)
  );
  target.inputTokens += toNonNegativeInteger(row.inputTokens);
  target.inputTotalTokens += toNonNegativeInteger(row.inputTotalTokens);
  target.outputTokens += toNonNegativeInteger(row.outputTokens);
  target.reasoningTokens += toNonNegativeInteger(row.reasoningTokens);
  target.totalTokens += toNonNegativeInteger(row.totalTokens);
  target.cacheReadTokens += toNonNegativeInteger(row.cacheReadTokens);
  target.cacheWriteTokens += toNonNegativeInteger(row.cacheWriteTokens);
  target.lastRequestAt = maxTimestamp(target.lastRequestAt, row.lastRequestAt);
};

export const toAveragedTotals = (totals: UsageTotals): AveragedUsageTotals => ({
  requestCount: totals.requestCount,
  successCount: totals.successCount,
  successRate: calculateSuccessRate(totals),
  clientErrorCount: totals.clientErrorCount,
  serverErrorCount: totals.serverErrorCount,
  authErrorCount: totals.authErrorCount,
  rateLimitCount: totals.rateLimitCount,
  proxyErrorCount: totals.proxyErrorCount,
  upstreamErrorCount: totals.upstreamErrorCount,
  avgLatencyMs:
    totals.requestCount > 0
      ? Math.round(totals.totalLatencyMs / totals.requestCount)
      : 0,
  maxLatencyMs: totals.maxLatencyMs,
  inputTokens: totals.inputTokens,
  inputTotalTokens: totals.inputTotalTokens,
  outputTokens: totals.outputTokens,
  reasoningTokens: totals.reasoningTokens,
  totalTokens: totals.totalTokens,
  cacheReadTokens: totals.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens,
  lastRequestAt: totals.lastRequestAt,
});

export const averageUsageRow = (row?: UsageTotalsRow): AveragedUsageTotals => {
  const totals = emptyUsageTotals();
  if (row) applyTotalsRow(totals, row);
  return toAveragedTotals(totals);
};

export type UsageProviderSummary = Omit<
  UsageTotals,
  "totalLatencyMs" | "maxLatencyMs" | "lastRequestAt"
> & {
  provider: Provider;
};

type UsageProviderSummaryRow = Omit<
  UsageTotalsRow,
  "totalLatencyMs" | "maxLatencyMs" | "lastRequestAt"
> & {
  provider: string;
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
    proxyErrorCount: 0,
    upstreamErrorCount: 0,
    inputTokens: 0,
    inputTotalTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
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
  target.proxyErrorCount += toNonNegativeInteger(row.proxyErrorCount);
  target.upstreamErrorCount += toNonNegativeInteger(row.upstreamErrorCount);
  target.inputTokens += toNonNegativeInteger(row.inputTokens);
  target.inputTotalTokens += toNonNegativeInteger(row.inputTotalTokens);
  target.outputTokens += toNonNegativeInteger(row.outputTokens);
  target.reasoningTokens += toNonNegativeInteger(row.reasoningTokens);
  target.totalTokens += toNonNegativeInteger(row.totalTokens);
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

export type UsageEndpointBreakdown = Omit<
  AveragedUsageTotals,
  "successRate"
> & {
  provider: Provider;
  endpoint: string;
};

type UsageEndpointRow = UsageTotalsRow & {
  provider: string;
  endpoint: string;
};

const mapBreakdownTotals = (row: UsageTotalsRow) => {
  const { successRate: _, ...totals } = averageUsageRow(row);
  return {
    ...totals,
    lastRequestAt:
      row.lastRequestAt === null
        ? null
        : toNonNegativeInteger(row.lastRequestAt),
  };
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

    endpoints.push({
      provider,
      endpoint: row.endpoint,
      ...mapBreakdownTotals(row),
    });
  }

  endpoints.sort((left, right) => right.requestCount - left.requestCount);
  return endpoints;
};

export type UsageBucketRow = Omit<UsageProviderSummary, "provider"> & {
  bucketStart: number;
};

type UsageBucketSummaryRow = Omit<UsageProviderSummaryRow, "provider"> & {
  bucketStart: unknown;
};

export const mapUsageBucketRows = (
  rows: readonly UsageBucketSummaryRow[]
): UsageBucketRow[] =>
  rows
    .map((row): UsageBucketRow => ({
      bucketStart: toNonNegativeInteger(row.bucketStart),
      requestCount: toNonNegativeInteger(row.requestCount),
      successCount: toNonNegativeInteger(row.successCount),
      clientErrorCount: toNonNegativeInteger(row.clientErrorCount),
      serverErrorCount: toNonNegativeInteger(row.serverErrorCount),
      authErrorCount: toNonNegativeInteger(row.authErrorCount),
      rateLimitCount: toNonNegativeInteger(row.rateLimitCount),
      proxyErrorCount: toNonNegativeInteger(row.proxyErrorCount),
      upstreamErrorCount: toNonNegativeInteger(row.upstreamErrorCount),
      inputTokens: toNonNegativeInteger(row.inputTokens),
      inputTotalTokens: toNonNegativeInteger(row.inputTotalTokens),
      outputTokens: toNonNegativeInteger(row.outputTokens),
      reasoningTokens: toNonNegativeInteger(row.reasoningTokens),
      totalTokens: toNonNegativeInteger(row.totalTokens),
      cacheReadTokens: toNonNegativeInteger(row.cacheReadTokens),
      cacheWriteTokens: toNonNegativeInteger(row.cacheWriteTokens),
    }))
    .reverse();

export type UsageModelBreakdown = UsageEndpointBreakdown & {
  model: string;
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

    models.push({
      provider,
      endpoint: row.endpoint,
      model: row.model,
      ...mapBreakdownTotals(row),
    });
  }

  models.sort((left, right) => {
    const leftQuality =
      (left.model.trim().length > 0 ? 2 : 0) + (left.successCount > 0 ? 1 : 0);
    const rightQuality =
      (right.model.trim().length > 0 ? 2 : 0) +
      (right.successCount > 0 ? 1 : 0);
    return (
      rightQuality - leftQuality ||
      right.requestCount - left.requestCount ||
      right.outputTokens - left.outputTokens ||
      right.inputTokens - left.inputTokens ||
      (right.lastRequestAt ?? 0) - (left.lastRequestAt ?? 0)
    );
  });

  return models;
};
