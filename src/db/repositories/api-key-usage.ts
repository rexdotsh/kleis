import { gte, sql } from "drizzle-orm";

import type { Database } from "../client";
import { apiKeyUsageBuckets, providers, type Provider } from "../schema";

type UsageEndpoint = "chat_completions" | "responses" | "messages";

const USAGE_BUCKET_MS = 60_000;

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

const toNonNegativeInteger = (value: unknown): number =>
  Math.max(0, toInteger(value));

const toUsageBucketStart = (timestampMs: number): number =>
  timestampMs - (timestampMs % USAGE_BUCKET_MS);

const statusCounters = (
  statusCode: number
): {
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
} => {
  if (statusCode >= 200 && statusCode < 400) {
    return {
      successCount: 1,
      clientErrorCount: 0,
      serverErrorCount: 0,
    };
  }

  if (statusCode >= 400 && statusCode < 500) {
    return {
      successCount: 0,
      clientErrorCount: 1,
      serverErrorCount: 0,
    };
  }

  return {
    successCount: 0,
    clientErrorCount: 0,
    serverErrorCount: 1,
  };
};

type RecordApiKeyUsageInput = {
  apiKeyId: string;
  provider: Provider;
  endpoint: UsageEndpoint;
  statusCode: number;
  durationMs: number;
  occurredAt: number;
};

export const recordApiKeyUsage = async (
  database: Database,
  input: RecordApiKeyUsageInput
): Promise<void> => {
  const occurredAt = toNonNegativeInteger(input.occurredAt);
  const durationMs = toNonNegativeInteger(input.durationMs);
  const statusCode = toInteger(input.statusCode);
  const counters = statusCounters(statusCode);

  const row: typeof apiKeyUsageBuckets.$inferInsert = {
    bucketStart: toUsageBucketStart(occurredAt),
    apiKeyId: input.apiKeyId,
    provider: input.provider,
    endpoint: input.endpoint,
    requestCount: 1,
    successCount: counters.successCount,
    clientErrorCount: counters.clientErrorCount,
    serverErrorCount: counters.serverErrorCount,
    totalLatencyMs: durationMs,
    maxLatencyMs: durationMs,
    lastRequestAt: occurredAt,
  };

  await database
    .insert(apiKeyUsageBuckets)
    .values(row)
    .onConflictDoUpdate({
      target: [
        apiKeyUsageBuckets.bucketStart,
        apiKeyUsageBuckets.apiKeyId,
        apiKeyUsageBuckets.provider,
        apiKeyUsageBuckets.endpoint,
      ],
      set: {
        requestCount: sql`${apiKeyUsageBuckets.requestCount} + 1`,
        successCount: sql`${apiKeyUsageBuckets.successCount} + ${row.successCount}`,
        clientErrorCount: sql`${apiKeyUsageBuckets.clientErrorCount} + ${row.clientErrorCount}`,
        serverErrorCount: sql`${apiKeyUsageBuckets.serverErrorCount} + ${row.serverErrorCount}`,
        totalLatencyMs: sql`${apiKeyUsageBuckets.totalLatencyMs} + ${row.totalLatencyMs}`,
        maxLatencyMs: sql`max(${apiKeyUsageBuckets.maxLatencyMs}, ${row.maxLatencyMs})`,
        lastRequestAt: sql`max(${apiKeyUsageBuckets.lastRequestAt}, ${row.lastRequestAt})`,
      },
    });
};

const parseProvider = (value: string): Provider | null => {
  for (const provider of providers) {
    if (provider === value) {
      return provider;
    }
  }

  return null;
};

type ApiKeyUsageProviderSummary = {
  provider: Provider;
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
};

type ApiKeyUsageSummary = {
  apiKeyId: string;
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  lastRequestAt: number | null;
  providers: ApiKeyUsageProviderSummary[];
};

const summarySort = (left: ApiKeyUsageSummary, right: ApiKeyUsageSummary) => {
  if (right.requestCount !== left.requestCount) {
    return right.requestCount - left.requestCount;
  }

  return (right.lastRequestAt ?? 0) - (left.lastRequestAt ?? 0);
};

