import type { Database } from "../../db/client";
import {
  findProviderAccountById,
  findPrimaryProviderAccount,
  recordProviderAccountRefreshFailure,
  updateProviderAccountTokens,
  upsertProviderAccount,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import type { Provider } from "../../db/schema";
import { getProviderAdapter } from "../../providers/registry";
import type { ProviderOAuthStartResult } from "../../providers/types";

const normalizeTokenField = (value: string): string => value.trim();

const assertExpiresAt = (expiresAt: number, now: number): number => {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("Provider token expiry is invalid or already expired");
  }

  return expiresAt;
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

export const refreshProviderAccount = async (
  database: Database,
  accountId: string,
  now: number
): Promise<ProviderAccountRecord | null> => {
  const account = await findProviderAccountById(database, accountId);
  if (!account) {
    return null;
  }

  try {
    const adapter = getProviderAdapter(account.provider);
    const tokens = await adapter.refreshAccount(account, now);
    const accessToken = normalizeTokenField(tokens.accessToken);
    const refreshToken = normalizeTokenField(tokens.refreshToken);
    if (!accessToken || !refreshToken) {
      throw new Error("Provider refresh response is missing required tokens");
    }

    const updated = await updateProviderAccountTokens(database, account.id, {
      accessToken,
      refreshToken,
      expiresAt: assertExpiresAt(tokens.expiresAt, now),
      accountId: tokens.accountId,
      metadata: tokens.metadata,
      lastRefreshStatus: "success",
      now,
    });

    if (!updated) {
      throw new Error("Failed to load refreshed provider account");
    }

    return updated;
  } catch (error) {
    await recordProviderAccountRefreshFailure(database, account.id, now);
    throw error;
  }
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
