import type { Database } from "../../db";
import {
  findCodexResetCreditRedemption,
  saveCodexResetCreditRedemption,
} from "../../db/repositories/codex-reset-redemptions";
import {
  findProviderAccountById,
  listProviderAccounts,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import {
  consumeCodexResetCredit,
  fetchCodexResetCredits,
  fetchCodexThreadUsage,
  fetchCodexUsageProfile,
  fetchCodexUsageStatus,
} from "../../providers/account-tracking/codex";
import {
  type ClaudeSubscriptionPlan,
  fetchClaudeSubscriptionPlan,
  fetchClaudeSubscriptionUsage,
} from "../../providers/account-tracking/claude";
import { AccountTrackingHttpError } from "../../providers/account-tracking/http";
import { errorLogFields, logWarn } from "../../utils/log";
import { refreshProviderAccount } from "./provider-service";

const CACHE_MS = 60_000;
const CLAUDE_CACHE_MS = 3 * 60_000;
const CLAUDE_RATE_LIMIT_BACKOFF_MS = [2, 4, 8, 15].map(
  (minutes) => minutes * 60_000
);
const CLAUDE_PLAN_CACHE_MS = 60 * 60 * 1000;
const CLAUDE_PLAN_RETRY_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

type TrackingAccount = ProviderAccountRecord & {
  provider: "codex" | "claude";
};

type CodexTrackingData = {
  provider: "codex";
  status?: Awaited<ReturnType<typeof fetchCodexUsageStatus>>;
  resetCredits?: Awaited<ReturnType<typeof fetchCodexResetCredits>>;
  profile?: Awaited<ReturnType<typeof fetchCodexUsageProfile>>;
};

type ClaudeTrackingData = {
  provider: "claude";
  plan?: ClaudeSubscriptionPlan | null;
  subscription?: Awaited<ReturnType<typeof fetchClaudeSubscriptionUsage>>;
};

type TrackingData = CodexTrackingData | ClaudeTrackingData;

export type AccountQuota = {
  fetchedAt: number | null;
  error: string | null;
  errorStatus: number | null;
  data: TrackingData;
};

const cache = new Map<string, { expiresAt: number; quota: AccountQuota }>();

// Anthropic rate-limits the usage endpoint per client, not per account: one
// 429 pauses usage checks for every Claude account, backing off until a check
// succeeds again. Retry-After is usually 0, so it can't be relied on.
const claudeRateLimit = { strikes: 0, until: 0 };

const noteClaudeUsageResult = (errors: unknown[]): void => {
  if (errors.some((error) => errorStatus(error) === 429)) {
    const backoff =
      CLAUDE_RATE_LIMIT_BACKOFF_MS[
        Math.min(
          claudeRateLimit.strikes,
          CLAUDE_RATE_LIMIT_BACKOFF_MS.length - 1
        )
      ] ?? CACHE_MS;
    claudeRateLimit.strikes++;
    claudeRateLimit.until =
      Date.now() + Math.max(backoff, cacheDuration(errors));
  } else if (!errors.length) {
    claudeRateLimit.strikes = 0;
    claudeRateLimit.until = 0;
  }
};
const inFlight = new Map<string, Promise<AccountQuota | null>>();
const generations = new Map<string, number>();

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

// The plan rarely changes, so it is looked up far less often than usage. A
// failed lookup keeps the last known plan and never fails the usage sync.
const claudePlans = new Map<
  string,
  { expiresAt: number; plan: ClaudeSubscriptionPlan | null }
>();

const getClaudePlan = async (
  account: TrackingAccount
): Promise<ClaudeSubscriptionPlan | null> => {
  const key = quotaKey(account);
  const cached = claudePlans.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.plan;
  }
  try {
    const plan = await fetchClaudeSubscriptionPlan(account.accessToken);
    claudePlans.set(key, {
      plan,
      expiresAt: Date.now() + CLAUDE_PLAN_CACHE_MS,
    });
    return plan;
  } catch (error) {
    logWarn("claude_account_plan_fetch_failed", {
      providerAccountId: account.id,
      ...errorLogFields(error),
    });
    const plan = cached?.plan ?? null;
    claudePlans.set(key, {
      plan,
      expiresAt:
        Date.now() + Math.max(CLAUDE_PLAN_RETRY_MS, cacheDuration([error])),
    });
    return plan;
  }
};

