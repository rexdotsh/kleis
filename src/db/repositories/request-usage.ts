import { and, desc, eq, gte, sql } from "drizzle-orm";

import type { ProxyEndpoint } from "../../providers/proxy-endpoints";
import type { TokenUsage } from "../../usage/token-usage";
import type { Database } from "../index";
import { requestUsageBuckets, type Provider } from "../schema";
import {
  applyTotalsRow,
  DETAIL_BUCKET_LIMIT,
  emptyUsageTotals,
  mapEndpointUsageRows,
  mapModelUsageRows,
  mapUsageBucketRows,
  summarizeGroupedUsageRows,
  toAveragedTotals,
  toNonNegativeInteger,
  toUsageBucketStart,
  type UsageBucketRow,
  type UsageEndpointBreakdown,
  type UsageModelBreakdown,
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
  const isAuthError = statusCode === 401 || statusCode === 403;
  const isRateLimitError = statusCode === 429;
  const isClientError = statusCode >= 400 && statusCode < 500;

  const successCount = statusCode >= 200 && statusCode < 400 ? 1 : 0;
  const clientErrorCount =
    isClientError && !isAuthError && !isRateLimitError ? 1 : 0;
  const serverErrorCount = statusCode >= 500 ? 1 : 0;

  return {
    successCount,
    clientErrorCount,
    serverErrorCount,
    authErrorCount: isAuthError ? 1 : 0,
    rateLimitCount: isRateLimitError ? 1 : 0,
  };
};

type RecordRequestUsageInput = {
  apiKeyId: string;
  providerAccountId: string;
  provider: Provider;
  endpoint: ProxyEndpoint;
  model: string;
  statusCode: number;
  durationMs: number;
  occurredAt: number;
  tokenUsage?: TokenUsage | null;
};

type RecordTokenUsageInput = {
  apiKeyId: string;
  providerAccountId: string;
  provider: Provider;
  endpoint: ProxyEndpoint;
  model: string;
  occurredAt: number;
  tokenUsage: TokenUsage;
};

const tokenColumns = (tokenUsage: TokenUsage | null | undefined) => ({
  inputTokens: toNonNegativeInteger(tokenUsage?.inputTokens),
  outputTokens: toNonNegativeInteger(tokenUsage?.outputTokens),
  cacheReadTokens: toNonNegativeInteger(tokenUsage?.cacheReadTokens),
  cacheWriteTokens: toNonNegativeInteger(tokenUsage?.cacheWriteTokens),
});

export const recordRequestUsage = async (
  database: Database,
  input: RecordRequestUsageInput
): Promise<void> => {
  const occurredAt = toNonNegativeInteger(input.occurredAt);
  const durationMs = toNonNegativeInteger(input.durationMs);
  const counters = statusCounters(input.statusCode);
  const tokens = tokenColumns(input.tokenUsage);

  const row: typeof requestUsageBuckets.$inferInsert = {
    bucketStart: toUsageBucketStart(occurredAt),
    apiKeyId: input.apiKeyId,
    providerAccountId: input.providerAccountId,
    provider: input.provider,
    endpoint: input.endpoint,
    model: input.model,
    requestCount: 1,
    successCount: counters.successCount,
    clientErrorCount: counters.clientErrorCount,
    serverErrorCount: counters.serverErrorCount,
    authErrorCount: counters.authErrorCount,
    rateLimitCount: counters.rateLimitCount,
    totalLatencyMs: durationMs,
    maxLatencyMs: durationMs,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
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
        requestUsageBuckets.model,
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
        inputTokens: sql`${requestUsageBuckets.inputTokens} + ${row.inputTokens}`,
        outputTokens: sql`${requestUsageBuckets.outputTokens} + ${row.outputTokens}`,
        cacheReadTokens: sql`${requestUsageBuckets.cacheReadTokens} + ${row.cacheReadTokens}`,
        cacheWriteTokens: sql`${requestUsageBuckets.cacheWriteTokens} + ${row.cacheWriteTokens}`,
        lastRequestAt: sql`max(${requestUsageBuckets.lastRequestAt}, ${row.lastRequestAt})`,
      },
    });
};

