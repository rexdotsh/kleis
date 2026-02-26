import { and, desc, gte, lt, sql } from "drizzle-orm";

import type { Database } from "../index";
import { requestUsageBuckets } from "../schema";
import {
  applyTotalsRow,
  emptyUsageTotals,
  mapEndpointUsageRows,
  mapModelUsageRows,
  mapUsageBucketRows,
  selectUsageCounterSums,
  selectUsageLastRequestAtMax,
  selectUsageLatencySums,
  selectUsageTokenSums,
  toAveragedTotals,
  toNonNegativeInteger,
  toUsageBucketStart,
} from "./usage-shared";

const computeBucketSizeMs = (windowMs: number): number => {
  if (windowMs <= 3_600_000) return 60_000;
  if (windowMs <= 21_600_000) return 300_000;
  if (windowMs <= 86_400_000) return 900_000;
  if (windowMs <= 604_800_000) return 3_600_000;
  return 14_400_000;
};

const DASHBOARD_BUCKET_LIMIT = 200;

export const getDashboardUsage = async (
  database: Database,
  sinceMs: number,
  windowMs: number
) => {
  const sinceBucket = toUsageBucketStart(toNonNegativeInteger(sinceMs));
  const previousSinceBucket = toUsageBucketStart(
    toNonNegativeInteger(sinceMs - windowMs)
  );
  const bucketSizeMs = computeBucketSizeMs(windowMs);
  const aggregatedBucket = sql<number>`(${requestUsageBuckets.bucketStart} / ${bucketSizeMs}) * ${bucketSizeMs}`;

  const currentFilter = gte(requestUsageBuckets.bucketStart, sinceBucket);
  const previousFilter = and(
    gte(requestUsageBuckets.bucketStart, previousSinceBucket),
    lt(requestUsageBuckets.bucketStart, sinceBucket)
  );

  const fullSelect = {
    ...selectUsageCounterSums(requestUsageBuckets),
    ...selectUsageLatencySums(requestUsageBuckets),
    ...selectUsageTokenSums(requestUsageBuckets),
    ...selectUsageLastRequestAtMax(requestUsageBuckets),
  };

  const [
    totalsRows,
    previousTotalsRows,
    providerRows,
    endpointRows,
    modelRows,
    keyRows,
    bucketRows,
  ] = await Promise.all([
    database.select(fullSelect).from(requestUsageBuckets).where(currentFilter),
    database.select(fullSelect).from(requestUsageBuckets).where(previousFilter),
    database
      .select({
        provider: requestUsageBuckets.provider,
        ...fullSelect,
      })
      .from(requestUsageBuckets)
      .where(currentFilter)
      .groupBy(requestUsageBuckets.provider),
    database
      .select({
        provider: requestUsageBuckets.provider,
        endpoint: requestUsageBuckets.endpoint,
        ...fullSelect,
      })
      .from(requestUsageBuckets)
      .where(currentFilter)
      .groupBy(requestUsageBuckets.provider, requestUsageBuckets.endpoint),
    database
      .select({
        provider: requestUsageBuckets.provider,
        endpoint: requestUsageBuckets.endpoint,
        model: requestUsageBuckets.model,
        ...fullSelect,
      })
      .from(requestUsageBuckets)
      .where(currentFilter)
      .groupBy(
        requestUsageBuckets.provider,
        requestUsageBuckets.endpoint,
        requestUsageBuckets.model
      ),
    database
      .select({
        apiKeyId: requestUsageBuckets.apiKeyId,
        ...fullSelect,
      })
      .from(requestUsageBuckets)
      .where(currentFilter)
      .groupBy(requestUsageBuckets.apiKeyId),
    database
      .select({
        bucketStart: aggregatedBucket,
        ...selectUsageCounterSums(requestUsageBuckets),
        ...selectUsageTokenSums(requestUsageBuckets),
      })
      .from(requestUsageBuckets)
      .where(currentFilter)
      .groupBy(aggregatedBucket)
      .orderBy(desc(aggregatedBucket))
      .limit(DASHBOARD_BUCKET_LIMIT),
  ]);

  const totals = emptyUsageTotals();
  if (totalsRows[0]) applyTotalsRow(totals, totalsRows[0]);

  const previousTotals = emptyUsageTotals();
  if (previousTotalsRows[0])
    applyTotalsRow(previousTotals, previousTotalsRows[0]);

  const rowToAveraged = (row: Parameters<typeof applyTotalsRow>[1]) => {
    const t = emptyUsageTotals();
    applyTotalsRow(t, row);
    return toAveragedTotals(t);
  };

  const byProvider = providerRows
    .map((row) => ({ provider: row.provider, ...rowToAveraged(row) }))
    .sort((a, b) => b.requestCount - a.requestCount);

  const byKey = keyRows
    .map((row) => ({ apiKeyId: row.apiKeyId, ...rowToAveraged(row) }))
    .sort(
      (a, b) =>
        b.requestCount - a.requestCount ||
        (b.lastRequestAt ?? 0) - (a.lastRequestAt ?? 0)
    );

  return {
    totals: toAveragedTotals(totals),
    previousTotals: toAveragedTotals(previousTotals),
    byProvider,
    byEndpoint: mapEndpointUsageRows(endpointRows),
    byModel: mapModelUsageRows(modelRows),
    byKey,
    buckets: mapUsageBucketRows(bucketRows),
    bucketSizeMs,
  };
};
