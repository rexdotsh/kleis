import { and, eq, gte } from "drizzle-orm";

import { toNonNegativeInteger } from "../../utils/number";
import type { Database } from "../index";
import { providerAccounts, requestUsageBuckets } from "../schema";
import {
  averageUsageRow,
  mapEndpointUsageRows,
  mapModelUsageRows,
  mapUsageBucketRows,
  selectUsageCounterSums,
  selectUsageTokenSums,
  selectUsageTotals,
  summarizeGroupedUsageRows,
  toUsageBucketStart,
  usageDetailQueries,
  type AveragedUsageTotals,
  type UsageBucketRow,
  type UsageEndpointBreakdown,
  type UsageModelBreakdown,
  type UsageProviderSummary,
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
        ...selectUsageTotals(requestUsageBuckets),
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

type ProviderAccountUsageDetail = {
  providerAccountId: string;
  totals: AveragedUsageTotals;
  apiKeys: (AveragedUsageTotals & { apiKeyId: string })[];
  endpoints: UsageEndpointBreakdown[];
  models: UsageModelBreakdown[];
  buckets: UsageBucketRow[];
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
      .select(selectUsageTotals(requestUsageBuckets))
      .from(requestUsageBuckets)
      .where(windowFilter),
    database
      .select({
        apiKeyId: requestUsageBuckets.apiKeyId,
        ...selectUsageTotals(requestUsageBuckets),
      })
      .from(requestUsageBuckets)
      .where(windowFilter)
      .groupBy(requestUsageBuckets.apiKeyId),
    ...usageDetailQueries(database, windowFilter),
  ]);

  if (!accountRows.length) {
    return null;
  }

  const apiKeys = apiKeyRows
    .map((row) => ({
      apiKeyId: row.apiKeyId,
      ...averageUsageRow(row),
    }))
    .sort(
      (left, right) =>
        right.requestCount - left.requestCount ||
        (right.lastRequestAt ?? 0) - (left.lastRequestAt ?? 0)
    );

  return {
    providerAccountId,
    totals: averageUsageRow(totalsRows[0]),
    apiKeys,
    endpoints: mapEndpointUsageRows(endpointRows),
    models: mapModelUsageRows(modelRows),
    buckets: mapUsageBucketRows(bucketRows),
  };
};
