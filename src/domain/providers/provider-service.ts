import type { Database } from "../../db/client";
import {
  findProviderAccountById,
  findPrimaryProviderAccount,
  hasActiveProviderAccountRefreshLock,
  recordProviderAccountRefreshFailure,
  releaseProviderAccountRefreshLock,
  tryAcquireProviderAccountRefreshLock,
  updateProviderAccountTokens,
  upsertProviderAccount,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import type { Provider } from "../../db/schema";
import type { ProviderAccountMetadata } from "../../providers/metadata";
import { getProviderAdapter } from "../../providers/registry";
import type { ProviderOAuthStartResult } from "../../providers/types";

const normalizeTokenField = (value: string): string => value.trim();

const REFRESH_LOCK_LEASE_MS = 20_000;
const REFRESH_WAIT_TIMEOUT_MS = 3000;
const REFRESH_WAIT_POLL_INTERVAL_MS = 150;

const assertExpiresAt = (expiresAt: number, now: number): number => {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("Provider token expiry is invalid or already expired");
  }

  return expiresAt;
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const waitForInFlightRefresh = async (
  database: Database,
  accountId: string,
  now: number
): Promise<ProviderAccountRecord | null> => {
  const deadline = Date.now() + REFRESH_WAIT_TIMEOUT_MS;
  let account = await findProviderAccountById(database, accountId);

  while (account && Date.now() < deadline) {
    if (account.expiresAt > now) {
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
  lockToken: string
): Promise<ProviderAccountRecord | null> => {
  try {
    const account = await findProviderAccountById(database, accountId);
    if (!account) {
      return null;
    }

    const refreshNow = Date.now();
    if (account.expiresAt > refreshNow) {
      return account;
    }

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
        lastRefreshStatus: "success",
        now: refreshNow,
      });

      if (!updated) {
        throw new Error("Failed to load refreshed provider account");
      }

      return updated;
    } catch (error) {
      await recordProviderAccountRefreshFailure(
        database,
        account.id,
        refreshNow
      );
      throw error;
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

export const startProviderOAuth = (
  database: Database,
  provider: Provider,
  input: {
    redirectUri: string;
    options?: Record<string, unknown>;
  },
  now: number
): Promise<ProviderOAuthStartResult> => {
  const adapter = getProviderAdapter(provider);
  return adapter.startOAuth({
    database,
    redirectUri: input.redirectUri,
    ...(input.options ? { options: input.options } : {}),
    now,
  });
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
  now: number
): Promise<ProviderAccountRecord | null> => {
  const account = await findProviderAccountById(database, accountId);
  if (!account) {
    return null;
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
    return refreshProviderAccountWithLock(database, account.id, lockToken);
  }

  const waited = await waitForInFlightRefresh(database, account.id, now);
  if (!waited) {
    return null;
  }

  if (waited.expiresAt > now) {
    return waited;
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

  return refreshProviderAccountWithLock(database, account.id, retryLockToken);
};

export const getPrimaryProviderAccount = async (
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
