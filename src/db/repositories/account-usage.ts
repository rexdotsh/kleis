import { and, desc, eq, gte, sql } from "drizzle-orm";

import type { Database } from "../index";
import { requestUsageBuckets } from "../schema";
import {
  applyTotalsRow,
  DETAIL_BUCKET_LIMIT,
  emptyUsageTotals,
  mapEndpointUsageRows,
  mapUsageBucketRows,
  summarizeGroupedUsageRows,
  toAveragedTotals,
  toNonNegativeInteger,
  toUsageBucketStart,
  type UsageBucketRow,
  type UsageEndpointBreakdown,
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
        requestCount: sql<number>`sum(${requestUsageBuckets.requestCount})`,
        successCount: sql<number>`sum(${requestUsageBuckets.successCount})`,
        clientErrorCount: sql<number>`sum(${requestUsageBuckets.clientErrorCount})`,
        serverErrorCount: sql<number>`sum(${requestUsageBuckets.serverErrorCount})`,
        authErrorCount: sql<number>`sum(${requestUsageBuckets.authErrorCount})`,
        rateLimitCount: sql<number>`sum(${requestUsageBuckets.rateLimitCount})`,
        totalLatencyMs: sql<number>`sum(${requestUsageBuckets.totalLatencyMs})`,
        maxLatencyMs: sql<number>`max(${requestUsageBuckets.maxLatencyMs})`,
        lastRequestAt: sql<number>`max(${requestUsageBuckets.lastRequestAt})`,
      })
      .from(requestUsageBuckets)
      .where(gte(requestUsageBuckets.bucketStart, sinceBucket))
      .groupBy(requestUsageBuckets.providerAccountId),
    database
      .select({
        groupKey: requestUsageBuckets.providerAccountId,
        provider: requestUsageBuckets.provider,
        requestCount: sql<number>`sum(${requestUsageBuckets.requestCount})`,
        successCount: sql<number>`sum(${requestUsageBuckets.successCount})`,
        clientErrorCount: sql<number>`sum(${requestUsageBuckets.clientErrorCount})`,
        serverErrorCount: sql<number>`sum(${requestUsageBuckets.serverErrorCount})`,
        authErrorCount: sql<number>`sum(${requestUsageBuckets.authErrorCount})`,
        rateLimitCount: sql<number>`sum(${requestUsageBuckets.rateLimitCount})`,
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
  lastRequestAt: number | null;
};

type ProviderAccountUsageEndpointBreakdown = UsageEndpointBreakdown;

type ProviderAccountUsageBucketRow = UsageBucketRow;

type ProviderAccountUsageDetail = {
  providerAccountId: string;
  totals: Omit<ProviderAccountUsageSummary, "providerAccountId" | "providers">;
  apiKeys: ProviderAccountUsageApiKeyBreakdown[];
  endpoints: ProviderAccountUsageEndpointBreakdown[];
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

  const [totalsRows, apiKeyRows, endpointRows, bucketRows] = await Promise.all([
    database
      .select({
        requestCount: sql<number>`sum(${requestUsageBuckets.requestCount})`,
        successCount: sql<number>`sum(${requestUsageBuckets.successCount})`,
        clientErrorCount: sql<number>`sum(${requestUsageBuckets.clientErrorCount})`,
        serverErrorCount: sql<number>`sum(${requestUsageBuckets.serverErrorCount})`,
        authErrorCount: sql<number>`sum(${requestUsageBuckets.authErrorCount})`,
        rateLimitCount: sql<number>`sum(${requestUsageBuckets.rateLimitCount})`,
        totalLatencyMs: sql<number>`sum(${requestUsageBuckets.totalLatencyMs})`,
        maxLatencyMs: sql<number>`max(${requestUsageBuckets.maxLatencyMs})`,
        lastRequestAt: sql<number>`max(${requestUsageBuckets.lastRequestAt})`,
      })
      .from(requestUsageBuckets)
      .where(windowFilter),
    database
      .select({
        apiKeyId: requestUsageBuckets.apiKeyId,
        requestCount: sql<number>`sum(${requestUsageBuckets.requestCount})`,
        successCount: sql<number>`sum(${requestUsageBuckets.successCount})`,
        clientErrorCount: sql<number>`sum(${requestUsageBuckets.clientErrorCount})`,
        serverErrorCount: sql<number>`sum(${requestUsageBuckets.serverErrorCount})`,
        authErrorCount: sql<number>`sum(${requestUsageBuckets.authErrorCount})`,
        rateLimitCount: sql<number>`sum(${requestUsageBuckets.rateLimitCount})`,
        totalLatencyMs: sql<number>`sum(${requestUsageBuckets.totalLatencyMs})`,
        maxLatencyMs: sql<number>`max(${requestUsageBuckets.maxLatencyMs})`,
        lastRequestAt: sql<number>`max(${requestUsageBuckets.lastRequestAt})`,
      })
      .from(requestUsageBuckets)
      .where(windowFilter)
      .groupBy(requestUsageBuckets.apiKeyId),
    database
      .select({
        provider: requestUsageBuckets.provider,
        endpoint: requestUsageBuckets.endpoint,
        requestCount: sql<number>`sum(${requestUsageBuckets.requestCount})`,
        successCount: sql<number>`sum(${requestUsageBuckets.successCount})`,
        clientErrorCount: sql<number>`sum(${requestUsageBuckets.clientErrorCount})`,
        serverErrorCount: sql<number>`sum(${requestUsageBuckets.serverErrorCount})`,
        authErrorCount: sql<number>`sum(${requestUsageBuckets.authErrorCount})`,
        rateLimitCount: sql<number>`sum(${requestUsageBuckets.rateLimitCount})`,
        totalLatencyMs: sql<number>`sum(${requestUsageBuckets.totalLatencyMs})`,
        maxLatencyMs: sql<number>`max(${requestUsageBuckets.maxLatencyMs})`,
        lastRequestAt: sql<number>`max(${requestUsageBuckets.lastRequestAt})`,
      })
      .from(requestUsageBuckets)
      .where(windowFilter)
      .groupBy(requestUsageBuckets.provider, requestUsageBuckets.endpoint),
    database
      .select({
        bucketStart: requestUsageBuckets.bucketStart,
        requestCount: sql<number>`sum(${requestUsageBuckets.requestCount})`,
        successCount: sql<number>`sum(${requestUsageBuckets.successCount})`,
        clientErrorCount: sql<number>`sum(${requestUsageBuckets.clientErrorCount})`,
        serverErrorCount: sql<number>`sum(${requestUsageBuckets.serverErrorCount})`,
        authErrorCount: sql<number>`sum(${requestUsageBuckets.authErrorCount})`,
        rateLimitCount: sql<number>`sum(${requestUsageBuckets.rateLimitCount})`,
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

  const buckets: ProviderAccountUsageBucketRow[] =
    mapUsageBucketRows(bucketRows);

  return {
    providerAccountId,
    totals: toAveragedTotals(totals),
    apiKeys,
    endpoints,
    buckets,
  };
};
