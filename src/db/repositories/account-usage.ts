import { and, desc, eq, gte } from "drizzle-orm";

import type { Database } from "../index";
import { requestUsageBuckets } from "../schema";
import {
  applyTotalsRow,
  DETAIL_BUCKET_LIMIT,
  emptyUsageTotals,
  mapEndpointUsageRows,
  mapModelUsageRows,
  mapUsageBucketRows,
  selectUsageCounterSums,
  selectUsageLastRequestAtMax,
  selectUsageLatencySums,
  selectUsageTokenSums,
  summarizeGroupedUsageRows,
  toAveragedTotals,
  toNonNegativeInteger,
  toUsageBucketStart,
  type UsageBucketRow,
  type UsageEndpointBreakdown,
  type UsageModelBreakdown,
  type UsageProviderSummary,
  type UsageTotals,
} from "./usage-shared";

type ProviderAccountUsageSummary = {
  providerAccountId: string;
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
  providers: UsageProviderSummary[];
};

export const listProviderAccountUsageSummaries = async (
  database: Database,
  sinceMs: number
): Promise<ProviderAccountUsageSummary[]> => {
  const sinceBucket = toUsageBucketStart(toNonNegativeInteger(sinceMs));

  const [totalsRows, providerRows] = await Promise.all([
    database
      .select({
        groupKey: requestUsageBuckets.providerAccountId,
        ...selectUsageCounterSums(requestUsageBuckets),
        ...selectUsageLatencySums(requestUsageBuckets),
        ...selectUsageTokenSums(requestUsageBuckets),
        ...selectUsageLastRequestAtMax(requestUsageBuckets),
      })
      .from(requestUsageBuckets)
      .where(gte(requestUsageBuckets.bucketStart, sinceBucket))
      .groupBy(requestUsageBuckets.providerAccountId),
    database
      .select({
        groupKey: requestUsageBuckets.providerAccountId,
        provider: requestUsageBuckets.provider,
        ...selectUsageCounterSums(requestUsageBuckets),
        ...selectUsageTokenSums(requestUsageBuckets),
      })
      .from(requestUsageBuckets)
      .where(gte(requestUsageBuckets.bucketStart, sinceBucket))
      .groupBy(
        requestUsageBuckets.providerAccountId,
        requestUsageBuckets.provider
      ),
  ]);

  return summarizeGroupedUsageRows({
    totalsRows,
    providerRows,
  }).map((summary) => ({
    providerAccountId: summary.groupKey,
    ...summary.totals,
    providers: summary.providers,
  }));
};

