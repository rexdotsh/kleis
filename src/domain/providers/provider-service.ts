import type { Database } from "../../db/client";
import {
  findProviderAccountById,
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
  redirectUri: string,
  now: number
): Promise<ProviderOAuthStartResult> => {
  const adapter = getProviderAdapter(provider);
  return adapter.startOAuth({
    database,
    redirectUri,
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
