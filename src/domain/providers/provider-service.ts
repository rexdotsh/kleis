import type { Database } from "../../db";
import {
  addProviderAccount,
  extendProviderAccountRefreshLock,
  findProviderAccountById,
  findProviderAccountsByIds,
  findProviderAccountsWithIdentity,
  findPrimaryProviderAccount,
  hasActiveProviderAccountRefreshLock,
  markProviderAccountNeedsReauthorization,
  oauthIdentityKey,
  recordProviderAccountRefreshFailure,
  replaceProviderAccountCredentials,
  releaseProviderAccountRefreshLock,
  signedInUser,
  tryAcquireProviderAccountRefreshLock,
  updateProviderAccountTokens,
  upsertProviderAccount,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import type { Provider } from "../../db/schema";
import type { ProviderAccountMetadata } from "../../providers/metadata";
import { classifyOAuthRefreshError, OAuthError } from "../../providers/http";
import { getProviderAdapter } from "../../providers/registry";
import type {
  ProviderOAuthStartResult,
  ProviderTokenResult,
} from "../../providers/types";
import { errorLogFields, logWarn } from "../../utils/log";
import { sleep } from "../../utils/sleep";
import { createLookupCache } from "../../db/lookup-cache";

const REFRESH_LOCK_LEASE_MS = 45_000;
const REFRESH_LOCK_HEARTBEAT_MS = 5000;
const REFRESH_WAIT_TIMEOUT_MS = 20_000;
const AUTH_FAILURE_REFRESH_WAIT_TIMEOUT_MS = 30_000;
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

const claimRefreshLock = async (
  database: Database,
  accountId: string
): Promise<string | null> => {
  const token = crypto.randomUUID();
  const now = Date.now();
  const acquired = await tryAcquireProviderAccountRefreshLock(
    database,
    accountId,
    { token, now, expiresAt: now + REFRESH_LOCK_LEASE_MS }
  );
  return acquired ? token : null;
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

    assertProviderRefreshAllowed(account);

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
      if (!adapter.refreshAccount) {
        throw new Error(`${account.provider} accounts cannot be refreshed`);
      }
      const tokens = await adapter.refreshAccount(account, refreshNow);
      const accessToken = tokens.accessToken.trim();
      const refreshToken = tokens.refreshToken?.trim();
      if (!accessToken || !refreshToken) {
        throw new Error("Provider refresh response is missing required tokens");
      }
      const storedUser = signedInUser(account);
      const refreshedUser = signedInUser(tokens);
      if (storedUser && refreshedUser && storedUser !== refreshedUser) {
        throw new ProviderAccountNeedsReauthorizationError(
          "Provider refresh returned a different user; reauthorize the account"
        );
      }

      const updateInput = {
        accessToken,
        refreshToken,
        expiresAt: assertExpiresAt(tokens.expiresAt, refreshNow),
        accountId: tokens.accountId,
        metadata: tokens.metadata,
        refreshLockToken: lockToken,
        ...(account.refreshToken
          ? { expectedRefreshToken: account.refreshToken }
          : {}),
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
        throw new Error("Codex refresh lost its credential lock");
      }

      return updated;
    } catch (error) {
      const status =
        error instanceof ProviderAccountNeedsReauthorizationError
          ? "reauthorize"
          : classifyOAuthRefreshError(error);
      logWarn("provider_oauth_refresh_failed", {
        provider: account.provider,
        providerAccountId: account.id,
        status: error instanceof OAuthError ? error.status : null,
        errorCode: error instanceof OAuthError ? error.code : null,
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
  if (!account || account.accessToken !== failedAccessToken) {
    return account;
  }
  if (account.provider === "claude") {
    await flagClaudeReauthorization(database, account);
    return account;
  }
  if (isRecentlyIssued(account)) {
    return account;
  }
  assertProviderRefreshAllowed(account);

  const lockToken = await claimRefreshLock(database, account.id);
  if (lockToken) {
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

export class ProviderAccountNeedsReauthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAccountNeedsReauthorizationError";
  }
}

const assertProviderRefreshAllowed = (account: ProviderAccountRecord): void => {
  if (account.lastRefreshStatus === "reauthorize") {
    throw new ProviderAccountNeedsReauthorizationError(
      "Codex account needs reauthorization"
    );
  }
};

// Claude sign-ins are never refreshed: a refresh swaps the year-long token for
// an 8-hour one and revokes it. A rejected or expired sign-in needs a new one.
const flagClaudeReauthorization = async (
  database: Database,
  account: ProviderAccountRecord
): Promise<void> => {
  if (account.lastRefreshStatus !== "reauthorize") {
    await markProviderAccountNeedsReauthorization(
      database,
      account.id,
      account.accessToken,
      Date.now()
    );
  }
};

// Codex needs its refresh token; Claude's is never stored, since using it
// would revoke the sign-in.
const storedRefreshToken = (
  provider: Provider,
  refreshToken: string | null | undefined
): string | null => {
  if (provider === "claude") {
    return null;
  }
  const token = refreshToken?.trim();
  if (!token) {
    throw new Error("Codex accounts require a refresh token");
  }
  return token;
};

// A new sign-in for an account Kleis already has renews that account, so its
// label, keys and usage stay attached. More than one match adds a new account.
const findAccountToRenew = async (
  database: Database,
  provider: Provider,
  tokens: ProviderTokenResult
): Promise<string | undefined> => {
  const matches = await findProviderAccountsWithIdentity(database, {
    provider,
    accountId: tokens.accountId,
    metadata: tokens.metadata,
  });
  return matches.length === 1 ? matches[0]?.id : undefined;
};

const identityLocks = new Map<string, Promise<unknown>>();

// Serializes the find-then-write for one sign-in identity so concurrent
// completions renew one account instead of each adding it. The lock is per
// process; separate processes can still race.
const withIdentityLock = async <T>(
  key: string,
  run: () => Promise<T>
): Promise<T> => {
  const previous = identityLocks.get(key);
  const { promise: done, resolve: release } =
    Promise.withResolvers<undefined>();
  const tail = (previous ?? Promise.resolve()).then(() => done);
  identityLocks.set(key, tail);
  try {
    await previous;
    return await run();
  } finally {
    release(undefined);
    if (identityLocks.get(key) === tail) {
      identityLocks.delete(key);
    }
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

  const accessToken = tokens.accessToken.trim();
  const refreshToken = storedRefreshToken(provider, tokens.refreshToken);
  if (!accessToken) {
    throw new Error("Provider OAuth response is missing required tokens");
  }

  const identityKey = oauthIdentityKey({
    provider,
    accountId: tokens.accountId,
    metadata: tokens.metadata,
  });
  return withIdentityLock(identityKey, async () => {
    const replaceAccountId =
      tokens.replaceAccountId ??
      (await findAccountToRenew(database, provider, tokens));
    if (replaceAccountId) {
      const updated = await replaceProviderAccountCredentials(
        database,
        replaceAccountId,
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

    return addProviderAccount(database, {
      provider,
      accountId: tokens.accountId,
      label: tokens.label ?? null,
      accessToken,
      refreshToken,
      expiresAt: assertExpiresAt(tokens.expiresAt, now),
      metadata: tokens.metadata,
      now,
    });
  });
};

export const importProviderAccount = (
  database: Database,
  provider: Provider,
  input: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt: number;
    accountId: string | null;
    label?: string | null;
    metadata: ProviderAccountMetadata | null;
  },
  now: number
): Promise<ProviderAccountRecord> => {
  const accessToken = input.accessToken.trim();
  if (!accessToken) {
    throw new Error("Provider account import requires an access token");
  }
  const refreshToken = storedRefreshToken(provider, input.refreshToken);

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
  }
): Promise<ProviderAccountRecord | null> =>
  shareInFlightRefresh(accountId, () =>
    refreshProviderAccountOnce(database, accountId, now, input?.force ?? false)
  );

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
    if (account.expiresAt > Date.now()) {
      return account;
    }
    await flagClaudeReauthorization(database, account);
    throw new ProviderAccountNeedsReauthorizationError(
      "Claude sign-in has expired; reauthorize the account in Kleis"
    );
  }
  assertProviderRefreshAllowed(account);

  const lockToken = await claimRefreshLock(database, account.id);
  if (lockToken) {
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
    forceRefresh
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

  assertProviderRefreshAllowed(waited);

  const retryLockToken = await claimRefreshLock(database, account.id);
  if (!retryLockToken) {
    throw new Error("Provider account refresh is already in progress");
  }

  return refreshProviderAccountWithLock(
    database,
    account.id,
    retryLockToken,
    forceRefresh
  );
};

const ROUTABLE_ACCOUNT_CACHE_TTL_MS = 15_000;
const routableAccountCache = createLookupCache<ProviderAccountRecord | null>(
  ROUTABLE_ACCOUNT_CACHE_TTL_MS
);

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

// Requests use the key's pinned accounts for the provider when it has any,
// and the provider's primary account otherwise.
export const findRoutingCandidates = async (
  database: Database,
  provider: Provider,
  allowedAccountIds: readonly string[] | null | undefined
): Promise<ProviderAccountRecord[]> => {
  const pinned = await findPinnedProviderAccounts(
    database,
    provider,
    allowedAccountIds
  );
  if (pinned.length) {
    return pinned;
  }
  const primary = await routableAccountCache.get(
    database,
    `primary:${provider}`,
    () => findPrimaryProviderAccount(database, provider)
  );
  return primary ? [primary] : [];
};

export const getRoutableProviderAccount = async (
  database: Database,
  provider: Provider,
  now: number,
  input?: {
    allowedAccountIds?: readonly string[] | null;
  }
): Promise<ProviderAccountRecord | null> => {
  const account = (
    await findRoutingCandidates(database, provider, input?.allowedAccountIds)
  ).find((candidate) => candidate.enabled);
  if (!account) {
    return null;
  }

  if (account.expiresAt > now) {
    return account;
  }

  return refreshProviderAccount(database, account.id, now);
};
