import { and, desc, eq } from "drizzle-orm";

import type { Database } from "../client";
import { providerAccounts, type Provider } from "../schema";
import {
  parseProviderAccountMetadata,
  serializeProviderAccountMetadata,
  type ProviderAccountMetadata,
} from "../../providers/metadata";

export type ProviderAccountRecord = {
  id: string;
  provider: Provider;
  label: string | null;
  accountId: string | null;
  isPrimary: boolean;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  metadata: ProviderAccountMetadata | null;
  lastRefreshAt: number | null;
  lastRefreshStatus: string | null;
  createdAt: number;
  updatedAt: number;
};

const toRecord = (
  row: typeof providerAccounts.$inferSelect
): ProviderAccountRecord => ({
  id: row.id,
  provider: row.provider,
  label: row.label,
  accountId: row.accountId,
  isPrimary: row.isPrimary,
  accessToken: row.accessToken,
  refreshToken: row.refreshToken,
  expiresAt: row.expiresAt,
  metadata: parseProviderAccountMetadata(row.metadataJson),
  lastRefreshAt: row.lastRefreshAt,
  lastRefreshStatus: row.lastRefreshStatus,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const listProviderAccounts = async (
  database: Database
): Promise<ProviderAccountRecord[]> => {
  const rows = await database
    .select()
    .from(providerAccounts)
    .orderBy(desc(providerAccounts.createdAt));
  return rows.map(toRecord);
};

export const findProviderAccountById = async (
  database: Database,
  id: string
): Promise<ProviderAccountRecord | null> => {
  const row = await database.query.providerAccounts.findFirst({
    where: eq(providerAccounts.id, id),
  });

  if (!row) {
    return null;
  }

  return toRecord(row);
};

export const findPrimaryProviderAccount = async (
  database: Database,
  provider: Provider
): Promise<ProviderAccountRecord | null> => {
  const row = await database.query.providerAccounts.findFirst({
    where: and(
      eq(providerAccounts.provider, provider),
      eq(providerAccounts.isPrimary, true)
    ),
    orderBy: desc(providerAccounts.createdAt),
  });

  if (!row) {
    return null;
  }

  return toRecord(row);
};

const findProviderAccountByProviderAndAccountId = async (
  database: Database,
  provider: Provider,
  accountId: string
): Promise<ProviderAccountRecord | null> => {
  const row = await database.query.providerAccounts.findFirst({
    where: and(
      eq(providerAccounts.provider, provider),
      eq(providerAccounts.accountId, accountId)
    ),
  });

  if (!row) {
    return null;
  }

  return toRecord(row);
};

const hasPrimaryProviderAccount = async (
  database: Database,
  provider: Provider
): Promise<boolean> => {
  const primary = await database.query.providerAccounts.findFirst({
    where: and(
      eq(providerAccounts.provider, provider),
      eq(providerAccounts.isPrimary, true)
    ),
  });
  return Boolean(primary);
};

export type UpsertProviderAccountInput = {
  provider: Provider;
  accountId: string | null;
  label?: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  metadata: ProviderAccountMetadata | null;
  now: number;
};

export const upsertProviderAccount = async (
  database: Database,
  input: UpsertProviderAccountInput
): Promise<ProviderAccountRecord> => {
  const existing = input.accountId
    ? await findProviderAccountByProviderAndAccountId(
        database,
        input.provider,
        input.accountId
      )
    : null;

  if (existing) {
    await database
      .update(providerAccounts)
      .set({
        label: input.label === undefined ? existing.label : input.label,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: input.expiresAt,
        metadataJson: serializeProviderAccountMetadata(input.metadata),
        updatedAt: input.now,
      })
      .where(eq(providerAccounts.id, existing.id));

    const updated = await findProviderAccountById(database, existing.id);
    if (!updated) {
      throw new Error("Failed to load updated provider account");
    }
    return updated;
  }

  const isPrimary = !(await hasPrimaryProviderAccount(
    database,
    input.provider
  ));
  const id = crypto.randomUUID();
  await database.insert(providerAccounts).values({
    id,
    provider: input.provider,
    label: input.label === undefined ? null : input.label,
    accountId: input.accountId,
    isPrimary,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    metadataJson: serializeProviderAccountMetadata(input.metadata),
    lastRefreshAt: null,
    lastRefreshStatus: null,
    createdAt: input.now,
    updatedAt: input.now,
  });

  const created = await findProviderAccountById(database, id);
  if (!created) {
    throw new Error("Failed to load created provider account");
  }

  return created;
};

export type UpdateProviderAccountTokensInput = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string | null;
  metadata?: ProviderAccountMetadata | null;
  lastRefreshStatus: "success" | "failed";
  now: number;
};

export const updateProviderAccountTokens = async (
  database: Database,
  id: string,
  input: UpdateProviderAccountTokensInput
): Promise<ProviderAccountRecord | null> => {
  const setValues: Partial<typeof providerAccounts.$inferInsert> = {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    lastRefreshAt: input.now,
    lastRefreshStatus: input.lastRefreshStatus,
    updatedAt: input.now,
  };

  if ("accountId" in input) {
    setValues.accountId = input.accountId ?? null;
  }

  if ("metadata" in input) {
    setValues.metadataJson = serializeProviderAccountMetadata(
      input.metadata ?? null
    );
  }

  await database
    .update(providerAccounts)
    .set(setValues)
    .where(eq(providerAccounts.id, id));
  return findProviderAccountById(database, id);
};

export const recordProviderAccountRefreshFailure = async (
  database: Database,
  id: string,
  now: number
): Promise<void> => {
  await database
    .update(providerAccounts)
    .set({
      lastRefreshAt: now,
      lastRefreshStatus: "failed",
      updatedAt: now,
    })
    .where(eq(providerAccounts.id, id));
};

export const setPrimaryProviderAccount = async (
  database: Database,
  id: string,
  now: number
): Promise<ProviderAccountRecord | null> => {
  const account = await findProviderAccountById(database, id);
  if (!account) {
    return null;
  }

  await database
    .update(providerAccounts)
    .set({
      isPrimary: false,
      updatedAt: now,
    })
    .where(eq(providerAccounts.provider, account.provider));

  await database
    .update(providerAccounts)
    .set({
      isPrimary: true,
      updatedAt: now,
    })
    .where(
      and(
        eq(providerAccounts.id, id),
        eq(providerAccounts.provider, account.provider)
      )
    );

  return findProviderAccountById(database, id);
};
