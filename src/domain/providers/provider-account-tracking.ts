import type { Database } from "../../db";
import type { ClaudeResetClaimIdentity } from "../../db/repositories/claude-reset-claims";
import {
  findCodexResetCreditRedemption,
  saveCodexResetCreditRedemption,
} from "../../db/repositories/codex-reset-redemptions";
import {
  listProviderAccountsWithSnapshots,
  type ProviderAccountSnapshotRow,
} from "../../db/repositories/provider-account-snapshots";
import {
  findProviderAccountById,
  listProviderAccounts,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import {
  type CodexAccounts,
  consumeCodexResetCredit,
  fetchCodexAccounts,
  fetchCodexResetCredits,
  fetchCodexThreadUsage,
  fetchCodexUsageProfile,
  fetchCodexUsageStatus,
} from "../../providers/account-tracking/codex";
import {
  type ClaudeAccountProfile,
  type ClaudeSubscriptionPlan,
  type ClaudeSubscriptionUsage,
  fetchClaudeAccountProfile,
  fetchClaudeSubscriptionUsage,
} from "../../providers/account-tracking/claude";
import {
  type ClaudeResetLimitUsage,
  type ClaudeResetStatus,
  claudeResetLimitTypes,
} from "../../providers/account-tracking/claude-resets";
import { AccountTrackingHttpError } from "../../providers/account-tracking/http";
import {
  type ClaudeLiveLimits,
  type LiveLimits,
  mergeClaudeLiveLimits,
  mergeCodexLiveLimits,
} from "../../providers/account-tracking/live-limits";
import { errorLogFields, logWarn } from "../../utils/log";
import type {
  AccountSnapshotStore,
  QuotaSignature,
} from "./account-snapshot-store";
import {
  refreshProviderAccount,
  refreshProviderAccountAfterAuthFailure,
} from "./provider-service";

const CACHE_MS = 60_000;
const CLAUDE_CACHE_MS = 3 * 60_000;
const CLAUDE_RATE_LIMIT_BACKOFF_MS = [2, 4, 8, 15].map(
  (minutes) => minutes * 60_000
);
const PROFILE_CACHE_MS = 24 * 60 * 60 * 1000;
const PROFILE_CACHE_JITTER_MS = 60 * 60 * 1000;
const PROFILE_RETRY_MS = 5 * 60 * 1000;
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export type TrackingAccount = ProviderAccountRecord & {
  provider: "codex" | "claude";
};

type CodexTrackingData = {
  provider: "codex";
  status?: Awaited<ReturnType<typeof fetchCodexUsageStatus>>;
  resetCredits?: Awaited<ReturnType<typeof fetchCodexResetCredits>>;
  profile?: Awaited<ReturnType<typeof fetchCodexUsageProfile>>;
};

// Saved limit resets keep their own read time: limits from proxied traffic
// refresh the quota, never the resets.
export type ClaudeResetCredits = {
  observedAt: number;
  credential: string;
  status: ClaudeResetStatus;
};

type ClaudeTrackingData = {
  provider: "claude";
  plan?: ClaudeSubscriptionPlan | null;
  subscription?: ClaudeSubscriptionUsage;
  resetCredits?: ClaudeResetCredits;
};

type TrackingData = CodexTrackingData | ClaudeTrackingData;

export type AccountQuota = {
  fetchedAt: number | null;
  error: string | null;
  errorStatus: number | null;
  // "traffic" when the limits were last read from a proxied response. Not
  // persisted: limits restored after a restart report null.
  source: "poll" | "traffic" | null;
  data: TrackingData;
};

type QuotaEntry = {
  expiresAt: number;
  // Live traffic cannot postpone reset discovery.
  resetPollAt: number;
  credential: string;
  quota: AccountQuota;
};
const cache = new Map<string, QuotaEntry>();

const credentialBinding = (account: ProviderAccountRecord): string =>
  Bun.CryptoHasher.hash("sha256", account.accessToken, "hex");

// Live readings that arrive while a usage attempt runs are newer than its
// result. Each attempt collects them for its own credential and generation.
const claudeLiveDuringPoll = new Map<
  string,
  { credential: string; generation: number; readings: ClaudeLiveLimits[] }
>();

let snapshots: AccountSnapshotStore | null = null;
let snapshotsRestored: Promise<void> = Promise.resolve();

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

export const isTrackingAccount = (
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

export const resolveAccount = async (
  database: Database,
  account: TrackingAccount
): Promise<TrackingAccount | null> => {
  if (account.expiresAt > Date.now() + TOKEN_EXPIRY_MARGIN_MS) {
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

const replaceRejectedAccount = async (
  database: Database,
  account: TrackingAccount
): Promise<TrackingAccount | null> => {
  const refreshed = await refreshProviderAccountAfterAuthFailure(
    database,
    account.id,
    account.accessToken
  );
  return refreshed &&
    refreshed.accessToken !== account.accessToken &&
    isTrackingAccount(refreshed)
    ? refreshed
    : null;
};

export const retryAfter401 = async <T>(
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
    const refreshed = await replaceRejectedAccount(database, account);
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

export type CodexAccountProfile = {
  planType: string | null;
  workspacePlanType: string | null;
  workspaceName: string | null;
  structure: string | null;
  role: string | null;
  displayName: string | null;
  username: string | null;
};

export type AccountProfile =
  | ({ provider: "claude" } & ClaudeAccountProfile)
  | ({ provider: "codex" } & CodexAccountProfile);

type ProfileEntry = {
  profile: AccountProfile | null;
  fetchedAt: number | null;
  error: string | null;
  expiresAt: number;
  // The token response's organization when the profile was looked up; a
  // different one means the account moved and the profile is out of date.
  organizationKey: string | null;
  lookupCredential: string | null;
  // Display data can survive a failed lookup; identity proof cannot change hands.
  identityCredential: string | null;
};

// Plans and profiles rarely change, so they are looked up once a day (spread
// over an hour so accounts don't all come due together), and the last lookup
// survives restarts through the snapshot table. A failed lookup keeps the last
// known profile and never fails the usage sync.
const profiles = new Map<string, ProfileEntry>();

const profileExpiry = (fetchedAt: number): number =>
  fetchedAt + PROFILE_CACHE_MS - Math.random() * PROFILE_CACHE_JITTER_MS;

const claudeOrganizationKey = (account: TrackingAccount): string | null => {
  const metadata = account.metadata;
  if (metadata?.provider !== "claude" || !metadata.organizationUuid) {
    return null;
  }
  return `${metadata.organizationUuid}|${metadata.organizationName ?? ""}|${metadata.accountUuid ?? ""}`;
};

const profileOrganizationKey = (
  profile: AccountProfile | null
): string | null =>
  profile?.provider === "claude" && profile.organizationUuid
    ? `${profile.organizationUuid}|${profile.organizationName ?? ""}|${profile.accountUuid ?? ""}`
    : null;

const getClaudeProfile = async (
  account: TrackingAccount
): Promise<ClaudeAccountProfile | null> => {
  const key = quotaKey(account);
  const cached = profiles.get(key);
  const previous =
    cached?.profile?.provider === "claude" ? cached.profile : null;
  const organizationKey = claudeOrganizationKey(account);
  const credential = credentialBinding(account);
  const organizationChanged =
    organizationKey !== null && cached?.organizationKey !== organizationKey;
  if (
    cached &&
    cached.expiresAt > Date.now() &&
    !organizationChanged &&
    cached.lookupCredential === credential
  ) {
    return previous;
  }
  try {
    const profile: AccountProfile = {
      provider: "claude",
      ...(await fetchClaudeAccountProfile(account.accessToken, previous)),
    };
    const fetchedAt = Date.now();
    profiles.set(key, {
      profile,
      fetchedAt,
      error: null,
      expiresAt: profileExpiry(fetchedAt),
      organizationKey: organizationKey ?? profileOrganizationKey(profile),
      lookupCredential: credential,
      identityCredential: credential,
    });
    snapshots?.recordProfile(account, profile, fetchedAt);
    return profile;
  } catch (error) {
    logWarn("claude_account_plan_fetch_failed", {
      provider: account.provider,
      status: errorStatus(error),
      providerAccountId: account.id,
      ...errorLogFields(error),
    });
    profiles.set(key, {
      profile: cached?.profile ?? null,
      fetchedAt: cached?.fetchedAt ?? null,
      error: errorMessage(error),
      expiresAt:
        Date.now() + Math.max(PROFILE_RETRY_MS, cacheDuration([error])),
      organizationKey: organizationKey ?? cached?.organizationKey ?? null,
      lookupCredential: credential,
      identityCredential: cached?.identityCredential ?? null,
    });
    return previous;
  }
};

const pickCodexAccount = (
  accounts: CodexAccounts,
  accountId: string | null
): CodexAccounts["accounts"][number] | null =>
  accounts.accounts.find((entry) => entry.id === accountId) ??
  (accountId
    ? null
    : (accounts.accounts.find(
        (entry) => entry.id === accounts.defaultAccountId
      ) ?? null));

const emptyCodexProfile: CodexAccountProfile = {
  planType: null,
  workspacePlanType: null,
  workspaceName: null,
  structure: null,
  role: null,
  displayName: null,
  username: null,
};

// /wham/usage reports the plan on every sync; when it differs from the stored
// one the workspace is looked up again instead of waiting for the daily check.
// The name and username come with the usage profile, at no extra cost.
const updateCodexProfile = async (
  account: TrackingAccount,
  data: CodexTrackingData
): Promise<void> => {
  const key = quotaKey(account);
  const cached = profiles.get(key);
  const previous =
    cached?.profile?.provider === "codex" ? cached.profile : null;
  const usagePlan = data.status?.planType ?? null;
  let next: CodexAccountProfile = previous ?? emptyCodexProfile;
  let fetchedAt = cached?.fetchedAt ?? null;
  let expiresAt = cached?.expiresAt ?? 0;
  let profileError = cached?.error ?? null;
  const planChanged =
    usagePlan !== null && previous !== null && previous.planType !== usagePlan;
  if (expiresAt <= Date.now() || planChanged) {
    try {
      const entry = pickCodexAccount(
        await fetchCodexAccounts(account.accessToken, account.accountId),
        account.accountId
      );
      next = {
        ...next,
        workspacePlanType: entry?.planType ?? null,
        workspaceName: entry?.name ?? null,
        structure: entry?.structure ?? null,
        role: entry?.role ?? null,
      };
      fetchedAt = Date.now();
      expiresAt = profileExpiry(fetchedAt);
      profileError = null;
    } catch (error) {
      profileError = errorMessage(error);
      logWarn("codex_account_profile_fetch_failed", {
        provider: account.provider,
        status: errorStatus(error),
        providerAccountId: account.id,
        ...errorLogFields(error),
      });
      expiresAt =
        Date.now() + Math.max(PROFILE_RETRY_MS, cacheDuration([error]));
    }
  }
  next = {
    ...next,
    planType: usagePlan ?? next.planType,
    displayName: data.profile?.displayName ?? next.displayName,
    username: data.profile?.username ?? next.username,
  };
  const profile: AccountProfile = { provider: "codex", ...next };
  profiles.set(key, {
    profile,
    fetchedAt,
    error: profileError,
    expiresAt,
    organizationKey: null,
    lookupCredential: null,
    identityCredential: null,
  });
  if (
    fetchedAt !== (cached?.fetchedAt ?? null) ||
    JSON.stringify(profile) !== JSON.stringify(cached?.profile ?? null)
  ) {
    snapshots?.recordProfile(account, profile, fetchedAt);
  }
};

const fetchAccountData = async (
  database: Database,
  account: TrackingAccount,
  now: number,
  observeClaudeUsage: (current: TrackingAccount) => ClaudeLiveLimits[]
): Promise<{
  data: TrackingData;
  errors: unknown[];
  live?: ClaudeLiveLimits[];
}> => {
  if (account.provider === "claude") {
    const plan = getClaudeProfile(account).then(
      (profile) => profile?.plan ?? null
    );
    try {
      const { usage, resets, credential, live } = await retryAfter401(
        database,
        account,
        async (current) => {
          const live = observeClaudeUsage(current);
          return {
            ...(await fetchClaudeSubscriptionUsage(current.accessToken)),
            credential: credentialBinding(current),
            live,
          };
        }
      );
      return {
        data: {
          provider: "claude",
          plan: await plan,
          subscription: usage,
          ...(resets && {
            resetCredits: { observedAt: now, credential, status: resets },
          }),
        },
        errors: [],
        live,
      };
    } catch (error) {
      return {
        data: { provider: "claude", plan: await plan },
        errors: [error],
      };
    }
  }

  let current = account;
  let result = await fetchCodexData(account);
  if (result.errors.some((error) => errorStatus(error) === 401)) {
    const refreshed = await replaceRejectedAccount(database, account);
    if (refreshed) {
      current = refreshed;
      result = await fetchCodexData(refreshed);
    }
  }
  await updateCodexProfile(current, result.data);
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
  source: errors.length ? (previous?.source ?? null) : "poll",
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

const dropCachedResetCredits = (key: string): void => {
  const entry = cache.get(key);
  if (
    entry?.quota.data.provider === "claude" &&
    entry.quota.data.resetCredits
  ) {
    const { resetCredits: _dropped, ...data } = entry.quota.data;
    cache.set(key, { ...entry, quota: { ...entry.quota, data } });
  }
};

const fetchProviderAccountQuota = async (
  database: Database,
  stored: TrackingAccount,
  key: string,
  generation: number
): Promise<AccountQuota | null> => {
  const now = Date.now();
  let credential = credentialBinding(stored);
  // Limits read from proxied traffic while this lookup ran are newer than
  // what was cached when it started.
  const latest = (): AccountQuota | undefined => cache.get(key)?.quota;
  const publish = (quota: AccountQuota, expiresAt: number): AccountQuota => {
    // A lookup started later, or an invalidation, owns the cache entry.
    if (generations.get(key) === generation) {
      cache.set(key, { expiresAt, resetPollAt: expiresAt, credential, quota });
      snapshots?.recordQuota(stored, quota, quotaSignature(quota.data));
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
      toQuota({ provider: "claude" }, [paused], now, latest()),
      claudeRateLimit.until
    );
  }
  try {
    const account = await resolveAccount(database, stored);
    if (!account) {
      return null;
    }
    credential = credentialBinding(account);
    const result = await fetchAccountData(database, account, now, (current) => {
      credential = credentialBinding(current);
      const readings: ClaudeLiveLimits[] = [];
      if (generations.get(key) === generation) {
        claudeLiveDuringPoll.set(key, { credential, generation, readings });
      }
      return readings;
    });
    const previous = latest()?.data;
    if (result.data.provider === "claude") {
      if (result.data.subscription && result.live) {
        result.data.subscription = result.live.reduce(
          mergeClaudeLiveLimits,
          result.data.subscription
        );
      }
      // A read without the resets block was not evaluated for resets, so the
      // last known ones stay, with their own read time.
      if (
        previous?.provider === "claude" &&
        previous.resetCredits?.credential === credential
      ) {
        result.data.resetCredits ??= previous.resetCredits;
      }
    }
    let expiresAt = now + Math.max(baseMs, cacheDuration(result.errors));
    if (account.provider === "claude") {
      noteClaudeUsageResult(result.errors);
      if (claudeRateLimit.until > now) expiresAt = claudeRateLimit.until;
    }
    return publish(
      toQuota(result.data, result.errors, now, latest()),
      expiresAt
    );
  } catch (error) {
    return publish(
      toQuota({ provider: stored.provider }, [error], now, latest()),
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
      claudeLiveDuringPoll.delete(key);
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
  if (quotaRefreshDue(stored, cached)) {
    loadProviderAccountQuota(database, stored, false).catch(() => undefined);
  }
  return Promise.resolve(cached.quota);
};

const quotaRefreshDue = (
  account: TrackingAccount,
  entry: QuotaEntry
): boolean =>
  entry.expiresAt <= Date.now() ||
  (account.provider === "claude" &&
    (entry.credential !== credentialBinding(account) ||
      entry.resetPollAt <= Date.now()));

const toResetTimestamp = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const quotaSignature = (data: TrackingData): QuotaSignature => {
  if (data.provider === "claude") {
    const subscription = data.subscription;
    const windows = [
      subscription?.fiveHour,
      subscription?.sevenDay,
      ...Object.values(subscription?.modelWindows ?? {}),
    ];
    return {
      plan: data.plan?.type ?? null,
      resets: windows
        .map((window) => toResetTimestamp(window?.resetsAt))
        .filter((value) => value !== null),
    };
  }
  const status = data.status;
  const windows = [
    status?.primaryWindow,
    status?.secondaryWindow,
    ...(status?.additionalRateLimits ?? []).flatMap((limit) => [
      limit.primaryWindow,
      limit.secondaryWindow,
    ]),
  ];
  return {
    plan: status?.planType ?? null,
    resets: windows
      .map((window) => toResetTimestamp(window?.resetAt))
      .filter((value) => value !== null),
  };
};

const parseJson = (value: string | null): unknown => {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const restoreSnapshot = (
  account: TrackingAccount,
  row: ProviderAccountSnapshotRow
): void => {
  const key = quotaKey(account);
  const profile = parseJson(row.profileJson) as AccountProfile | null;
  const restoredProfile =
    profile?.provider === account.provider ? profile : null;
  if (restoredProfile && !profiles.has(key)) {
    profiles.set(key, {
      profile: restoredProfile,
      fetchedAt: row.profileFetchedAt,
      error: null,
      expiresAt: row.profileFetchedAt ? profileExpiry(row.profileFetchedAt) : 0,
      organizationKey: profileOrganizationKey(restoredProfile),
      lookupCredential: credentialBinding(account),
      identityCredential: null,
    });
  }

  const data = parseJson(row.quotaJson) as TrackingData | null;
  if (data?.provider !== account.provider) {
    snapshots?.seed(account.id, row.updatedAt, null);
    return;
  }
  if (data.provider === "claude" && restoredProfile?.provider === "claude") {
    data.plan = restoredProfile.plan;
  }
  const baseMs = account.provider === "claude" ? CLAUDE_CACHE_MS : CACHE_MS;
  if (!cache.has(key)) {
    cache.set(key, {
      // Restored limits count as fresh only for what is left of the usual
      // interval since they were fetched, so normal refreshes continue.
      expiresAt: (row.quotaFetchedAt ?? 0) + baseMs,
      resetPollAt:
        (data.provider === "claude"
          ? (data.resetCredits?.observedAt ?? row.quotaFetchedAt ?? 0)
          : 0) + baseMs,
      credential:
        data.provider === "claude" && data.resetCredits
          ? data.resetCredits.credential
          : credentialBinding(account),
      quota: {
        fetchedAt: row.quotaFetchedAt,
        error: row.lastError,
        errorStatus: row.lastErrorStatus,
        source: null,
        data,
      },
    });
  }
  snapshots?.seed(account.id, row.updatedAt, quotaSignature(data));
};

// Loads the last stored profiles and limits, so a fresh process shows them at
// once and only asks providers for what is out of date. Returns the accounts
// so warming does not read them again.
export const setAccountSnapshotStore = (
  store: AccountSnapshotStore | null
): void => {
  snapshots = store;
};

export const restoreProviderAccountSnapshots = (
  database: Database,
  store: AccountSnapshotStore
): Promise<ProviderAccountRecord[] | null> => {
  setAccountSnapshotStore(store);
  const restored = (async () => {
    try {
      const result = await listProviderAccountsWithSnapshots(database);
      const accounts = new Map(
        result.accounts
          .filter(isTrackingAccount)
          .map((account) => [account.id, account])
      );
      for (const row of result.snapshots) {
        const account = accounts.get(row.providerAccountId);
        if (account && row.accountIdentity === (account.accountId ?? "")) {
          restoreSnapshot(account, row);
        }
      }
      return result.accounts;
    } catch (error) {
      logWarn("account_snapshot_restore_failed", errorLogFields(error));
      return null;
    }
  })();
  snapshotsRestored = restored.then(() => undefined);
  return restored;
};

export const providerAccountSnapshotsRestored = (): Promise<void> =>
  snapshotsRestored;

// After a reauthorization or an admin refresh, the next sync looks the
// profile up again and does not wait out the usual interval for limits.
export const expireProviderAccountTracking = (
  providerAccountId: string
): void => {
  const prefix = `${providerAccountId}:`;
  for (const [key, entry] of profiles) {
    if (key.startsWith(prefix)) {
      entry.expiresAt = 0;
      entry.identityCredential = null;
      entry.lookupCredential = null;
    }
  }
  for (const [key, entry] of cache) {
    if (key.startsWith(prefix)) {
      entry.expiresAt = 0;
      entry.resetPollAt = 0;
      dropCachedResetCredits(key);
      inFlight.delete(key);
      nextGeneration(key);
    }
  }
};

export const peekProviderAccountProfiles = (
  providerAccounts: readonly ProviderAccountRecord[]
): Map<
  string,
  {
    fetchedAt: number | null;
    error: string | null;
    data: AccountProfile;
  } | null
> =>
  new Map(
    providerAccounts.filter(isTrackingAccount).map((account) => {
      const entry = profiles.get(quotaKey(account));
      return [
        account.id,
        entry?.profile
          ? {
              fetchedAt: entry.fetchedAt,
              error: entry.error,
              data: entry.profile,
            }
          : null,
      ];
    })
  );

// Returns whatever snapshot is cached, without waiting on providers, and
// starts a lookup for accounts that have none or whose snapshot is stale.
export const peekProviderAccountQuotas = (
  database: Database,
  providerAccounts: readonly ProviderAccountRecord[]
): Map<string, AccountQuota | null> => {
  const quotas = new Map<string, AccountQuota | null>();
  for (const account of providerAccounts.filter(isTrackingAccount)) {
    const cached = cache.get(quotaKey(account));
    if (!cached || quotaRefreshDue(account, cached)) {
      loadProviderAccountQuota(database, account, false).catch(() => undefined);
    }
    quotas.set(account.id, cached?.quota ?? null);
  }
  return quotas;
};

const mergeLiveLimits = (
  previous: TrackingData | undefined,
  limits: LiveLimits,
  now: number
): TrackingData => {
  if (limits.provider === "claude") {
    const base = previous?.provider === "claude" ? previous : undefined;
    return {
      ...base,
      provider: "claude",
      subscription: mergeClaudeLiveLimits(base?.subscription, limits),
    };
  }
  const base = previous?.provider === "codex" ? previous : undefined;
  return {
    ...base,
    provider: "codex",
    status: mergeCodexLiveLimits(base?.status, limits, now),
  };
};

// Traffic refreshes ordinary limits, but Claude reset discovery keeps its
// own due time. This hot path only updates memory and buffered snapshots.
export const recordProviderAccountLiveLimits = (
  account: ProviderAccountRecord,
  limits: LiveLimits | null
): void => {
  if (
    !(limits && isTrackingAccount(account)) ||
    account.provider !== limits.provider
  ) {
    return;
  }
  try {
    const key = quotaKey(account);
    const now = Date.now();
    const cached = cache.get(key);
    const credential = credentialBinding(account);
    const entry = cached?.credential === credential ? cached : undefined;
    const poll = claudeLiveDuringPoll.get(key);
    if (
      limits.provider === "claude" &&
      poll?.credential === credential &&
      poll.generation === generations.get(key)
    ) {
      poll.readings.push(limits);
    }
    const quota: AccountQuota = {
      fetchedAt: now,
      error: null,
      errorStatus: null,
      source: "traffic",
      data: mergeLiveLimits(entry?.quota.data, limits, now),
    };
    const baseMs = account.provider === "claude" ? CLAUDE_CACHE_MS : CACHE_MS;
    cache.set(key, {
      quota,
      credential,
      resetPollAt: entry?.resetPollAt ?? now,
      // Without an earlier poll the plan and the limits only the usage
      // endpoints report are missing, so the next read still polls.
      expiresAt: entry ? Math.max(entry.expiresAt, now + baseMs) : now,
    });
    snapshots?.recordQuota(account, quota, quotaSignature(quota.data));
  } catch (error) {
    logWarn("provider_account_live_limits_failed", {
      provider: account.provider,
      providerAccountId: account.id,
      ...errorLogFields(error),
    });
  }
};

// A fresh process (every deploy) starts with no snapshots; loading them right
// away means the first admin visit does not wait on providers.
export const warmProviderAccountQuotas = async (
  database: Database,
  accounts?: readonly ProviderAccountRecord[] | null
): Promise<void> => {
  peekProviderAccountQuotas(
    database,
    accounts ?? (await listProviderAccounts(database))
  );
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

const agreedUuid = (
  stored: string | null | undefined,
  lookedUp: string | null | undefined
): string | null => {
  const [a, b] = [stored, lookedUp].map(
    (value) => value?.trim().toLowerCase() || null
  );
  return a && b && a !== b ? null : (b ?? a ?? null);
};

// Reset claims use the OAuth user and organization of the current credential,
// from its token response or a profile looked up with it; both must agree.
export const claudeResetIdentity = (
  account: TrackingAccount
): ClaudeResetClaimIdentity | null => {
  const metadata =
    account.metadata?.provider === "claude" ? account.metadata : null;
  const entry = profiles.get(quotaKey(account));
  const profile =
    entry?.identityCredential === credentialBinding(account) &&
    entry.profile?.provider === "claude"
      ? entry.profile
      : null;
  const organizationUuid = agreedUuid(
    metadata?.organizationUuid,
    profile?.organizationUuid
  );
  const accountIdentity = agreedUuid(
    metadata?.accountUuid,
    profile?.accountUuid
  );
  return organizationUuid && accountIdentity
    ? { accountIdentity, organizationUuid }
    : null;
};

export const peekClaudeResetCredits = (
  account: TrackingAccount
): ClaudeResetCredits | null => {
  const data = cache.get(quotaKey(account))?.quota.data;
  const credits = data?.provider === "claude" ? data.resetCredits : null;
  return credits?.credential === credentialBinding(account) ? credits : null;
};

// Current use of each limit a reset could refill, from the latest polled and
// live limits. A window whose reset time has passed counts as unused.
export const claudeResetLimitUsage = (
  account: TrackingAccount,
  credits: ClaudeResetCredits,
  now: number
): ClaudeResetLimitUsage => {
  const entry = cache.get(quotaKey(account));
  const data =
    entry &&
    [credentialBinding(account), credits.credential].includes(entry.credential)
      ? entry.quota.data
      : null;
  const usage = data?.provider === "claude" ? data.subscription : null;
  const windows: Record<
    string,
    ClaudeSubscriptionUsage["fiveHour"] | undefined
  > = {
    ...usage?.modelWindows,
    five_hour: usage?.fiveHour,
    seven_day: usage?.sevenDay,
  };
  const used: ClaudeResetLimitUsage = {};
  for (const type of claudeResetLimitTypes) {
    const window = windows[type];
    const reset = toResetTimestamp(window?.resetsAt);
    const percent = reset !== null && reset <= now ? 0 : window?.utilization;
    if (typeof percent === "number" && Number.isFinite(percent) && percent >= 0)
      used[type] = Math.min(100, percent);
  }
  return used;
};

// Waits for a usage read through the usual path: it joins one already
// running, and during the shared Claude rate-limit pause sends nothing.
export const refreshClaudeResetCredits = async (
  database: Database,
  account: TrackingAccount
): Promise<ClaudeResetCredits | null> => {
  const previous = peekClaudeResetCredits(account);
  const quota = await loadProviderAccountQuota(database, account, false);
  const current = peekClaudeResetCredits(account);
  return quota?.error || current === previous ? null : current;
};

// After a claim the cached resets may still show the reset it used. A new read
// replaces them, and supersedes any read started before; the rate-limit pause
// still applies.
export const reloadClaudeResetCredits = (
  database: Database,
  account: TrackingAccount
): void => {
  dropCachedResetCredits(quotaKey(account));
  loadProviderAccountQuota(database, account, true).catch(() => undefined);
};
