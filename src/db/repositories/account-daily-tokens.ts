import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { toNonNegativeInteger } from "../../utils/number";
import type { Database } from "../index";
import {
  providerAccounts,
  requestUsageBuckets,
  type Provider,
} from "../schema";
import { selectUsageTokenSums } from "./usage-shared";

const DAY_MS = 86_400_000;

export const toUtcDayStart = (timestampMs: number): number =>
  timestampMs - (timestampMs % DAY_MS);

type DailyTokenCounts = {
  requestCount: number;
  inputTokens: number;
  inputTotalTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

export type DailyTokenDay = DailyTokenCounts & {
  date: string;
  dayStart: number;
};

export type ProviderAccountDailyTokens = {
  providerAccountId: string;
  provider: Provider;
  totals: DailyTokenCounts;
  daily: DailyTokenDay[];
};

const emptyCounts = (): DailyTokenCounts => ({
  requestCount: 0,
  inputTokens: 0,
  inputTotalTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
});

const COUNT_FIELDS = Object.keys(emptyCounts()) as (keyof DailyTokenCounts)[];

export const resolveDailyTokenWindow = (days: number, now: number) => {
  const until = toUtcDayStart(now) + DAY_MS;
  return { since: until - days * DAY_MS, until };
};

export const listProviderAccountDailyTokens = async (
  database: Database,
  input: {
    days: number;
    now: number;
    accountIds?: readonly string[];
    provider?: Provider;
  }
): Promise<ProviderAccountDailyTokens[]> => {
  const { since, until } = resolveDailyTokenWindow(input.days, input.now);
  // libSQL binds the day length as a REAL, so the division is truncated
  // explicitly before multiplying back to a UTC midnight.
  const dayStart = sql<number>`cast(${requestUsageBuckets.bucketStart} / ${DAY_MS} as integer) * ${DAY_MS}`;

  const [accountRows, dayRows] = await database.batch([
    database
      .select({ id: providerAccounts.id, provider: providerAccounts.provider })
      .from(providerAccounts)
      .where(
        and(
          input.accountIds
            ? inArray(providerAccounts.id, [...input.accountIds])
            : undefined,
          input.provider
            ? eq(providerAccounts.provider, input.provider)
            : undefined
        )
      )
      .orderBy(asc(providerAccounts.createdAt), asc(providerAccounts.id)),
    database
      .select({
        providerAccountId: requestUsageBuckets.providerAccountId,
        dayStart,
        requestCount: sql<number>`sum(${requestUsageBuckets.requestCount})`,
        ...selectUsageTokenSums(requestUsageBuckets),
      })
      .from(requestUsageBuckets)
      .where(
        and(
          gte(requestUsageBuckets.bucketStart, since),
          lt(requestUsageBuckets.bucketStart, until),
          input.accountIds
            ? inArray(requestUsageBuckets.providerAccountId, [
                ...input.accountIds,
              ])
            : undefined,
          input.provider
            ? eq(requestUsageBuckets.provider, input.provider)
            : undefined
        )
      )
      .groupBy(requestUsageBuckets.providerAccountId, dayStart),
  ]);

  const rowsByAccount = new Map<string, Map<number, DailyTokenCounts>>();
  for (const row of dayRows) {
    const counts = emptyCounts();
    for (const field of COUNT_FIELDS) {
      counts[field] = toNonNegativeInteger(row[field]);
    }
    const days = rowsByAccount.get(row.providerAccountId) ?? new Map();
    days.set(toNonNegativeInteger(row.dayStart), counts);
    rowsByAccount.set(row.providerAccountId, days);
  }

  return accountRows.map((account) => {
    const days = rowsByAccount.get(account.id);
    const totals = emptyCounts();
    const daily: DailyTokenDay[] = [];
    for (let start = since; start < until; start += DAY_MS) {
      const counts = days?.get(start) ?? emptyCounts();
      for (const field of COUNT_FIELDS) {
        totals[field] += counts[field];
      }
      daily.push({
        date: new Date(start).toISOString().slice(0, 10),
        dayStart: start,
        ...counts,
      });
    }
    return {
      providerAccountId: account.id,
      provider: account.provider,
      totals,
      daily,
    };
  });
};
