import { and, desc, eq, gte, sql } from "drizzle-orm";

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

type ProviderAccountUsageProviderSummary = {
  provider: Provider;
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
};

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
  providers: ProviderAccountUsageProviderSummary[];
};

type MutableProviderAccountUsageSummary = {
  providerAccountId: string;
  totals: UsageTotals;
  providers: Map<Provider, ProviderAccountUsageProviderSummary>;
};

const ensureSummary = (
  summariesByAccount: Map<string, MutableProviderAccountUsageSummary>,
  providerAccountId: string
): MutableProviderAccountUsageSummary => {
  const existing = summariesByAccount.get(providerAccountId);
  if (existing) {
    return existing;
  }

  const created: MutableProviderAccountUsageSummary = {
    providerAccountId,
    totals: emptyUsageTotals(),
    providers: new Map(),
  };
  summariesByAccount.set(providerAccountId, created);
  return created;
};

const ensureProviderSummary = (
  providersByName: Map<Provider, ProviderAccountUsageProviderSummary>,
  provider: Provider
): ProviderAccountUsageProviderSummary => {
  const existing = providersByName.get(provider);
  if (existing) {
    return existing;
  }

  const created: ProviderAccountUsageProviderSummary = {
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

export const listProviderAccountUsageSummaries = async (
  database: Database,
  sinceMs: number
): Promise<ProviderAccountUsageSummary[]> => {
  const sinceBucket = toUsageBucketStart(toNonNegativeInteger(sinceMs));

  const [totalsRows, providerRows] = await Promise.all([
    database
      .select({
        providerAccountId: requestUsageBuckets.providerAccountId,
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
        providerAccountId: requestUsageBuckets.providerAccountId,
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

  const summariesByAccount = new Map<
    string,
    MutableProviderAccountUsageSummary
  >();
  for (const row of totalsRows) {
    const summary = ensureSummary(summariesByAccount, row.providerAccountId);
    applyTotalsRow(summary.totals, row);
  }

  for (const row of providerRows) {
    const provider = parseProvider(row.provider);
    if (!provider) {
      continue;
    }

    const summary = ensureSummary(summariesByAccount, row.providerAccountId);
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

  const summaries: ProviderAccountUsageSummary[] = [];
  for (const summary of summariesByAccount.values()) {
    const totals = toAveragedTotals(summary.totals);
    const providers = Array.from(summary.providers.values()).sort(
      (left, right) => right.requestCount - left.requestCount
    );

    summaries.push({
      providerAccountId: summary.providerAccountId,
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

  summaries.sort(
    (left, right) =>
      right.requestCount - left.requestCount ||
      (right.lastRequestAt ?? 0) - (left.lastRequestAt ?? 0)
  );
  return summaries;
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

type ProviderAccountUsageEndpointBreakdown = {
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

type ProviderAccountUsageBucketRow = {
  bucketStart: number;
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
};

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

  const endpoints: ProviderAccountUsageEndpointBreakdown[] = [];
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
      (bucket): ProviderAccountUsageBucketRow => ({
        bucketStart: toNonNegativeInteger(bucket.bucketStart),
        requestCount: toNonNegativeInteger(bucket.requestCount),
        successCount: toNonNegativeInteger(bucket.successCount),
        clientErrorCount: toNonNegativeInteger(bucket.clientErrorCount),
        serverErrorCount: toNonNegativeInteger(bucket.serverErrorCount),
        authErrorCount: toNonNegativeInteger(bucket.authErrorCount),
        rateLimitCount: toNonNegativeInteger(bucket.rateLimitCount),
      })
    )
    .reverse();

  return {
    providerAccountId,
    totals: toAveragedTotals(totals),
    apiKeys,
    endpoints,
    buckets,
  };
};
