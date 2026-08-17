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
  if (error instanceof AccountTrackingHttpError) {
    return error.message;
  }
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
  const retryAfterMs = errors.reduce<number | null>((current, error) => {
    if (!(error instanceof AccountTrackingHttpError)) {
      return current;
    }
    if (error.retryAfterMs === null) {
      return current;
    }
    return Math.max(current ?? 0, error.retryAfterMs);
  }, null);
  if (retryAfterMs !== null) {
    return now + Math.min(retryAfterMs, MAX_BACKOFF_MS);
  }
  return (
    now +
    Math.min(
      TRACKING_CACHE_MS * 2 ** Math.max(0, failureCount - 1),
      MAX_BACKOFF_MS
    )
  );
};

const resolveTrackingAccount = async (
  database: Database,
  providerAccountId: string,
  now: number,
  forceTokenRefresh = false
): Promise<SupportedTrackingAccount | null> => {
  let account = await findProviderAccountById(database, providerAccountId);
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

const shouldRetryAuthorization = (
  results: readonly PromiseSettledResult<unknown>[]
): boolean =>
  results.some(
    (result) =>
      result.status === "rejected" && errorStatus(result.reason) === 401
  );

const fetchCodexSnapshot = (account: SupportedTrackingAccount) => {
  const fetchAll = () =>
    Promise.allSettled([
      fetchCodexUsageStatus(account.accessToken, account.accountId),
      fetchCodexResetCredits(account.accessToken, account.accountId),
      fetchCodexUsageProfile(account.accessToken, account.accountId),
      fetchCodexAccounts(account.accessToken, account.accountId),
    ]);
  return fetchAll();
};

const saveCodexSnapshot = (
  database: Database,
  account: SupportedTrackingAccount,
  existing: ProviderAccountTrackingRecord | null,
  results: Awaited<ReturnType<typeof fetchCodexSnapshot>>,
  now: number
) => {
  const previous: CodexTrackingData =
    existing?.data?.provider === "codex"
      ? existing.data
      : { provider: "codex" };
  const data: CodexTrackingData = { ...previous };
  const fields = ["status", "resetCredits", "profile", "accounts"] as const;
  const errors: unknown[] = [];
  let successCount = 0;
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      const field = fields[index];
      if (field) {
        Object.assign(data, { [field]: result.value });
        successCount += 1;
      }
    } else {
      errors.push(result.reason);
    }
  }
  const failureCount =
    errors.length > 0 ? (existing?.failureCount ?? 0) + 1 : 0;
  return saveProviderAccountTracking(database, {
    providerAccountId: account.id,
    provider: "codex",
    attemptedAt: now,
    fetchedAt: successCount > 0 ? now : (existing?.fetchedAt ?? null),
    nextFetchAt:
      errors.length > 0
        ? calculateNextFetchAt(now, failureCount, errors)
        : now + TRACKING_CACHE_MS,
    failureCount,
    lastHttpStatus:
      errors.map(errorStatus).find((status) => status !== null) ?? null,
    lastError:
      errors.length > 0 ? errors.map(safeErrorMessage).join("; ") : null,
    data,
  });
};

const saveClaudeSnapshot = (
  database: Database,
  account: SupportedTrackingAccount,
  existing: ProviderAccountTrackingRecord | null,
  result: PromiseSettledResult<
    Awaited<ReturnType<typeof fetchClaudeSubscriptionUsage>>
  >,
  now: number
) => {
  const previous: ClaudeTrackingData =
    existing?.data?.provider === "claude"
      ? existing.data
      : { provider: "claude" };
  if (result.status === "fulfilled") {
    return saveProviderAccountTracking(database, {
      providerAccountId: account.id,
      provider: "claude",
      attemptedAt: now,
      fetchedAt: now,
      nextFetchAt: now + TRACKING_CACHE_MS,
      failureCount: 0,
      lastHttpStatus: null,
      lastError: null,
      data: { ...previous, subscription: result.value },
    });
  }
  const failureCount = (existing?.failureCount ?? 0) + 1;
  return saveProviderAccountTracking(database, {
    providerAccountId: account.id,
    provider: "claude",
    attemptedAt: now,
    fetchedAt: existing?.fetchedAt ?? null,
    nextFetchAt: calculateNextFetchAt(now, failureCount, [result.reason]),
    failureCount,
    lastHttpStatus: errorStatus(result.reason),
    lastError: safeErrorMessage(result.reason),
    data: previous,
  });
};

