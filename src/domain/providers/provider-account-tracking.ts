import type { Database } from "../../db";
import {
  findClaudeRateLimitSnapshot,
  findCodexResetCreditRedemption,
  findProviderAccountTracking,
  listProviderAccountTracking,
  saveCodexResetCreditRedemption,
  saveProviderAccountTracking,
  upsertCodexThreadUsage,
  type ClaudeTrackingData,
  type CodexTrackingData,
  type ProviderAccountTrackingRecord,
} from "../../db/repositories/provider-account-tracking";
import {
  findProviderAccountById,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import {
  consumeCodexResetCredit,
  fetchCodexAccounts,
  fetchCodexResetCredits,
  fetchCodexThreadUsage,
  fetchCodexUsageProfile,
  fetchCodexUsageStatus,
} from "../../providers/account-tracking/codex";
import { fetchClaudeSubscriptionUsage } from "../../providers/account-tracking/claude";
import { AccountTrackingHttpError } from "../../providers/account-tracking/http";
import { refreshProviderAccount } from "./provider-service";

const TRACKING_CACHE_MS = 60_000;
const TRACKING_STALE_MS = 5 * 60_000;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;

type SupportedTrackingAccount = ProviderAccountRecord & {
  provider: "codex" | "claude";
};

const isSupportedTrackingAccount = (
  account: ProviderAccountRecord
): account is SupportedTrackingAccount =>
  account.provider === "codex" || account.provider === "claude";

const safeErrorMessage = (error: unknown): string => {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "Account tracking request timed out";
  }
  return error instanceof Error
    ? error.message
    : "Unknown account tracking failure";
};

const errorStatus = (error: unknown): number | null =>
  error instanceof AccountTrackingHttpError ? error.status : null;

const calculateNextFetchAt = (
  now: number,
  failureCount: number,
  errors: readonly unknown[]
): number => {
  const retryAfterMs = errors.flatMap((error) =>
    error instanceof AccountTrackingHttpError && error.retryAfterMs !== null
      ? [error.retryAfterMs]
      : []
  );
  const backoffMs = Math.min(
    TRACKING_CACHE_MS * 2 ** Math.max(0, failureCount - 1),
    MAX_BACKOFF_MS
  );
  return (
    now +
    Math.min(
      retryAfterMs.length ? Math.max(...retryAfterMs) : backoffMs,
      MAX_BACKOFF_MS
    )
  );
};

const resolveTrackingAccount = async (
  database: Database,
  providerAccountId: string,
  now: number,
  forceTokenRefresh = false,
  knownAccount?: ProviderAccountRecord
): Promise<SupportedTrackingAccount | null> => {
  let account =
    knownAccount ??
    (await findProviderAccountById(database, providerAccountId));
  if (!account || !isSupportedTrackingAccount(account)) {
    return null;
  }
  if (forceTokenRefresh || account.expiresAt <= now + TOKEN_EXPIRY_MARGIN_MS) {
    account = await refreshProviderAccount(database, account.id, now, {
      force: true,
    });
  }
  return account && isSupportedTrackingAccount(account) ? account : null;
};

const settle = async <T>(
  promise: Promise<T>
): Promise<PromiseSettledResult<T>> => {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
};

type CodexSnapshotField = "status" | "resetCredits" | "profile" | "accounts";
type CodexSnapshotResult = [CodexSnapshotField, PromiseSettledResult<unknown>];
type TrackingFetchResult = {
  data: CodexTrackingData | ClaudeTrackingData;
  errors: unknown[];
  fetched: boolean;
};

const CODEX_SNAPSHOT_FETCHERS: readonly [
  CodexSnapshotField,
  (accessToken: string, accountId: string | null) => Promise<unknown>,
][] = [
  ["status", fetchCodexUsageStatus],
  ["resetCredits", fetchCodexResetCredits],
  ["profile", fetchCodexUsageProfile],
  ["accounts", fetchCodexAccounts],
];

