import { and, desc, eq, gte, sql } from "drizzle-orm";

import type { ProxyEndpoint } from "../../providers/proxy-endpoints";
import type { Database } from "../index";
import { requestUsageBuckets, type Provider } from "../schema";
import {
  applyTotalsRow,
  DETAIL_BUCKET_LIMIT,
  emptyUsageTotals,
  parseProvider,
  toAveragedTotals,
  toNonNegativeInteger,
  toUsageBucketStart,
  type UsageTotals,
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

type ApiKeyUsageProviderSummary = {
  provider: Provider;
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
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
  providers: ApiKeyUsageProviderSummary[];
};

type MutableApiKeyUsageSummary = {
  apiKeyId: string;
  totals: UsageTotals;
  providers: Map<Provider, ApiKeyUsageProviderSummary>;
};

const summarySort = (left: ApiKeyUsageSummary, right: ApiKeyUsageSummary) => {
  if (right.requestCount !== left.requestCount) {
    return right.requestCount - left.requestCount;
  }

  return (right.lastRequestAt ?? 0) - (left.lastRequestAt ?? 0);
};

const ensureSummary = (
  summariesByKey: Map<string, MutableApiKeyUsageSummary>,
  apiKeyId: string
): MutableApiKeyUsageSummary => {
  const existing = summariesByKey.get(apiKeyId);
  if (existing) {
    return existing;
  }

  const created: MutableApiKeyUsageSummary = {
    apiKeyId,
    totals: emptyUsageTotals(),
    providers: new Map(),
  };
  summariesByKey.set(apiKeyId, created);
  return created;
};

const ensureProviderSummary = (
  providersByName: Map<Provider, ApiKeyUsageProviderSummary>,
  provider: Provider
): ApiKeyUsageProviderSummary => {
  const existing = providersByName.get(provider);
  if (existing) {
    return existing;
  }

  const created: ApiKeyUsageProviderSummary = {
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

export const listApiKeyUsageSummaries = async (
  database: Database,
  sinceMs: number
): Promise<ApiKeyUsageSummary[]> => {
  const sinceBucket = toUsageBucketStart(toNonNegativeInteger(sinceMs));

  const [totalsRows, providerRows] = await Promise.all([
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
      .where(gte(requestUsageBuckets.bucketStart, sinceBucket))
      .groupBy(requestUsageBuckets.apiKeyId),
    database
      .select({
        apiKeyId: requestUsageBuckets.apiKeyId,
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

  const summariesByKey = new Map<string, MutableApiKeyUsageSummary>();
  for (const row of totalsRows) {
    const summary = ensureSummary(summariesByKey, row.apiKeyId);
    applyTotalsRow(summary.totals, row);
  }

  for (const row of providerRows) {
    const provider = parseProvider(row.provider);
    if (!provider) {
      continue;
    }

    const summary = ensureSummary(summariesByKey, row.apiKeyId);
    const providerSummary = ensureProviderSummary(summary.providers, provider);
    providerSummary.requestCount += toNonNegativeInteger(row.requestCount);
    providerSummary.successCount += toNonNegativeInteger(row.successCount);
    providerSummary.clientErrorCount += toNonNegativeInteger(
      row.clientErrorCount
    );
    providerSummary.serverErrorCount += toNonNegativeInteger(
      row.serverErrorCount
    );
    providerSummary.authErrorCount += toNonNegativeInteger(row.authErrorCount);
    providerSummary.rateLimitCount += toNonNegativeInteger(row.rateLimitCount);
  }

  const summaries: ApiKeyUsageSummary[] = [];
  for (const summary of summariesByKey.values()) {
    const totals = toAveragedTotals(summary.totals);
    const providers = Array.from(summary.providers.values()).sort(
      (left, right) => right.requestCount - left.requestCount
    );

    summaries.push({
      apiKeyId: summary.apiKeyId,
      requestCount: totals.requestCount,
      successCount: totals.successCount,
      clientErrorCount: totals.clientErrorCount,
      serverErrorCount: totals.serverErrorCount,
      authErrorCount: totals.authErrorCount,
      rateLimitCount: totals.rateLimitCount,
      avgLatencyMs: totals.avgLatencyMs,
      maxLatencyMs: totals.maxLatencyMs,
      lastRequestAt: totals.lastRequestAt,
      providers,
    });
  }

  return summaries.sort(summarySort);
};

type ApiKeyUsageEndpointBreakdown = {
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

type ApiKeyUsageBucketRow = {
  bucketStart: number;
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
};

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

  const endpoints: ApiKeyUsageEndpointBreakdown[] = [];
  for (const row of endpointRows) {
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

  const buckets = bucketRows
    .map(
      (row): ApiKeyUsageBucketRow => ({
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

  return {
    apiKeyId,
    totals: toAveragedTotals(totals),
    endpoints,
    buckets,
  };
};
