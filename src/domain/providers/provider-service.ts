import type { Database } from "../../db";
import {
  extendProviderAccountRefreshLock,
  findProviderAccountById,
  findProviderAccountsByIds,
  findPrimaryProviderAccount,
  hasActiveProviderAccountRefreshLock,
  recordProviderAccountRefreshFailure,
  replaceProviderAccountCredentials,
  releaseProviderAccountRefreshLock,
  tryAcquireProviderAccountRefreshLock,
  updateProviderAccountTokens,
  upsertProviderAccount,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import type { Provider } from "../../db/schema";
import type { ProviderAccountMetadata } from "../../providers/metadata";
import {
  CLAUDE_ACCOUNT_ON_HOLD,
  ClaudeOAuthError,
} from "../../providers/claude";
import { getProviderAdapter } from "../../providers/registry";
import type { ProviderOAuthStartResult } from "../../providers/types";
import { errorLogFields, logWarn } from "../../utils/log";
import { sleep } from "../../utils/sleep";
import { createLookupCache } from "../../db/lookup-cache";

const normalizeTokenField = (value: string): string => value.trim();

const REFRESH_LOCK_LEASE_MS = 45_000;
const REFRESH_LOCK_HEARTBEAT_MS = 5000;
const REFRESH_WAIT_TIMEOUT_MS = 20_000;
const AUTH_FAILURE_REFRESH_WAIT_TIMEOUT_MS = 30_000;
const CLAUDE_REFRESH_WAIT_TIMEOUT_MS = 30_000;
const CLAUDE_TRANSIENT_REFRESH_COOLDOWN_MS = 30_000;
const CLAUDE_ON_HOLD_REFRESH_COOLDOWN_MS = 30 * 60_000;
const REFRESH_WAIT_POLL_INTERVAL_MS = 150;
// A token rejected this soon after it was issued is reported as the upstream
// 401 instead of being rotated, so a persistent 401 rotates at most once a
// minute.
const AUTH_FAILURE_MIN_TOKEN_AGE_MS = 60_000;

const assertExpiresAt = (expiresAt: number, now: number): number => {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("Provider token expiry is invalid or already expired");
  }

  return expiresAt;
};

// After losing ownership of a refresh, only another writer's newer, still
// valid credential is safe to use.
const isNewerUnexpiredCredential = (
  current: ProviderAccountRecord,
  previousAccessToken: string
): boolean =>
  current.accessToken !== previousAccessToken && current.expiresAt > Date.now();

const isRecentlyIssued = (account: ProviderAccountRecord): boolean => {
  const now = Date.now();
  return (
    account.lastRefreshStatus === "success" &&
    account.lastRefreshAt !== null &&
    now - account.lastRefreshAt < AUTH_FAILURE_MIN_TOKEN_AGE_MS &&
    account.expiresAt > now
  );
};

const inFlightRefreshes = new Map<
  string,
  Promise<ProviderAccountRecord | null>
>();

const shareInFlightRefresh = (
  accountId: string,
  start: () => Promise<ProviderAccountRecord | null>
): Promise<ProviderAccountRecord | null> => {
  const pending = inFlightRefreshes.get(accountId);
  if (pending) {
    return pending;
  }
  const attempt = start().finally(() => {
    inFlightRefreshes.delete(accountId);
  });
  inFlightRefreshes.set(accountId, attempt);
  return attempt;
};