const fetchCodexSnapshot = async (
  account: SupportedTrackingAccount,
  previous: CodexTrackingData
): Promise<TrackingFetchResult> => {
  const results = await Promise.all(
    CODEX_SNAPSHOT_FETCHERS.map(async ([field, fetcher]) => [
      field,
      await settle(fetcher(account.accessToken, account.accountId)),
    ]) as Promise<CodexSnapshotResult>[]
  );
  const data = { ...previous };
  const errors: unknown[] = [];
  for (const [field, result] of results) {
    if (result.status === "fulfilled") {
      Object.assign(data, { [field]: result.value });
    } else {
      errors.push(result.reason);
    }
  }
  return {
    data,
    errors,
    fetched: errors.length < CODEX_SNAPSHOT_FETCHERS.length,
  };
};

const fetchClaudeSnapshot = async (
  account: SupportedTrackingAccount,
  previous: ClaudeTrackingData
): Promise<TrackingFetchResult> => {
  const result = await settle(
    fetchClaudeSubscriptionUsage(account.accessToken)
  );
  return result.status === "fulfilled"
    ? {
        data: { ...previous, subscription: result.value },
        errors: [],
        fetched: true,
      }
    : { data: previous, errors: [result.reason], fetched: false };
};

const withAuthRetry = async <T>(
  database: Database,
  account: SupportedTrackingAccount,
  operation: (current: SupportedTrackingAccount) => Promise<T>,
  shouldRetry: (result: T) => boolean
): Promise<{
  account: SupportedTrackingAccount;
  result: T;
}> => {
  const result = await operation(account);
  if (!shouldRetry(result)) {
    return { account, result };
  }
  const refreshed = await resolveTrackingAccount(
    database,
    account.id,
    Date.now(),
    true
  );
  if (!refreshed) {
    return { account, result };
  }
  return { account: refreshed, result: await operation(refreshed) };
};

const saveSnapshot = (
  database: Database,
  account: SupportedTrackingAccount,
  existing: ProviderAccountTrackingRecord | null,
  data: CodexTrackingData | ClaudeTrackingData,
  errors: readonly unknown[],
  fetched: boolean,
  now: number
) => {
  const failureCount = errors.length ? (existing?.failureCount ?? 0) + 1 : 0;
  return saveProviderAccountTracking(database, {
    providerAccountId: account.id,
    provider: account.provider,
    attemptedAt: now,
    fetchedAt: fetched ? now : (existing?.fetchedAt ?? null),
    nextFetchAt: errors.length
      ? calculateNextFetchAt(now, failureCount, errors)
      : now + TRACKING_CACHE_MS,
    failureCount,
    lastHttpStatus:
      errors.map(errorStatus).find((status) => status !== null) ?? null,
    lastError: errors.length ? errors.map(safeErrorMessage).join("; ") : null,
    data,
  });
};

export const refreshProviderAccountTracking = async (
  database: Database,
  providerAccountId: string,
  input?: { force?: boolean }
): Promise<ProviderAccountTrackingRecord | null> => {
  const now = Date.now();
  const existing = await findProviderAccountTracking(
    database,
    providerAccountId
  );
  if (!input?.force && existing?.nextFetchAt && existing.nextFetchAt > now) {
    return existing;
  }

  const storedAccount = await findProviderAccountById(
    database,
    providerAccountId
  );
  if (!storedAccount || !isSupportedTrackingAccount(storedAccount)) {
    return null;
  }

  try {
    const account = await resolveTrackingAccount(
      database,
      providerAccountId,
      now,
      false,
      storedAccount
    );
    if (!account) {
      return null;
    }
    const previous =
      existing?.data?.provider === account.provider
        ? existing.data
        : { provider: account.provider };
    const fetched = await withAuthRetry(
      database,
      account,
      account.provider === "codex"
        ? (current) =>
            fetchCodexSnapshot(current, previous as CodexTrackingData)
        : (current) =>
            fetchClaudeSnapshot(current, previous as ClaudeTrackingData),
      (result) => result.errors.some((error) => errorStatus(error) === 401)
    );
    return saveSnapshot(
      database,
      fetched.account,
      existing,
      fetched.result.data,
      fetched.result.errors,
      fetched.result.fetched,
      Date.now()
    );
  } catch (error) {
    return saveSnapshot(
      database,
      storedAccount,
      existing,
      existing?.data ?? { provider: storedAccount.provider },
      [error],
      false,
      Date.now()
    );
  }
};

