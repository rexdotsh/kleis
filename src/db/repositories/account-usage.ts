import { and, desc, eq, gte } from "drizzle-orm";

import { toNonNegativeInteger } from "../../utils/number";
import type { Database } from "../index";
import { providerAccounts, requestUsageBuckets } from "../schema";
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
  toUsageBucketStart,
  type AveragedUsageTotals,
  type UsageBucketRow,
  type UsageEndpointBreakdown,
  type UsageModelBreakdown,
  type UsageProviderSummary,
  type UsageTotals,
} from "./usage-shared";

type ProviderAccountUsageSummary = AveragedUsageTotals & {
  providerAccountId: string;
  providers: UsageProviderSummary[];
};

export const listProviderAccountUsageSummaries = async (
  database: Database,
  sinceMs: number
): Promise<ProviderAccountUsageSummary[]> => {
  const sinceBucket = toUsageBucketStart(toNonNegativeInteger(sinceMs));

  const [totalsRows, providerRows] = await database.batch([
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

type ProviderAccountUsageApiKeyBreakdown = AveragedUsageTotals & {
  apiKeyId: string;
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
): Promise<ProviderAccountUsageDetail | null> => {
  const sinceBucket = toUsageBucketStart(toNonNegativeInteger(sinceMs));
  const windowFilter = and(
    eq(requestUsageBuckets.providerAccountId, providerAccountId),
    gte(requestUsageBuckets.bucketStart, sinceBucket)
  );

  const [
    accountRows,
    totalsRows,
    apiKeyRows,
    endpointRows,
    modelRows,
    bucketRows,
  ] = await database.batch([
    database
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, providerAccountId))
      .limit(1),
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

  if (!accountRows.length) {
    return null;
  }

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
    .map(
      (entry): ProviderAccountUsageApiKeyBreakdown => ({
        apiKeyId: entry.apiKeyId,
        ...toAveragedTotals(entry.totals),
      })
    )
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