const unlessAborted = <T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> => {
  if (!signal) {
    return promise;
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    // AbortSignal reasons are caller-defined; cancellation must preserve them.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
};

const startRefreshLockHeartbeat = (
  database: Database,
  account: ProviderAccountRecord,
  lockToken: string
): (() => void) => {
  const heartbeat = async () => {
    const now = Date.now();
    const extended = await extendProviderAccountRefreshLock(
      database,
      account.id,
      {
        token: lockToken,
        now,
        expiresAt: now + REFRESH_LOCK_LEASE_MS,
      }
    );
    if (!extended) {
      clearInterval(timer);
      logWarn("provider_refresh_lock_lost", {
        providerAccountId: account.id,
        provider: account.provider,
      });
    }
  };
  const timer = setInterval(() => {
    heartbeat().catch((error: unknown) => {
      logWarn("provider_refresh_lock_heartbeat_failed", {
        providerAccountId: account.id,
        provider: account.provider,
        ...errorLogFields(error),
      });
    });
  }, REFRESH_LOCK_HEARTBEAT_MS);

  return () => {
    clearInterval(timer);
  };
};

const waitForInFlightRefresh = async (
  database: Database,
  accountId: string,
  now: number,
  forceRefresh: boolean,
  timeoutMs = REFRESH_WAIT_TIMEOUT_MS
): Promise<ProviderAccountRecord | null> => {
  const deadline = Date.now() + timeoutMs;
  let account = await findProviderAccountById(database, accountId);

  while (account && Date.now() < deadline) {
    if (!forceRefresh && account.expiresAt > now) {
      return account;
    }

    if (!hasActiveProviderAccountRefreshLock(account, Date.now())) {
      return account;
    }

    await sleep(REFRESH_WAIT_POLL_INTERVAL_MS);
    account = await findProviderAccountById(database, accountId);
  }

  return account;
};

const refreshProviderAccountWithLock = async (
  database: Database,
  accountId: string,
  lockToken: string,
  forceRefresh: boolean,
  failedAccessToken?: string
): Promise<ProviderAccountRecord | null> => {
  try {
    const account = await findProviderAccountById(database, accountId);
    if (!account) {
      return null;
    }

    if (account.provider === "claude") {
      assertClaudeRefreshAllowed(account);
    }

    if (
      failedAccessToken !== undefined &&
      account.accessToken !== failedAccessToken
    ) {
      return account;
    }

    const refreshNow = Date.now();
    if (!forceRefresh && account.expiresAt > refreshNow) {
      return account;
    }

    const stopRefreshLockHeartbeat = startRefreshLockHeartbeat(
      database,
      account,
      lockToken
    );
    try {
      const adapter = getProviderAdapter(account.provider);
      const tokens = await adapter.refreshAccount(account, refreshNow);
      const accessToken = normalizeTokenField(tokens.accessToken);
      const refreshToken = normalizeTokenField(tokens.refreshToken);
      if (!accessToken || !refreshToken) {
        throw new Error("Provider refresh response is missing required tokens");
      }

      const updateInput = {
        accessToken,
        refreshToken,
        expiresAt: assertExpiresAt(tokens.expiresAt, refreshNow),
        accountId: tokens.accountId,
        metadata: tokens.metadata,
        refreshLockToken: lockToken,
        expectedRefreshToken: account.refreshToken,
        lastRefreshStatus: "success" as const,
        now: refreshNow,
      };
      let updated: ProviderAccountRecord | null;
      try {
        updated = await updateProviderAccountTokens(
          database,
          account.id,
          updateInput
        );
      } catch (error) {
        // Credential-write errors also reach admin responses, without SQL parameters.
        throw new Error(errorLogFields(error).errorMessage);
      }

      if (!updated) {
        const current = await findProviderAccountById(database, account.id);
        if (
          current &&
          isNewerUnexpiredCredential(current, account.accessToken)
        ) {
          return current;
        }
        throw new Error(
          `${account.provider === "claude" ? "Claude" : "Codex"} refresh lost its credential lock`
        );
      }

      return updated;
    } catch (error) {
      // Without an OAuth error response, Anthropic may have rotated the
      // refresh token before the failure, so the outcome is indeterminate.
      const status =
        account.provider === "claude" && error instanceof ClaudeOAuthError
          ? error.code === "invalid_grant"
            ? "reauthorize"
            : error.code === CLAUDE_ACCOUNT_ON_HOLD
              ? CLAUDE_ACCOUNT_ON_HOLD
              : error.status === 429
                ? "rate_limited"
                : "transient"
          : account.provider === "claude"
            ? "indeterminate"
            : "failed";
      logWarn("provider_oauth_refresh_failed", {
        provider: account.provider,
        providerAccountId: account.id,
        status: error instanceof ClaudeOAuthError ? error.status : null,
        errorCode: error instanceof ClaudeOAuthError ? error.code : null,
        classification: status,
        elapsedMs: Date.now() - refreshNow,
        ...errorLogFields(error),
      });
      await recordProviderAccountRefreshFailure(
        database,
        account.id,
        refreshNow,
        lockToken,
        status
      );
      throw error;
    } finally {
      stopRefreshLockHeartbeat();
    }
  } finally {
    await releaseProviderAccountRefreshLock(
      database,
      accountId,
      lockToken,
      Date.now()
    ).catch(() => undefined);
  }
};

// Concurrent callers in this process share one attempt; each stops waiting when
// its own request disconnects.
export const refreshProviderAccountAfterAuthFailure = async (
  database: Database,
  accountId: string,
  failedAccessToken: string,
  signal?: AbortSignal
): Promise<ProviderAccountRecord | null> => {
  signal?.throwIfAborted();
  const pending = inFlightRefreshes.get(accountId);
  if (pending) {
    const shared = await unlessAborted(pending, signal);
    if (shared?.accessToken !== failedAccessToken) {
      return shared;
    }
    signal?.throwIfAborted();
  }
  return unlessAborted(
    shareInFlightRefresh(accountId, () =>
      refreshRejectedProviderAccount(database, accountId, failedAccessToken)
    ),
    signal
  );
};

const refreshRejectedProviderAccount = async (
  database: Database,
  accountId: string,
  failedAccessToken: string
): Promise<ProviderAccountRecord | null> => {
  const account = await findProviderAccountById(database, accountId);
  if (
    !account ||
    account.accessToken !== failedAccessToken ||
    isRecentlyIssued(account)
  ) {
    return account;
  }
  if (account.provider === "claude") {
    assertClaudeRefreshAllowed(account);
  }

  const lockToken = crypto.randomUUID();
  const lockClaimedAt = Date.now();
  const lockAcquired = await tryAcquireProviderAccountRefreshLock(
    database,
    account.id,
    {
      token: lockToken,
      now: lockClaimedAt,
      expiresAt: lockClaimedAt + REFRESH_LOCK_LEASE_MS,
    }
  );

  if (lockAcquired) {
    return refreshProviderAccountWithLock(
      database,
      account.id,
      lockToken,
      true,
      failedAccessToken
    );
  }

  const waited = await waitForInFlightRefresh(
    database,
    account.id,
    Date.now(),
    true,
    AUTH_FAILURE_REFRESH_WAIT_TIMEOUT_MS
  );
  if (!waited) {
    return null;
  }
  if (isNewerUnexpiredCredential(waited, failedAccessToken)) {
    return waited;
  }

  throw new Error(
    "Provider account refresh did not replace the rejected token"
  );
};

export const startProviderOAuth = async (
  database: Database,
  provider: Provider,
  input: {
    options?: Record<string, unknown>;
  },
  now: number
): Promise<ProviderOAuthStartResult> => {
  const replaceAccountId = input.options?.replaceAccountId;
  if (replaceAccountId !== undefined) {
    if (
      (provider !== "codex" && provider !== "claude") ||
      typeof replaceAccountId !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(replaceAccountId)
    ) {
      throw new ProviderReauthorizationTargetError(
        "Invalid account reauthorization target"
      );
    }
    const target = await findProviderAccountById(database, replaceAccountId);
    if (!target || target.provider !== provider) {
      throw new ProviderReauthorizationTargetError(
        "Provider account to reauthorize was not found"
      );
    }
    if (
      provider === "claude" &&
      target.metadata?.provider === "claude" &&
      target.metadata.oauthMode !==
        (input.options?.mode === "console" ? "console" : "max")
    ) {
      throw new ProviderReauthorizationTargetError(
        "Claude account OAuth mode does not match"
      );
    }
  }
  const adapter = getProviderAdapter(provider);
  return await adapter.startOAuth({
    database,
    ...(input.options ? { options: input.options } : {}),
    now,
  });
};

export class ProviderReauthorizationTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderReauthorizationTargetError";
  }
}