const toTrackingView = async (
  database: Database,
  record: ProviderAccountTrackingRecord,
  now: number
) => ({
  ...record,
  ageMs: record.fetchedAt === null ? null : Math.max(0, now - record.fetchedAt),
  stale:
    record.fetchedAt === null ||
    now - record.fetchedAt >= TRACKING_STALE_MS ||
    record.lastError !== null,
  rateLimits:
    record.provider === "claude"
      ? await findClaudeRateLimitSnapshot(database, record.providerAccountId)
      : null,
});

export const getProviderAccountTrackingView = async (
  database: Database,
  providerAccountId: string,
  now = Date.now()
) => {
  const record = await findProviderAccountTracking(database, providerAccountId);
  return record ? toTrackingView(database, record, now) : null;
};

export const listProviderAccountTrackingViews = async (
  database: Database,
  now = Date.now()
) => {
  const records = await listProviderAccountTracking(database);
  return Promise.all(
    records.map((record) => toTrackingView(database, record, now))
  );
};

const retryCodexOperationAfter401 = async <T>(
  database: Database,
  account: SupportedTrackingAccount,
  operation: (account: SupportedTrackingAccount) => Promise<T>
): Promise<T> => {
  const { result } = await withAuthRetry(
    database,
    account,
    (current) => settle(operation(current)),
    (settled) =>
      settled.status === "rejected" && errorStatus(settled.reason) === 401
  );
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
};

export const queryCodexThreadUsage = async (
  database: Database,
  providerAccountId: string,
  threadIds: readonly string[]
) => {
  const account = await resolveTrackingAccount(
    database,
    providerAccountId,
    Date.now()
  );
  if (!account || account.provider !== "codex") {
    return null;
  }
  const entries = await retryCodexOperationAfter401(
    database,
    account,
    (current) =>
      fetchCodexThreadUsage(current.accessToken, current.accountId, threadIds)
  );
  await upsertCodexThreadUsage(
    database,
    providerAccountId,
    entries,
    Date.now()
  );
  return entries;
};

export class CodexResetCreditConsumeError extends Error {
  readonly redeemRequestId: string;

  constructor(message: string, redeemRequestId: string) {
    super(message);
    this.name = "CodexResetCreditConsumeError";
    this.redeemRequestId = redeemRequestId;
  }
}

export const redeemCodexResetCredit = async (
  database: Database,
  providerAccountId: string,
  input: {
    creditId?: string | null | undefined;
    redeemRequestId?: string | null | undefined;
  }
) => {
  const account = await resolveTrackingAccount(
    database,
    providerAccountId,
    Date.now()
  );
  if (!account || account.provider !== "codex") {
    return null;
  }
  const redeemRequestId = input.redeemRequestId ?? crypto.randomUUID();
  const existing = await findCodexResetCreditRedemption(
    database,
    redeemRequestId
  );
  if (existing && existing.providerAccountId !== providerAccountId) {
    throw new Error("Reset-credit redemption belongs to another account");
  }
  if (existing?.status === "completed" && existing.resultCode) {
    return {
      redeemRequestId,
      code: existing.resultCode,
      windowsReset: existing.windowsReset,
    };
  }
  const now = Date.now();
  const creditId = input.creditId ?? existing?.creditId ?? null;
  const saveRedemption = (
    status: string,
    resultCode: string | null,
    windowsReset: number | null,
    lastError: string | null
  ) =>
    saveCodexResetCreditRedemption(database, {
      redeemRequestId,
      providerAccountId,
      creditId,
      status,
      resultCode,
      windowsReset,
      lastError,
      createdAt: existing?.createdAt ?? now,
      updatedAt: Date.now(),
    });
  await saveRedemption("pending", null, null, null);

  try {
    const result = await retryCodexOperationAfter401(
      database,
      account,
      (current) =>
        consumeCodexResetCredit({
          accessToken: current.accessToken,
          accountId: current.accountId,
          redeemRequestId,
          creditId,
        })
    );
    await saveRedemption("completed", result.code, result.windowsReset, null);
    if (result.code === "reset" || result.code === "already_redeemed") {
      await refreshProviderAccountTracking(database, providerAccountId, {
        force: true,
      });
    }
    return { redeemRequestId, ...result };
  } catch (error) {
    await saveRedemption("retryable", null, null, safeErrorMessage(error));
    throw new CodexResetCreditConsumeError(
      safeErrorMessage(error),
      redeemRequestId
    );
  }
};
