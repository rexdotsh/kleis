import { eq } from "drizzle-orm";

import type { Database } from "../index";
import {
  claudeApiRateLimitSnapshots,
  codexResetCreditRedemptions,
  codexThreadUsage,
  providerAccountTracking,
  type Provider,
} from "../schema";
import type {
  CodexResetCredit,
  CodexThreadUsageEntry,
  CodexUsageStatus,
} from "../../providers/account-tracking/codex";
import { isObjectRecord } from "../../utils/object";

export type CodexTrackingData = {
  provider: "codex";
  status?: CodexUsageStatus;
  resetCredits?: {
    availableCount: number | null;
    credits: CodexResetCredit[];
  };
  profile?: {
    lifetimeTokens: number | null;
    peakDailyTokens: number | null;
    longestRunningTurnSeconds: number | null;
    currentStreakDays: number | null;
    longestStreakDays: number | null;
    dailyUsageBuckets: Array<{ startDate: string; tokens: number }>;
  };
  accounts?: {
    accounts: Array<{
      id: string;
      name: string | null;
      profilePictureUrl: string | null;
      structure: string | null;
    }>;
    accountOrdering: string[];
    defaultAccountId: string | null;
  };
};

export type ClaudeTrackingData = {
  provider: "claude";
  subscription?: {
    source: "oauth";
    fiveHour: {
      utilization: number | null;
      resetsAt: string | null;
      limitDollars: number | null;
      usedDollars: number | null;
      remainingDollars: number | null;
    } | null;
    sevenDay: {
      utilization: number | null;
      resetsAt: string | null;
      limitDollars: number | null;
      usedDollars: number | null;
      remainingDollars: number | null;
    } | null;
    modelWindows: Record<string, unknown>;
    extraUsage: Record<string, unknown> | null;
    limits: Record<string, unknown>[];
  };
};

export type ProviderTrackingData = CodexTrackingData | ClaudeTrackingData;

export type ProviderAccountTrackingRecord = {
  providerAccountId: string;
  provider: Provider;
  fetchedAt: number | null;
  attemptedAt: number;
  nextFetchAt: number | null;
  failureCount: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  data: ProviderTrackingData | null;
};

const parseTrackingData = (
  value: string | null
): ProviderTrackingData | null => {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      isObjectRecord(parsed) &&
      (parsed.provider === "codex" || parsed.provider === "claude")
    ) {
      return parsed as ProviderTrackingData;
    }
  } catch {
    return null;
  }
  return null;
};

const toTrackingRecord = (
  row: typeof providerAccountTracking.$inferSelect
): ProviderAccountTrackingRecord => ({
  providerAccountId: row.providerAccountId,
  provider: row.provider,
  fetchedAt: row.fetchedAt,
  attemptedAt: row.attemptedAt,
  nextFetchAt: row.nextFetchAt,
  failureCount: row.failureCount,
  lastHttpStatus: row.lastHttpStatus,
  lastError: row.lastError,
  data: parseTrackingData(row.dataJson),
});

export const findProviderAccountTracking = async (
  database: Database,
  providerAccountId: string
): Promise<ProviderAccountTrackingRecord | null> => {
  const row = await database.query.providerAccountTracking.findFirst({
    where: eq(providerAccountTracking.providerAccountId, providerAccountId),
  });
  return row ? toTrackingRecord(row) : null;
};

export const listProviderAccountTracking = async (
  database: Database
): Promise<ProviderAccountTrackingRecord[]> => {
  const rows = await database.select().from(providerAccountTracking);
  return rows.map(toTrackingRecord);
};

