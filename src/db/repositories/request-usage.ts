import { and, desc, eq, gte, sql } from "drizzle-orm";

import type { ProxyEndpoint } from "../../providers/proxy-endpoints";
import type { Database } from "../index";
import { requestUsageBuckets, type Provider } from "../schema";
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
} from "./usage-shared";

export const MISSING_PROVIDER_ACCOUNT_ID = "__missing__";

const statusCounters = (
  statusCode: number
): {
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
} => {
  const successCount = statusCode >= 200 && statusCode < 400 ? 1 : 0;
  const clientErrorCount = statusCode >= 400 && statusCode < 500 ? 1 : 0;
  const serverErrorCount = statusCode >= 500 ? 1 : 0;

  return {
    successCount,
    clientErrorCount,
    serverErrorCount,
    authErrorCount: statusCode === 401 || statusCode === 403 ? 1 : 0,
    rateLimitCount: statusCode === 429 ? 1 : 0,
  };
};

type RecordRequestUsageInput = {
  apiKeyId: string;
  providerAccountId: string;
  provider: Provider;
  endpoint: ProxyEndpoint;
  statusCode: number;
  durationMs: number;
  occurredAt: number;
};

export const recordRequestUsage = async (
  database: Database,
  input: RecordRequestUsageInput
): Promise<void> => {
  const occurredAt = toNonNegativeInteger(input.occurredAt);
  const durationMs = toNonNegativeInteger(input.durationMs);
  const counters = statusCounters(input.statusCode);

  const row: typeof requestUsageBuckets.$inferInsert = {
    bucketStart: toUsageBucketStart(occurredAt),
    apiKeyId: input.apiKeyId,
    providerAccountId: input.providerAccountId,
    provider: input.provider,
    endpoint: input.endpoint,
    requestCount: 1,
    successCount: counters.successCount,
    clientErrorCount: counters.clientErrorCount,
    serverErrorCount: counters.serverErrorCount,
    authErrorCount: counters.authErrorCount,
    rateLimitCount: counters.rateLimitCount,
    totalLatencyMs: durationMs,
    maxLatencyMs: durationMs,
    lastRequestAt: occurredAt,
  };

  await database
    .insert(requestUsageBuckets)
    .values(row)
    .onConflictDoUpdate({
      target: [
        requestUsageBuckets.bucketStart,
        requestUsageBuckets.apiKeyId,
        requestUsageBuckets.providerAccountId,
        requestUsageBuckets.provider,
        requestUsageBuckets.endpoint,
      ],
      set: {
        requestCount: sql`${requestUsageBuckets.requestCount} + 1`,
        successCount: sql`${requestUsageBuckets.successCount} + ${row.successCount}`,
        clientErrorCount: sql`${requestUsageBuckets.clientErrorCount} + ${row.clientErrorCount}`,
        serverErrorCount: sql`${requestUsageBuckets.serverErrorCount} + ${row.serverErrorCount}`,
        authErrorCount: sql`${requestUsageBuckets.authErrorCount} + ${row.authErrorCount}`,
        rateLimitCount: sql`${requestUsageBuckets.rateLimitCount} + ${row.rateLimitCount}`,
        totalLatencyMs: sql`${requestUsageBuckets.totalLatencyMs} + ${row.totalLatencyMs}`,
        maxLatencyMs: sql`max(${requestUsageBuckets.maxLatencyMs}, ${row.maxLatencyMs})`,
        lastRequestAt: sql`max(${requestUsageBuckets.lastRequestAt}, ${row.lastRequestAt})`,
      },
    });
};

type ApiKeyUsageSummary = {
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
  providers: UsageProviderSummary[];
};

export const listApiKeyUsageSummaries = async (
  database: Database,
  sinceMs: number
): Promise<ApiKeyUsageSummary[]> => {
  const sinceBucket = toUsageBucketStart(toNonNegativeInteger(sinceMs));

  const [totalsRows, providerRows] = await Promise.all([
    database
      .select({
        groupKey: requestUsageBuckets.apiKeyId,
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
      .groupBy(requestUsageBuckets.apiKeyId),
    database
      .select({
        groupKey: requestUsageBuckets.apiKeyId,
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
      .groupBy(requestUsageBuckets.apiKeyId, requestUsageBuckets.provider),
  ]);

  return summarizeGroupedUsageRows({
    totalsRows,
    providerRows,
  }).map((summary) => ({
    apiKeyId: summary.groupKey,
    ...summary.totals,
    providers: summary.providers,
  }));
};

type ApiKeyUsageEndpointBreakdown = UsageEndpointBreakdown;

type ApiKeyUsageBucketRow = UsageBucketRow;

type ApiKeyUsageDetail = {
  apiKeyId: string;
  totals: Omit<ApiKeyUsageSummary, "apiKeyId" | "providers">;
  endpoints: ApiKeyUsageEndpointBreakdown[];
  buckets: ApiKeyUsageBucketRow[];
};

export const getApiKeyUsageDetail = async (
  database: Database,
  apiKeyId: string,
  sinceMs: number
): Promise<ApiKeyUsageDetail> => {
  const sinceBucket = toUsageBucketStart(toNonNegativeInteger(sinceMs));
  const windowFilter = and(
    eq(requestUsageBuckets.apiKeyId, apiKeyId),
    gte(requestUsageBuckets.bucketStart, sinceBucket)
  );

  const [totalsRows, endpointRows, bucketRows] = await Promise.all([
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

  const endpoints: ApiKeyUsageEndpointBreakdown[] =
    mapEndpointUsageRows(endpointRows);

  const buckets: ApiKeyUsageBucketRow[] = mapUsageBucketRows(bucketRows);

  return {
    apiKeyId,
    totals: toAveragedTotals(totals),
    endpoints,
    buckets,
  };
};