const assertClaudeRefreshAllowed = (account: ProviderAccountRecord): void => {
  if (account.lastRefreshStatus === "reauthorize") {
    throw new Error("Claude account needs reauthorization");
  }
  // A hold can be lifted, so refreshes resume after a long pause.
  if (
    account.lastRefreshStatus === CLAUDE_ACCOUNT_ON_HOLD &&
    account.lastRefreshAt !== null &&
    Date.now() - account.lastRefreshAt < CLAUDE_ON_HOLD_REFRESH_COOLDOWN_MS
  ) {
    throw new Error(
      "Claude account is on hold (account_on_hold); see https://claude.ai/restricted"
    );
  }
  if (
    (account.lastRefreshStatus === "rate_limited" ||
      account.lastRefreshStatus === "transient" ||
      account.lastRefreshStatus === "indeterminate") &&
    account.lastRefreshAt !== null &&
    Date.now() - account.lastRefreshAt < CLAUDE_TRANSIENT_REFRESH_COOLDOWN_MS
  ) {
    throw new Error("Claude OAuth refresh is temporarily unavailable");
  }
};

export const completeProviderOAuth = async (
  database: Database,
  provider: Provider,
  input: {
    state: string;
    code?: string;
  },
  now: number
): Promise<ProviderAccountRecord> => {
  const adapter = getProviderAdapter(provider);
  const tokens = await adapter.completeOAuth({
    database,
    state: input.state,
    ...(input.code ? { code: input.code } : {}),
    now,
  });

  const accessToken = normalizeTokenField(tokens.accessToken);
  const refreshToken = normalizeTokenField(tokens.refreshToken);
  if (!accessToken || !refreshToken) {
    throw new Error("Provider OAuth response is missing required tokens");
  }

  if (tokens.replaceAccountId) {
    const updated = await replaceProviderAccountCredentials(
      database,
      tokens.replaceAccountId,
      {
        provider,
        accountId: tokens.accountId,
        accessToken,
        refreshToken,
        expiresAt: assertExpiresAt(tokens.expiresAt, Date.now()),
        metadata: tokens.metadata,
        now: Date.now(),
      }
    );
    if (!updated) {
      throw new Error("Provider account to reauthorize no longer exists");
    }
    return updated;
  }

  return upsertProviderAccount(database, {
    provider,
    accountId: tokens.accountId,
    label: tokens.label ?? null,
    accessToken,
    refreshToken,
    expiresAt: assertExpiresAt(tokens.expiresAt, now),
    metadata: tokens.metadata,
    now,
  });
};