export const saveProviderAccountTracking = async (
  database: Database,
  input: {
    providerAccountId: string;
    provider: Provider;
    attemptedAt: number;
    fetchedAt: number | null;
    nextFetchAt: number | null;
    failureCount: number;
    lastHttpStatus: number | null;
    lastError: string | null;
    data: ProviderTrackingData | null;
  }
): Promise<ProviderAccountTrackingRecord> => {
  const values: typeof providerAccountTracking.$inferInsert = {
    providerAccountId: input.providerAccountId,
    provider: input.provider,
    attemptedAt: input.attemptedAt,
    fetchedAt: input.fetchedAt,
    nextFetchAt: input.nextFetchAt,
    failureCount: input.failureCount,
    lastHttpStatus: input.lastHttpStatus,
    lastError: input.lastError,
    dataJson: input.data ? JSON.stringify(input.data) : null,
  };
  await database
    .insert(providerAccountTracking)
    .values(values)
    .onConflictDoUpdate({
      target: providerAccountTracking.providerAccountId,
      set: values,
    });
  const saved = await findProviderAccountTracking(
    database,
    input.providerAccountId
  );
  if (!saved) {
    throw new Error("Failed to load provider account tracking snapshot");
  }
  return saved;
};

export const saveClaudeRateLimitSnapshot = async (
  database: Database,
  input: {
    providerAccountId: string;
    fetchedAt: number;
    sourceEndpoint: string;
    workspaceId: string | null;
    data: Record<string, unknown>;
  }
): Promise<void> => {
  const values: typeof claudeApiRateLimitSnapshots.$inferInsert = {
    providerAccountId: input.providerAccountId,
    fetchedAt: input.fetchedAt,
    sourceEndpoint: input.sourceEndpoint,
    workspaceId: input.workspaceId,
    dataJson: JSON.stringify(input.data),
  };
  await database
    .insert(claudeApiRateLimitSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: claudeApiRateLimitSnapshots.providerAccountId,
      set: values,
    });
};

export const findClaudeRateLimitSnapshot = async (
  database: Database,
  providerAccountId: string
) => {
  const row = await database.query.claudeApiRateLimitSnapshots.findFirst({
    where: eq(claudeApiRateLimitSnapshots.providerAccountId, providerAccountId),
  });
  if (!row) {
    return null;
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.dataJson) as unknown;
    if (isObjectRecord(parsed)) {
      data = parsed;
    }
  } catch {
    data = {};
  }
  return {
    providerAccountId: row.providerAccountId,
    fetchedAt: row.fetchedAt,
    sourceEndpoint: row.sourceEndpoint,
    workspaceId: row.workspaceId,
    data,
  };
};

export const upsertCodexThreadUsage = async (
  database: Database,
  providerAccountId: string,
  entries: readonly CodexThreadUsageEntry[],
  fetchedAt: number
): Promise<void> => {
  for (const entry of entries) {
    const values: typeof codexThreadUsage.$inferInsert = {
      providerAccountId,
      threadId: entry.threadId,
      fetchedAt,
      estimatedUsageCreditsMicros: entry.estimatedUsageCreditsMicros,
      estimatedUsageUsdMicros: entry.estimatedUsageUsdMicros,
      groupsJson: JSON.stringify(entry.groups),
    };
    await database
      .insert(codexThreadUsage)
      .values(values)
      .onConflictDoUpdate({
        target: [codexThreadUsage.providerAccountId, codexThreadUsage.threadId],
        set: values,
      });
  }
};

export const findCodexResetCreditRedemption = async (
  database: Database,
  redeemRequestId: string
) =>
  database.query.codexResetCreditRedemptions.findFirst({
    where: eq(codexResetCreditRedemptions.redeemRequestId, redeemRequestId),
  });

export const saveCodexResetCreditRedemption = async (
  database: Database,
  input: typeof codexResetCreditRedemptions.$inferInsert
): Promise<void> => {
  await database
    .insert(codexResetCreditRedemptions)
    .values(input)
    .onConflictDoUpdate({
      target: codexResetCreditRedemptions.redeemRequestId,
      set: {
        status: input.status,
        resultCode: input.resultCode,
        windowsReset: input.windowsReset,
        lastError: input.lastError,
        updatedAt: input.updatedAt,
      },
    });
};