type ProviderAccountUsageApiKeyBreakdown = {
  apiKeyId: string;
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

type ProviderAccountUsageEndpointBreakdown = UsageEndpointBreakdown;

type ProviderAccountUsageModelBreakdown = UsageModelBreakdown;

type ProviderAccountUsageBucketRow = UsageBucketRow;

type ProviderAccountUsageDetail = {
  providerAccountId: string;
  totals: Omit<ProviderAccountUsageSummary, "providerAccountId" | "providers">;
  apiKeys: ProviderAccountUsageApiKeyBreakdown[];
  endpoints: ProviderAccountUsageEndpointBreakdown[];
  models: ProviderAccountUsageModelBreakdown[];
  buckets: ProviderAccountUsageBucketRow[];
};

type MutableApiKeyTotals = {
  apiKeyId: string;
  totals: UsageTotals;
};

export const getProviderAccountUsageDetail = async (
  database: Database,
  providerAccountId: string,
  sinceMs: number
): Promise<ProviderAccountUsageDetail> => {
  const sinceBucket = toUsageBucketStart(toNonNegativeInteger(sinceMs));
  const windowFilter = and(
    eq(requestUsageBuckets.providerAccountId, providerAccountId),
    gte(requestUsageBuckets.bucketStart, sinceBucket)
  );

  const [totalsRows, apiKeyRows, endpointRows, modelRows, bucketRows] =
    await Promise.all([
      database
        .select({
          ...selectUsageCounterSums(requestUsageBuckets),
          ...selectUsageLatencySums(requestUsageBuckets),
          ...selectUsageTokenSums(requestUsageBuckets),
          ...selectUsageLastRequestAtMax(requestUsageBuckets),
        })
        .from(requestUsageBuckets)
        .where(windowFilter),
      database
        .select({
          apiKeyId: requestUsageBuckets.apiKeyId,
          ...selectUsageCounterSums(requestUsageBuckets),
          ...selectUsageLatencySums(requestUsageBuckets),
          ...selectUsageTokenSums(requestUsageBuckets),
          ...selectUsageLastRequestAtMax(requestUsageBuckets),
        })
        .from(requestUsageBuckets)
        .where(windowFilter)
        .groupBy(requestUsageBuckets.apiKeyId),
      database
        .select({
          provider: requestUsageBuckets.provider,
          endpoint: requestUsageBuckets.endpoint,
          ...selectUsageCounterSums(requestUsageBuckets),
          ...selectUsageLatencySums(requestUsageBuckets),
          ...selectUsageTokenSums(requestUsageBuckets),
          ...selectUsageLastRequestAtMax(requestUsageBuckets),
        })
        .from(requestUsageBuckets)
        .where(windowFilter)
        .groupBy(requestUsageBuckets.provider, requestUsageBuckets.endpoint),
      database
        .select({
          provider: requestUsageBuckets.provider,
          endpoint: requestUsageBuckets.endpoint,
          model: requestUsageBuckets.model,
          ...selectUsageCounterSums(requestUsageBuckets),
          ...selectUsageLatencySums(requestUsageBuckets),
          ...selectUsageTokenSums(requestUsageBuckets),
          ...selectUsageLastRequestAtMax(requestUsageBuckets),
        })
        .from(requestUsageBuckets)
        .where(windowFilter)
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
        .where(windowFilter)
        .groupBy(requestUsageBuckets.bucketStart)
        .orderBy(desc(requestUsageBuckets.bucketStart))
        .limit(DETAIL_BUCKET_LIMIT),
    ]);

  const totals = emptyUsageTotals();
  const totalsRow = totalsRows[0];
  if (totalsRow) {
    applyTotalsRow(totals, totalsRow);
  }

  const mutableApiKeys: MutableApiKeyTotals[] = [];
  for (const row of apiKeyRows) {
    const apiKeyTotals: MutableApiKeyTotals = {
      apiKeyId: row.apiKeyId,
      totals: emptyUsageTotals(),
    };
    applyTotalsRow(apiKeyTotals.totals, row);
    mutableApiKeys.push(apiKeyTotals);
  }

  const apiKeys = mutableApiKeys
    .map((entry): ProviderAccountUsageApiKeyBreakdown => {
      const averaged = toAveragedTotals(entry.totals);
      return {
        apiKeyId: entry.apiKeyId,
        requestCount: averaged.requestCount,
        successCount: averaged.successCount,
        clientErrorCount: averaged.clientErrorCount,
        serverErrorCount: averaged.serverErrorCount,
        authErrorCount: averaged.authErrorCount,
        rateLimitCount: averaged.rateLimitCount,
        avgLatencyMs: averaged.avgLatencyMs,
        maxLatencyMs: averaged.maxLatencyMs,
        inputTokens: averaged.inputTokens,
        outputTokens: averaged.outputTokens,
        cacheReadTokens: averaged.cacheReadTokens,
        cacheWriteTokens: averaged.cacheWriteTokens,
        lastRequestAt: averaged.lastRequestAt,
      };
    })
    .sort(
      (left, right) =>
        right.requestCount - left.requestCount ||
        (right.lastRequestAt ?? 0) - (left.lastRequestAt ?? 0)
    );

  const endpoints: ProviderAccountUsageEndpointBreakdown[] =
    mapEndpointUsageRows(endpointRows);

  const models: ProviderAccountUsageModelBreakdown[] =
    mapModelUsageRows(modelRows);

  const buckets: ProviderAccountUsageBucketRow[] =
    mapUsageBucketRows(bucketRows);

  return {
    providerAccountId,
    totals: toAveragedTotals(totals),
    apiKeys,
    endpoints,
    models,
    buckets,
  };
};