const fetchAccountData = async (
  database: Database,
  account: TrackingAccount
): Promise<{ data: TrackingData; errors: unknown[] }> => {
  if (account.provider === "claude") {
    const plan = getClaudePlan(account);
    try {
      const subscription = await retryAfter401(database, account, (current) =>
        fetchClaudeSubscriptionUsage(current.accessToken)
      );
      return {
        data: { provider: "claude", plan: await plan, subscription },
        errors: [],
      };
    } catch (error) {
      return {
        data: { provider: "claude", plan: await plan },
        errors: [error],
      };
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

// A failed check keeps whatever the last successful one returned, with its
// original time, so a transient failure never blanks the limits.
const toQuota = (
  data: TrackingData,
  errors: unknown[],
  now: number,
  previous?: AccountQuota
): AccountQuota => ({
  fetchedAt: errors.length ? (previous?.fetchedAt ?? null) : now,
  error: errors.length ? errors.map(errorMessage).join("; ") : null,
  errorStatus:
    errors.map(errorStatus).find((status) => status !== null) ?? null,
  data:
    errors.length && previous?.data.provider === data.provider
      ? ({ ...previous.data, ...data } as TrackingData)
      : data,
});

// Quotas belong to the provider identity, so a row whose OAuth identity changes
// never reuses another identity's snapshot or pending lookup.
const quotaKey = (account: TrackingAccount): string =>
  `${account.id}:${account.accountId ?? ""}`;

const nextGeneration = (key: string): number => {
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return generation;
};

const invalidateProviderAccountQuota = (account: TrackingAccount): void => {
  const key = quotaKey(account);
  cache.delete(key);
  inFlight.delete(key);
  nextGeneration(key);
};

const fetchProviderAccountQuota = async (
  database: Database,
  stored: TrackingAccount,
  key: string,
  generation: number
): Promise<AccountQuota | null> => {
  const now = Date.now();
  const previous = cache.get(key)?.quota;
  const publish = (quota: AccountQuota, expiresAt: number): AccountQuota => {
    // A lookup started later, or an invalidation, owns the cache entry.
    if (generations.get(key) === generation) {
      cache.set(key, { expiresAt, quota });
    }
    return quota;
  };
  const baseMs = stored.provider === "claude" ? CLAUDE_CACHE_MS : CACHE_MS;
  if (stored.provider === "claude" && claudeRateLimit.until > now) {
    const paused = new AccountTrackingHttpError(
      "Claude subscription usage request failed (429)",
      429,
      null
    );
    return publish(
      toQuota({ provider: "claude" }, [paused], now, previous),
      claudeRateLimit.until
    );
  }
  try {
    const account = await resolveAccount(database, stored);
    if (!account) {
      return null;
    }
    const result = await fetchAccountData(database, account);
    let expiresAt = now + Math.max(baseMs, cacheDuration(result.errors));
    if (account.provider === "claude") {
      noteClaudeUsageResult(result.errors);
      if (claudeRateLimit.until > now) expiresAt = claudeRateLimit.until;
    }
    return publish(
      toQuota(result.data, result.errors, now, previous),
      expiresAt
    );
  } catch (error) {
    return publish(
      toQuota({ provider: stored.provider }, [error], now, previous),
      now + Math.max(baseMs, cacheDuration([error]))
    );
  }
};

const loadProviderAccountQuota = (
  database: Database,
  stored: TrackingAccount,
  force: boolean
): Promise<AccountQuota | null> => {
  const key = quotaKey(stored);
  const pending = inFlight.get(key);
  if (pending && !force) {
    return pending;
  }
  const request = fetchProviderAccountQuota(
    database,
    stored,
    key,
    nextGeneration(key)
  ).finally(() => {
    if (inFlight.get(key) === request) {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, request);
  return request;
};

// Live quota lookups take seconds, so an expired snapshot is returned at once
// and refreshed in the background. The UI shows when each snapshot was synced.
const getProviderAccountQuota = (
  database: Database,
  stored: TrackingAccount,
  force = false
): Promise<AccountQuota | null> => {
  const cached = cache.get(quotaKey(stored));
  if (force || !cached) {
    return loadProviderAccountQuota(database, stored, force);
  }
  if (cached.expiresAt <= Date.now()) {
    loadProviderAccountQuota(database, stored, false).catch(() => undefined);
  }
  return Promise.resolve(cached.quota);
};

// Returns whatever snapshot is cached, without waiting on providers, and
// starts a lookup for accounts that have none or whose snapshot is stale.
export const peekProviderAccountQuotas = (
  database: Database,
  providerAccounts: readonly ProviderAccountRecord[]
): Map<string, AccountQuota | null> => {
  const quotas = new Map<string, AccountQuota | null>();
  for (const account of providerAccounts.filter(isTrackingAccount)) {
    const cached = cache.get(quotaKey(account));
    if (!cached || cached.expiresAt <= Date.now()) {
      loadProviderAccountQuota(database, account, false).catch(() => undefined);
    }
    quotas.set(account.id, cached?.quota ?? null);
  }
  return quotas;
};

// A fresh process (every deploy) starts with no snapshots; loading them right
// away means the first admin visit does not wait on providers.
export const warmProviderAccountQuotas = async (
  database: Database
): Promise<void> => {
  peekProviderAccountQuotas(database, await listProviderAccounts(database));
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
    invalidateProviderAccountQuota(account);
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
