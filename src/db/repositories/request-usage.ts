import { and, desc, eq, gte, sql } from "drizzle-orm";

import type { ProxyEndpoint } from "../../providers/proxy-endpoints";
import {
  classifyRequestOutcome,
  type UsageRequestSource,
} from "../../usage/request-outcome";
import type { TokenUsage } from "../../usage/token-usage";
import { toNonNegativeInteger } from "../../utils/number";
import type { Database } from "../index";
import { apiKeys, requestUsageBuckets, type Provider } from "../schema";
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
} from "./usage-shared";

export const MISSING_PROVIDER_ACCOUNT_ID = "__missing__";

export type RecordRequestUsageInput = {
  apiKeyId: string;
  providerAccountId: string;
  provider: Provider;
  endpoint: ProxyEndpoint;
  model: string;
  source: UsageRequestSource;
  statusCode: number;
  durationMs: number;
  occurredAt: number;
  tokenUsage?: TokenUsage | null;
};

export type RecordTokenUsageInput = {
  apiKeyId: string;
  providerAccountId: string;
  provider: Provider;
  endpoint: ProxyEndpoint;
  model: string;
  occurredAt: number;
  tokenUsage: TokenUsage;
};

const tokenColumns = (tokenUsage: TokenUsage | null | undefined) => {
  const inputTokens = toNonNegativeInteger(tokenUsage?.inputTokens);
  const outputTokens = toNonNegativeInteger(tokenUsage?.outputTokens);
  const cacheReadTokens = toNonNegativeInteger(tokenUsage?.cacheReadTokens);
  const cacheWriteTokens = toNonNegativeInteger(tokenUsage?.cacheWriteTokens);
  const inputTotalTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    inputTotalTokens,
    reasoningTokens: toNonNegativeInteger(tokenUsage?.reasoningTokens),
    totalTokens: toNonNegativeInteger(
      tokenUsage?.totalTokens ?? inputTotalTokens + outputTokens
    ),
  };
};

const usageBucketConflictTarget = [
  requestUsageBuckets.bucketStart,
  requestUsageBuckets.apiKeyId,
  requestUsageBuckets.providerAccountId,
  requestUsageBuckets.provider,
  requestUsageBuckets.endpoint,
  requestUsageBuckets.model,
];

export type UsageBucketWrite = typeof requestUsageBuckets.$inferInsert & {
  requestCount: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
  proxyErrorCount: number;
  upstreamErrorCount: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTotalTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  lastRequestAt: number;
};

export const buildRequestUsageRow = (
  input: RecordRequestUsageInput
): UsageBucketWrite => {
  const occurredAt = toNonNegativeInteger(input.occurredAt);
  const durationMs = toNonNegativeInteger(input.durationMs);
  const counters = classifyRequestOutcome(input.statusCode, input.source);
  return {
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
    proxyErrorCount: counters.proxyErrorCount,
    upstreamErrorCount: counters.upstreamErrorCount,
    totalLatencyMs: durationMs,
    maxLatencyMs: durationMs,
    ...tokenColumns(input.tokenUsage),
    lastRequestAt: occurredAt,
  };
};

export const buildTokenUsageRow = (
  input: RecordTokenUsageInput
): UsageBucketWrite => {
  const occurredAt = toNonNegativeInteger(input.occurredAt);
  return {
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
    proxyErrorCount: 0,
    upstreamErrorCount: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    ...tokenColumns(input.tokenUsage),
    lastRequestAt: occurredAt,
  };
};

const USAGE_UPSERT_BATCH_SIZE = 100;
const buckets = requestUsageBuckets;
const excluded = (column: { name: string }) =>
  sql.raw(`excluded."${column.name}"`);
const addExcluded = (column: { name: string }) =>
  sql`${column} + ${excluded(column)}`;
const storedInputTotalTokens = sql`coalesce(${buckets.inputTotalTokens}, ${buckets.inputTokens} + ${buckets.cacheReadTokens} + ${buckets.cacheWriteTokens})`;