export const importProviderAccount = (
  database: Database,
  provider: Provider,
  input: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    accountId: string | null;
    label?: string | null;
    metadata: ProviderAccountMetadata | null;
  },
  now: number
): Promise<ProviderAccountRecord> => {
  const accessToken = normalizeTokenField(input.accessToken);
  const refreshToken = normalizeTokenField(input.refreshToken);
  if (!accessToken || !refreshToken) {
    throw new Error(
      "Provider account import requires access and refresh tokens"
    );
  }

  return upsertProviderAccount(database, {
    provider,
    accountId: input.accountId,
    label: input.label ?? null,
    accessToken,
    refreshToken,
    expiresAt: assertExpiresAt(input.expiresAt, now),
    metadata: input.metadata,
    now,
  });
};

export const refreshProviderAccount = (
  database: Database,
  accountId: string,
  now: number,
  input?: {
    force?: boolean;
    signal?: AbortSignal;
  }
): Promise<ProviderAccountRecord | null> => {
  input?.signal?.throwIfAborted();
  return unlessAborted(
    shareInFlightRefresh(accountId, () =>
      refreshProviderAccountOnce(
        database,
        accountId,
        now,
        input?.force ?? false
      )
    ),
    input?.signal
  );
};

const refreshProviderAccountOnce = async (
  database: Database,
  accountId: string,
  now: number,
  forceRefresh: boolean
): Promise<ProviderAccountRecord | null> => {
  const account = await findProviderAccountById(database, accountId);
  if (!account) {
    return null;
  }
  if (account.provider === "claude") {
    assertClaudeRefreshAllowed(account);
  }

  const lockToken = crypto.randomUUID();
  const lockClaimedAt = Date.now();
  const lockAcquired = await tryAcquireProviderAccountRefreshLock(
    database,
    account.id,
    {
      token: lockToken,
      now: lockClaimedAt,
      expiresAt: lockClaimedAt + REFRESH_LOCK_LEASE_MS,
    }
  );

  if (lockAcquired) {
    return refreshProviderAccountWithLock(
      database,
      account.id,
      lockToken,
      forceRefresh
    );
  }

  const waited = await waitForInFlightRefresh(
    database,
    account.id,
    now,
    forceRefresh,
    account.provider === "claude"
      ? CLAUDE_REFRESH_WAIT_TIMEOUT_MS
      : REFRESH_WAIT_TIMEOUT_MS
  );
  if (!waited) {
    return null;
  }

  if (isNewerUnexpiredCredential(waited, account.accessToken)) {
    return waited;
  }

  if (!forceRefresh && waited.expiresAt > now) {
    return waited;
  }

  if (
    account.provider === "claude" &&
    hasActiveProviderAccountRefreshLock(waited, Date.now())
  ) {
    throw new Error("Claude account refresh is already in progress");
  }
  if (account.provider === "claude") {
    assertClaudeRefreshAllowed(waited);
  }

  const retryLockToken = crypto.randomUUID();
  const retryClaimedAt = Date.now();
  const retryLockAcquired = await tryAcquireProviderAccountRefreshLock(
    database,
    account.id,
    {
      token: retryLockToken,
      now: retryClaimedAt,
      expiresAt: retryClaimedAt + REFRESH_LOCK_LEASE_MS,
    }
  );

  if (!retryLockAcquired) {
    throw new Error("Provider account refresh is already in progress");
  }

  return refreshProviderAccountWithLock(
    database,
    account.id,
    retryLockToken,
    forceRefresh
  );
};