export const recordTokenUsage = async (
  database: Database,
  input: RecordTokenUsageInput
): Promise<void> => {
  const occurredAt = toNonNegativeInteger(input.occurredAt);
  const tokens = tokenColumns(input.tokenUsage);

  const row: typeof requestUsageBuckets.$inferInsert = {
    bucketStart: toUsageBucketStart(occurredAt),
    apiKeyId: input.apiKeyId,
    providerAccountId: input.providerAccountId,
    provider: input.provider,
    endpoint: input.endpoint,
    model: input.model,
    requestCount: 0,
    successCount: 0,
    clientErrorCount: 0,
    serverErrorCount: 0,
    authErrorCount: 0,
    rateLimitCount: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
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
        requestUsageBuckets.model,
      ],
      set: {
        inputTokens: sql`${requestUsageBuckets.inputTokens} + ${row.inputTokens}`,
        outputTokens: sql`${requestUsageBuckets.outputTokens} + ${row.outputTokens}`,
        cacheReadTokens: sql`${requestUsageBuckets.cacheReadTokens} + ${row.cacheReadTokens}`,
        cacheWriteTokens: sql`${requestUsageBuckets.cacheWriteTokens} + ${row.cacheWriteTokens}`,
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
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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
        inputTokens: sql<number>`sum(${requestUsageBuckets.inputTokens})`,
        outputTokens: sql<number>`sum(${requestUsageBuckets.outputTokens})`,
        cacheReadTokens: sql<number>`sum(${requestUsageBuckets.cacheReadTokens})`,
        cacheWriteTokens: sql<number>`sum(${requestUsageBuckets.cacheWriteTokens})`,
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
        inputTokens: sql<number>`sum(${requestUsageBuckets.inputTokens})`,
        outputTokens: sql<number>`sum(${requestUsageBuckets.outputTokens})`,
        cacheReadTokens: sql<number>`sum(${requestUsageBuckets.cacheReadTokens})`,
        cacheWriteTokens: sql<number>`sum(${requestUsageBuckets.cacheWriteTokens})`,
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

type ApiKeyUsageModelBreakdown = UsageModelBreakdown;

type ApiKeyUsageBucketRow = UsageBucketRow;

type ApiKeyUsageDetail = {
  apiKeyId: string;
  totals: Omit<ApiKeyUsageSummary, "apiKeyId" | "providers">;
  endpoints: ApiKeyUsageEndpointBreakdown[];
  models: ApiKeyUsageModelBreakdown[];
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

  const [totalsRows, endpointRows, modelRows, bucketRows] = await Promise.all([
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
        inputTokens: sql<number>`sum(${requestUsageBuckets.inputTokens})`,
        outputTokens: sql<number>`sum(${requestUsageBuckets.outputTokens})`,
        cacheReadTokens: sql<number>`sum(${requestUsageBuckets.cacheReadTokens})`,
        cacheWriteTokens: sql<number>`sum(${requestUsageBuckets.cacheWriteTokens})`,
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
        inputTokens: sql<number>`sum(${requestUsageBuckets.inputTokens})`,
        outputTokens: sql<number>`sum(${requestUsageBuckets.outputTokens})`,
        cacheReadTokens: sql<number>`sum(${requestUsageBuckets.cacheReadTokens})`,
        cacheWriteTokens: sql<number>`sum(${requestUsageBuckets.cacheWriteTokens})`,
        lastRequestAt: sql<number>`max(${requestUsageBuckets.lastRequestAt})`,
      })
      .from(requestUsageBuckets)
      .where(windowFilter)
      .groupBy(requestUsageBuckets.provider, requestUsageBuckets.endpoint),
    database
      .select({
        provider: requestUsageBuckets.provider,
        endpoint: requestUsageBuckets.endpoint,
        model: requestUsageBuckets.model,
        requestCount: sql<number>`sum(${requestUsageBuckets.requestCount})`,
        successCount: sql<number>`sum(${requestUsageBuckets.successCount})`,
        clientErrorCount: sql<number>`sum(${requestUsageBuckets.clientErrorCount})`,
        serverErrorCount: sql<number>`sum(${requestUsageBuckets.serverErrorCount})`,
        authErrorCount: sql<number>`sum(${requestUsageBuckets.authErrorCount})`,
        rateLimitCount: sql<number>`sum(${requestUsageBuckets.rateLimitCount})`,
        totalLatencyMs: sql<number>`sum(${requestUsageBuckets.totalLatencyMs})`,
        maxLatencyMs: sql<number>`max(${requestUsageBuckets.maxLatencyMs})`,
        inputTokens: sql<number>`sum(${requestUsageBuckets.inputTokens})`,
        outputTokens: sql<number>`sum(${requestUsageBuckets.outputTokens})`,
        cacheReadTokens: sql<number>`sum(${requestUsageBuckets.cacheReadTokens})`,
        cacheWriteTokens: sql<number>`sum(${requestUsageBuckets.cacheWriteTokens})`,
        lastRequestAt: sql<number>`max(${requestUsageBuckets.lastRequestAt})`,
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
        requestCount: sql<number>`sum(${requestUsageBuckets.requestCount})`,
        successCount: sql<number>`sum(${requestUsageBuckets.successCount})`,
        clientErrorCount: sql<number>`sum(${requestUsageBuckets.clientErrorCount})`,
        serverErrorCount: sql<number>`sum(${requestUsageBuckets.serverErrorCount})`,
        authErrorCount: sql<number>`sum(${requestUsageBuckets.authErrorCount})`,
        rateLimitCount: sql<number>`sum(${requestUsageBuckets.rateLimitCount})`,
        inputTokens: sql<number>`sum(${requestUsageBuckets.inputTokens})`,
        outputTokens: sql<number>`sum(${requestUsageBuckets.outputTokens})`,
        cacheReadTokens: sql<number>`sum(${requestUsageBuckets.cacheReadTokens})`,
        cacheWriteTokens: sql<number>`sum(${requestUsageBuckets.cacheWriteTokens})`,
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

  const models: ApiKeyUsageModelBreakdown[] = mapModelUsageRows(modelRows);

  const buckets: ApiKeyUsageBucketRow[] = mapUsageBucketRows(bucketRows);

  return {
    apiKeyId,
    totals: toAveragedTotals(totals),
    endpoints,
    models,
    buckets,
  };
};