export const listApiKeyUsageSummaries = async (
  database: Database,
  sinceMs: number
): Promise<ApiKeyUsageSummary[]> => {
  const sinceBucket = toUsageBucketStart(toNonNegativeInteger(sinceMs));
  const usageWindow = gte(apiKeyUsageBuckets.bucketStart, sinceBucket);

  const [totalsRows, providerRows] = await Promise.all([
    database
      .select({
        apiKeyId: apiKeyUsageBuckets.apiKeyId,
        requestCount: sql<number>`sum(${apiKeyUsageBuckets.requestCount})`,
        successCount: sql<number>`sum(${apiKeyUsageBuckets.successCount})`,
        clientErrorCount: sql<number>`sum(${apiKeyUsageBuckets.clientErrorCount})`,
        serverErrorCount: sql<number>`sum(${apiKeyUsageBuckets.serverErrorCount})`,
        totalLatencyMs: sql<number>`sum(${apiKeyUsageBuckets.totalLatencyMs})`,
        maxLatencyMs: sql<number>`max(${apiKeyUsageBuckets.maxLatencyMs})`,
        lastRequestAt: sql<number>`max(${apiKeyUsageBuckets.lastRequestAt})`,
      })
      .from(apiKeyUsageBuckets)
      .where(usageWindow)
      .groupBy(apiKeyUsageBuckets.apiKeyId),
    database
      .select({
        apiKeyId: apiKeyUsageBuckets.apiKeyId,
        provider: apiKeyUsageBuckets.provider,
        requestCount: sql<number>`sum(${apiKeyUsageBuckets.requestCount})`,
        successCount: sql<number>`sum(${apiKeyUsageBuckets.successCount})`,
        clientErrorCount: sql<number>`sum(${apiKeyUsageBuckets.clientErrorCount})`,
        serverErrorCount: sql<number>`sum(${apiKeyUsageBuckets.serverErrorCount})`,
      })
      .from(apiKeyUsageBuckets)
      .where(usageWindow)
      .groupBy(apiKeyUsageBuckets.apiKeyId, apiKeyUsageBuckets.provider),
  ]);

  const summariesByKey = new Map<string, ApiKeyUsageSummary>();
  for (const row of totalsRows) {
    const requestCount = toNonNegativeInteger(row.requestCount);
    const totalLatencyMs = toNonNegativeInteger(row.totalLatencyMs);
    const avgLatencyMs = requestCount
      ? Math.round(totalLatencyMs / requestCount)
      : 0;

    summariesByKey.set(row.apiKeyId, {
      apiKeyId: row.apiKeyId,
      requestCount,
      successCount: toNonNegativeInteger(row.successCount),
      clientErrorCount: toNonNegativeInteger(row.clientErrorCount),
      serverErrorCount: toNonNegativeInteger(row.serverErrorCount),
      avgLatencyMs,
      maxLatencyMs: toNonNegativeInteger(row.maxLatencyMs),
      lastRequestAt:
        row.lastRequestAt === null
          ? null
          : toNonNegativeInteger(row.lastRequestAt),
      providers: [],
    });
  }

  for (const row of providerRows) {
    const summary = summariesByKey.get(row.apiKeyId);
    if (!summary) {
      continue;
    }

    const provider = parseProvider(row.provider);
    if (!provider) {
      continue;
    }

    summary.providers.push({
      provider,
      requestCount: toNonNegativeInteger(row.requestCount),
      successCount: toNonNegativeInteger(row.successCount),
      clientErrorCount: toNonNegativeInteger(row.clientErrorCount),
      serverErrorCount: toNonNegativeInteger(row.serverErrorCount),
    });
  }

  for (const summary of summariesByKey.values()) {
    summary.providers.sort(
      (left, right) => right.requestCount - left.requestCount
    );
  }

  return Array.from(summariesByKey.values()).sort(summarySort);
};