const pickPreferredProviderAccount = (
  accounts: readonly ProviderAccountRecord[]
): ProviderAccountRecord | null => {
  if (!accounts.length) {
    return null;
  }

  return (
    [...accounts].sort(
      (left, right) =>
        Number(right.isPrimary) - Number(left.isPrimary) ||
        right.createdAt - left.createdAt
    )[0] ?? null
  );
};

const ROUTABLE_ACCOUNT_CACHE_TTL_MS = 15_000;
const routableAccountCache = createLookupCache<ProviderAccountRecord | null>(
  ROUTABLE_ACCOUNT_CACHE_TTL_MS
);

const getPrimaryProviderAccount = async (
  database: Database,
  provider: Provider
): Promise<ProviderAccountRecord | null> => {
  return routableAccountCache.get(database, `primary:${provider}`, () =>
    findPrimaryProviderAccount(database, provider)
  );
};

const pinnedAccountCache = createLookupCache<ProviderAccountRecord[]>(
  ROUTABLE_ACCOUNT_CACHE_TTL_MS
);

const normalizeAccountIds = (
  accountIds: readonly string[] | null | undefined
): string[] =>
  Array.from(
    new Set(
      accountIds
        ?.map((accountId) => accountId.trim())
        .filter((accountId) => accountId.length > 0) ?? []
    )
  ).sort();

// A key's account pins are per provider: only pins for this provider count,
// enabled or not.
export const findPinnedProviderAccounts = (
  database: Database,
  provider: Provider,
  accountIds: readonly string[] | null | undefined
): Promise<ProviderAccountRecord[]> => {
  const ids = normalizeAccountIds(accountIds);
  if (!ids.length) {
    return Promise.resolve([]);
  }
  return pinnedAccountCache.get(
    database,
    `pinned:${provider}:${ids.join(",")}`,
    async () =>
      (await findProviderAccountsByIds(database, ids)).filter(
        (candidate) => candidate.provider === provider
      )
  );
};

// Requests use the key's pinned account for the provider when it has one, and
// the provider's primary account otherwise.
export const getPreferredProviderAccount = async (
  database: Database,
  provider: Provider,
  input?: {
    allowedAccountIds?: readonly string[] | null;
  }
): Promise<ProviderAccountRecord | null> => {
  const pinned = await findPinnedProviderAccounts(
    database,
    provider,
    input?.allowedAccountIds
  );
  if (!pinned.length) {
    return getPrimaryProviderAccount(database, provider);
  }

  return pickPreferredProviderAccount(
    pinned.filter((candidate) => candidate.enabled)
  );
};

export const getRoutableProviderAccount = async (
  database: Database,
  provider: Provider,
  now: number,
  input?: { allowedAccountIds?: readonly string[] | null }
): Promise<ProviderAccountRecord | null> => {
  const account = await getPreferredProviderAccount(database, provider, input);
  if (!account) {
    return null;
  }

  if (account.expiresAt > now) {
    return account;
  }

  return refreshProviderAccount(database, account.id, now);
};
