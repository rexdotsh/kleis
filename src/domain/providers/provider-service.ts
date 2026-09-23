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
import { ClaudeOAuthError } from "../../providers/claude";
import { getProviderAdapter } from "../../providers/registry";
import type { ProviderOAuthStartResult } from "../../providers/types";
import { logWarn } from "../../utils/log";
import { sleep } from "../../utils/sleep";

const normalizeTokenField = (value: string): string => value.trim();

const REFRESH_LOCK_LEASE_MS = 45_000;
const REFRESH_LOCK_HEARTBEAT_MS = 5000;
const REFRESH_WAIT_TIMEOUT_MS = 3000;
const AUTH_FAILURE_REFRESH_WAIT_TIMEOUT_MS = 30_000;
const CLAUDE_REFRESH_WAIT_TIMEOUT_MS = 30_000;
const CLAUDE_TRANSIENT_REFRESH_COOLDOWN_MS = 30_000;
const REFRESH_WAIT_POLL_INTERVAL_MS = 150;

const assertExpiresAt = (expiresAt: number, now: number): number => {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("Provider token expiry is invalid or already expired");
  }

  return expiresAt;
};

const startRefreshLockHeartbeat = (
  database: Database,
  accountId: string,
  lockToken: string
): (() => void) => {
  const timer = setInterval(() => {
    const now = Date.now();
    extendProviderAccountRefreshLock(database, accountId, {
      token: lockToken,
      now,
      expiresAt: now + REFRESH_LOCK_LEASE_MS,
    }).catch(() => undefined);
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
  timeoutMs = REFRESH_WAIT_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<ProviderAccountRecord | null> => {
  signal?.throwIfAborted();
  const deadline = Date.now() + timeoutMs;
  let account = await findProviderAccountById(database, accountId);

  while (account && Date.now() < deadline) {
    signal?.throwIfAborted();
    if (!forceRefresh && account.expiresAt > now) {
      return account;
    }

    if (!hasActiveProviderAccountRefreshLock(account, Date.now())) {
      return account;
    }

    await sleep(REFRESH_WAIT_POLL_INTERVAL_MS);
    signal?.throwIfAborted();
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
      account.id,
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

      const updated = await updateProviderAccountTokens(database, account.id, {
        accessToken,
        refreshToken,
        expiresAt: assertExpiresAt(tokens.expiresAt, refreshNow),
        accountId: tokens.accountId,
        metadata: tokens.metadata,
        refreshLockToken: lockToken,
        ...(account.provider === "claude"
          ? { expectedRefreshToken: account.refreshToken }
          : {}),
        lastRefreshStatus: "success",
        now: refreshNow,
      });

      if (!updated) {
        const current = await findProviderAccountById(database, account.id);
        if (
          account.provider !== "claude" ||
          (current &&
            current.accessToken !== account.accessToken &&
            current.expiresAt > Date.now())
        ) {
          return current;
        }
        throw new Error("Claude refresh lost its credential lock");
      }

      return updated;
    } catch (error) {
      const status =
        account.provider === "claude" && error instanceof ClaudeOAuthError
          ? error.code === "invalid_grant"
            ? "reauthorize"
            : error.status === 429
              ? "rate_limited"
              : "transient"
          : account.provider === "claude"
            ? "transient"
            : "failed";
      await recordProviderAccountRefreshFailure(
        database,
        account.id,
        refreshNow,
        lockToken,
        status
      );
      if (account.provider === "claude") {
        logWarn("claude_oauth_refresh_failed", {
          accountId: account.id,
          endpoint: "platform.claude.com/v1/oauth/token",
          status: error instanceof ClaudeOAuthError ? error.status : null,
          oauthCode: error instanceof ClaudeOAuthError ? error.code : null,
          classification: status,
          elapsedMs: Date.now() - refreshNow,
        });
      }
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

export const refreshProviderAccountAfterAuthFailure = async (
  database: Database,
  accountId: string,
  failedAccessToken: string,
  signal?: AbortSignal
): Promise<ProviderAccountRecord | null> => {
  signal?.throwIfAborted();
  const account = await findProviderAccountById(database, accountId);
  signal?.throwIfAborted();
  if (!account || account.accessToken !== failedAccessToken) {
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
    AUTH_FAILURE_REFRESH_WAIT_TIMEOUT_MS,
    signal
  );
  if (!waited) {
    return null;
  }
  if (waited.accessToken !== failedAccessToken) {
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
  if (
    (account.lastRefreshStatus === "rate_limited" ||
      account.lastRefreshStatus === "transient") &&
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

export const refreshProviderAccount = async (
  database: Database,
  accountId: string,
  now: number,
  input?: {
    force?: boolean;
  }
): Promise<ProviderAccountRecord | null> => {
  const forceRefresh = input?.force ?? false;
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

  if (
    account.provider === "claude" &&
    waited.refreshToken !== account.refreshToken &&
    waited.expiresAt > Date.now()
  ) {
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

const getPrimaryProviderAccount = async (
  database: Database,
  provider: Provider,
  now: number
): Promise<ProviderAccountRecord | null> => {
  const account = await findPrimaryProviderAccount(database, provider);
  if (!account) {
    return null;
  }

  if (account.expiresAt > now) {
    return account;
  }

  return refreshProviderAccount(database, account.id, now);
};

export const getRoutableProviderAccount = async (
  database: Database,
  provider: Provider,
  now: number,
  input?: {
    allowedAccountIds?: readonly string[] | null;
  }
): Promise<ProviderAccountRecord | null> => {
  const allowedAccountIds = Array.from(
    new Set(
      input?.allowedAccountIds
        ?.map((accountId) => accountId.trim())
        .filter((accountId) => accountId.length > 0) ?? []
    )
  );
  if (!allowedAccountIds.length) {
    return getPrimaryProviderAccount(database, provider, now);
  }

  const account = pickPreferredProviderAccount(
    (await findProviderAccountsByIds(database, allowedAccountIds)).filter(
      (candidate) => candidate.provider === provider && candidate.enabled
    )
  );
  if (!account) {
    return null;
  }

  if (account.expiresAt > now) {
    return account;
  }

  return refreshProviderAccount(database, account.id, now);
};