// Adds each row to its bucket. Rows from before the token columns existed
// derive their totals from the legacy input and cache columns.
export const upsertUsageRows = async (
  database: Database,
  rows: readonly UsageBucketWrite[]
): Promise<void> => {
  for (let index = 0; index < rows.length; index += USAGE_UPSERT_BATCH_SIZE) {
    await database
      .insert(buckets)
      .values(rows.slice(index, index + USAGE_UPSERT_BATCH_SIZE))
      .onConflictDoUpdate({
        target: usageBucketConflictTarget,
        set: {
          requestCount: addExcluded(buckets.requestCount),
          successCount: addExcluded(buckets.successCount),
          clientErrorCount: addExcluded(buckets.clientErrorCount),
          serverErrorCount: addExcluded(buckets.serverErrorCount),
          authErrorCount: addExcluded(buckets.authErrorCount),
          rateLimitCount: addExcluded(buckets.rateLimitCount),
          proxyErrorCount: addExcluded(buckets.proxyErrorCount),
          upstreamErrorCount: addExcluded(buckets.upstreamErrorCount),
          totalLatencyMs: addExcluded(buckets.totalLatencyMs),
          maxLatencyMs: sql`max(${buckets.maxLatencyMs}, ${excluded(buckets.maxLatencyMs)})`,
          inputTokens: addExcluded(buckets.inputTokens),
          outputTokens: addExcluded(buckets.outputTokens),
          cacheReadTokens: addExcluded(buckets.cacheReadTokens),
          cacheWriteTokens: addExcluded(buckets.cacheWriteTokens),
          inputTotalTokens: sql`${storedInputTotalTokens} + ${excluded(buckets.inputTotalTokens)}`,
          reasoningTokens: sql`coalesce(${buckets.reasoningTokens}, 0) + ${excluded(buckets.reasoningTokens)}`,
          totalTokens: sql`coalesce(${buckets.totalTokens}, ${storedInputTotalTokens} + ${buckets.outputTokens}) + ${excluded(buckets.totalTokens)}`,
          lastRequestAt: sql`max(${buckets.lastRequestAt}, ${excluded(buckets.lastRequestAt)})`,
        },
      });
  }
};

export const recordRequestUsage = (
  database: Database,
  input: RecordRequestUsageInput
): Promise<void> => upsertUsageRows(database, [buildRequestUsageRow(input)]);

export const recordTokenUsage = (
  database: Database,
  input: RecordTokenUsageInput
): Promise<void> => upsertUsageRows(database, [buildTokenUsageRow(input)]);

type ApiKeyUsageSummary = AveragedUsageTotals & {
  apiKeyId: string;
  providers: UsageProviderSummary[];
};

export const listApiKeyUsageSummaries = async (
  database: Database,
  sinceMs: number
): Promise<ApiKeyUsageSummary[]> => {
  const sinceBucket = toUsageBucketStart(toNonNegativeInteger(sinceMs));

  const [totalsRows, providerRows] = await database.batch([
    database
      .select({
        groupKey: requestUsageBuckets.apiKeyId,
        ...selectUsageCounterSums(requestUsageBuckets),
        ...selectUsageLatencySums(requestUsageBuckets),
        ...selectUsageTokenSums(requestUsageBuckets),
        ...selectUsageLastRequestAtMax(requestUsageBuckets),
      })
      .from(requestUsageBuckets)
      .where(gte(requestUsageBuckets.bucketStart, sinceBucket))
      .groupBy(requestUsageBuckets.apiKeyId),
    database
      .select({
        groupKey: requestUsageBuckets.apiKeyId,
        provider: requestUsageBuckets.provider,
        ...selectUsageCounterSums(requestUsageBuckets),
        ...selectUsageTokenSums(requestUsageBuckets),
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
): Promise<ApiKeyUsageDetail | null> => {
  const sinceBucket = toUsageBucketStart(toNonNegativeInteger(sinceMs));
  const windowFilter = and(
    eq(requestUsageBuckets.apiKeyId, apiKeyId),
    gte(requestUsageBuckets.bucketStart, sinceBucket)
  );

  const [keyRows, totalsRows, endpointRows, modelRows, bucketRows] =
    await database.batch([
      database
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.id, apiKeyId))
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

  if (!keyRows.length) {
    return null;
  }

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
