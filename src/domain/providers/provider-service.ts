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
  const startInput: {
    database: Database;
    redirectUri: string;
    options?: Record<string, unknown>;
    now: number;
  } = {
    database,
    redirectUri: input.redirectUri,
    now,
  };
  if (input.options) {
    startInput.options = input.options;
  }

  return adapter.startOAuth(startInput);
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
  const completeInput: {
    database: Database;
    state: string;
    code?: string;
    now: number;
  } = {
    database,
    state: input.state,
    now,
  };
  if (input.code) {
    completeInput.code = input.code;
  }

  const tokens = await adapter.completeOAuth(completeInput);

  return upsertProviderAccount(database, {
    provider,
    accountId: tokens.accountId,
    label: tokens.label ?? null,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
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

    const updated = await updateProviderAccountTokens(database, account.id, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
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
