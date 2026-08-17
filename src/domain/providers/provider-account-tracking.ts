import type { Database } from "../../db";
import {
  findCodexResetCreditRedemption,
  saveCodexResetCreditRedemption,
} from "../../db/repositories/codex-reset-redemptions";
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

const CACHE_MS = 60_000;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

type TrackingAccount = ProviderAccountRecord & {
  provider: "codex" | "claude";
};

type CodexTrackingData = {
  provider: "codex";
  status?: Awaited<ReturnType<typeof fetchCodexUsageStatus>>;
  resetCredits?: Awaited<ReturnType<typeof fetchCodexResetCredits>>;
  profile?: Awaited<ReturnType<typeof fetchCodexUsageProfile>>;
  accounts?: Awaited<ReturnType<typeof fetchCodexAccounts>>;
};

type ClaudeTrackingData = {
  provider: "claude";
  subscription?: Awaited<ReturnType<typeof fetchClaudeSubscriptionUsage>>;
};

type TrackingData = CodexTrackingData | ClaudeTrackingData;

export type AccountQuota = {
  fetchedAt: number | null;
  error: string | null;
  data: TrackingData;
};

const cache = new Map<string, { expiresAt: number; quota: AccountQuota }>();

const isTrackingAccount = (
  account: ProviderAccountRecord
): account is TrackingAccount =>
  account.provider === "codex" || account.provider === "claude";

const errorMessage = (error: unknown): string => {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "Account tracking request timed out";
  }
  return error instanceof Error ? error.message : "Account tracking failed";
};

const errorStatus = (error: unknown): number | null =>
  error instanceof AccountTrackingHttpError ? error.status : null;

const cacheDuration = (errors: unknown[]): number =>
  Math.max(
    CACHE_MS,
    ...errors.map((error) =>
      error instanceof AccountTrackingHttpError ? (error.retryAfterMs ?? 0) : 0
    )
  );

const resolveAccount = async (
  database: Database,
  account: TrackingAccount,
  forceRefresh = false
): Promise<TrackingAccount | null> => {
  if (
    !forceRefresh &&
    account.expiresAt > Date.now() + TOKEN_EXPIRY_MARGIN_MS
  ) {
    return account;
  }
  const refreshed = await refreshProviderAccount(
    database,
    account.id,
    Date.now(),
    { force: true }
  );
  return refreshed && isTrackingAccount(refreshed) ? refreshed : null;
};

const retryAfter401 = async <T>(
  database: Database,
  account: TrackingAccount,
  operation: (current: TrackingAccount) => Promise<T>
): Promise<T> => {
  try {
    return await operation(account);
  } catch (error) {
    if (errorStatus(error) !== 401) {
      throw error;
    }
    const refreshed = await resolveAccount(database, account, true);
    if (!refreshed) {
      throw error;
    }
    return operation(refreshed);
  }
};

const codexFetchers = [
  ["status", fetchCodexUsageStatus],
  ["resetCredits", fetchCodexResetCredits],
  ["profile", fetchCodexUsageProfile],
  ["accounts", fetchCodexAccounts],
] as const;

const fetchCodexData = async (account: TrackingAccount) => {
  const results = await Promise.allSettled(
    codexFetchers.map(([, fetcher]) =>
      fetcher(account.accessToken, account.accountId)
    )
  );
  const data: CodexTrackingData = { provider: "codex" };
  const errors: unknown[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      Object.assign(data, {
        [codexFetchers[index]?.[0] ?? "status"]: result.value,
      });
    } else {
      errors.push(result.reason);
    }
  }
  return { data, errors };
};

const fetchAccountData = async (
  database: Database,
  account: TrackingAccount
): Promise<{ data: TrackingData; errors: unknown[] }> => {
  if (account.provider === "claude") {
    try {
      const subscription = await retryAfter401(database, account, (current) =>
        fetchClaudeSubscriptionUsage(current.accessToken)
      );
      return { data: { provider: "claude", subscription }, errors: [] };
    } catch (error) {
      return { data: { provider: "claude" }, errors: [error] };
    }
  }

  let result = await fetchCodexData(account);
  if (result.errors.some((error) => errorStatus(error) === 401)) {
    const refreshed = await resolveAccount(database, account, true);
    if (refreshed) {
      result = await fetchCodexData(refreshed);
    }
  }
  return result;
};

const toQuota = (
  data: TrackingData,
  errors: unknown[],
  now: number
): AccountQuota => ({
  fetchedAt: errors.length ? null : now,
  error: errors.length ? errors.map(errorMessage).join("; ") : null,
  data,
});

const getProviderAccountQuota = async (
  database: Database,
  stored: TrackingAccount,
  force = false
): Promise<AccountQuota | null> => {
  const cached = cache.get(stored.id);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.quota;
  }
  const now = Date.now();
  try {
    const account = await resolveAccount(database, stored);
    if (!account) {
      return null;
    }
    const result = await fetchAccountData(database, account);
    const quota = toQuota(result.data, result.errors, now);
    cache.set(account.id, {
      expiresAt: now + cacheDuration(result.errors),
      quota,
    });
    return quota;
  } catch (error) {
    const quota = toQuota({ provider: stored.provider }, [error], now);
    cache.set(stored.id, {
      expiresAt: now + cacheDuration([error]),
      quota,
    });
    return quota;
  }
};

export const listProviderAccountQuotas = async (
  database: Database,
  providerAccounts: readonly ProviderAccountRecord[]
) => {
  const accounts = providerAccounts.filter(isTrackingAccount);
  const quotas = await Promise.all(
    accounts.map((account) => getProviderAccountQuota(database, account))
  );
  return new Map(
    accounts.map((account, index) => [account.id, quotas[index] ?? null])
  );
};

export const queryCodexThreadUsage = async (
  database: Database,
  providerAccountId: string,
  threadIds: readonly string[]
) => {
  const stored = await findProviderAccountById(database, providerAccountId);
  if (!stored || !isTrackingAccount(stored) || stored.provider !== "codex") {
    return null;
  }
  const account = await resolveAccount(database, stored);
  if (!account) {
    return null;
  }
  return retryAfter401(database, account, (current) =>
    fetchCodexThreadUsage(current.accessToken, current.accountId, threadIds)
  );
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
  const stored = await findProviderAccountById(database, providerAccountId);
  if (!stored || !isTrackingAccount(stored) || stored.provider !== "codex") {
    return null;
  }
  const account = await resolveAccount(database, stored);
  if (!account) {
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
  const save = (
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
  await save("pending", null, null, null);

  try {
    const result = await retryAfter401(database, account, (current) =>
      consumeCodexResetCredit({
        accessToken: current.accessToken,
        accountId: current.accountId,
        redeemRequestId,
        creditId,
      })
    );
    await save("completed", result.code, result.windowsReset, null);
    cache.delete(providerAccountId);
    if (result.code === "reset" || result.code === "already_redeemed") {
      await getProviderAccountQuota(database, account, true);
    }
    return { redeemRequestId, ...result };
  } catch (error) {
    const message = errorMessage(error);
    await save("retryable", null, null, message);
    throw new CodexResetCreditConsumeError(message, redeemRequestId);
  }
};