const saveTrackingFailure = (
  database: Database,
  account: SupportedTrackingAccount,
  existing: ProviderAccountTrackingRecord | null,
  error: unknown,
  now: number
) => {
  const failureCount = (existing?.failureCount ?? 0) + 1;
  return saveProviderAccountTracking(database, {
    providerAccountId: account.id,
    provider: account.provider,
    attemptedAt: now,
    fetchedAt: existing?.fetchedAt ?? null,
    nextFetchAt: calculateNextFetchAt(now, failureCount, [error]),
    failureCount,
    lastHttpStatus: errorStatus(error),
    lastError: safeErrorMessage(error),
    data: existing?.data ?? { provider: account.provider },
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

  let account: SupportedTrackingAccount | null;
  try {
    account = await resolveTrackingAccount(database, providerAccountId, now);
  } catch (error) {
    return saveTrackingFailure(
      database,
      storedAccount,
      existing,
      error,
      Date.now()
    );
  }
  if (!account) {
    return null;
  }

  if (account.provider === "codex") {
    let results = await fetchCodexSnapshot(account);
    if (shouldRetryAuthorization(results)) {
      let refreshed: SupportedTrackingAccount | null;
      try {
        refreshed = await resolveTrackingAccount(
          database,
          providerAccountId,
          Date.now(),
          true
        );
      } catch (error) {
        return saveTrackingFailure(
          database,
          account,
          existing,
          error,
          Date.now()
        );
      }
      if (refreshed) {
        account = refreshed;
        results = await fetchCodexSnapshot(account);
      }
    }
    return saveCodexSnapshot(database, account, existing, results, Date.now());
  }

  let result = await Promise.allSettled([
    fetchClaudeSubscriptionUsage(account.accessToken),
  ]).then((results) => results[0]);
  if (!result) {
    throw new Error("Claude account tracking result is missing");
  }
  if (result.status === "rejected" && errorStatus(result.reason) === 401) {
    let refreshed: SupportedTrackingAccount | null;
    try {
      refreshed = await resolveTrackingAccount(
        database,
        providerAccountId,
        Date.now(),
        true
      );
    } catch (error) {
      return saveTrackingFailure(
        database,
        account,
        existing,
        error,
        Date.now()
      );
    }
    if (refreshed) {
      account = refreshed;
      result = await Promise.allSettled([
        fetchClaudeSubscriptionUsage(account.accessToken),
      ]).then((results) => results[0]);
      if (!result) {
        throw new Error("Claude account tracking retry result is missing");
      }
    }
  }
  return saveClaudeSnapshot(database, account, existing, result, Date.now());
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

const retryCodexOperationAfter401 = async <T>(input: {
  database: Database;
  account: SupportedTrackingAccount;
  operation: (account: SupportedTrackingAccount) => Promise<T>;
}): Promise<T> => {
  try {
    return await input.operation(input.account);
  } catch (error) {
    if (errorStatus(error) !== 401) {
      throw error;
    }
    const refreshed = await resolveTrackingAccount(
      input.database,
      input.account.id,
      Date.now(),
      true
    );
    if (!refreshed) {
      throw error;
    }
    return input.operation(refreshed);
  }
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
  const entries = await retryCodexOperationAfter401({
    database,
    account,
    operation: (current) =>
      fetchCodexThreadUsage(current.accessToken, current.accountId, threadIds),
  });
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
  input: { creditId?: string | null; redeemRequestId?: string | null }
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
  await saveCodexResetCreditRedemption(database, {
    redeemRequestId,
    providerAccountId,
    creditId: input.creditId ?? existing?.creditId ?? null,
    status: "pending",
    resultCode: null,
    windowsReset: null,
    lastError: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  try {
    const result = await retryCodexOperationAfter401({
      database,
      account,
      operation: (current) =>
        consumeCodexResetCredit({
          accessToken: current.accessToken,
          accountId: current.accountId,
          redeemRequestId,
          creditId: input.creditId ?? existing?.creditId ?? null,
        }),
    });
    await saveCodexResetCreditRedemption(database, {
      redeemRequestId,
      providerAccountId,
      creditId: input.creditId ?? existing?.creditId ?? null,
      status: "completed",
      resultCode: result.code,
      windowsReset: result.windowsReset,
      lastError: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: Date.now(),
    });
    if (result.code === "reset" || result.code === "already_redeemed") {
      await refreshProviderAccountTracking(database, providerAccountId, {
        force: true,
      });
    }
    return { redeemRequestId, ...result };
  } catch (error) {
    await saveCodexResetCreditRedemption(database, {
      redeemRequestId,
      providerAccountId,
      creditId: input.creditId ?? existing?.creditId ?? null,
      status: "retryable",
      resultCode: null,
      windowsReset: null,
      lastError: safeErrorMessage(error),
      createdAt: existing?.createdAt ?? now,
      updatedAt: Date.now(),
    });
    throw new CodexResetCreditConsumeError(
      safeErrorMessage(error),
      redeemRequestId
    );
  }
};
