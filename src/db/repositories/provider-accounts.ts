import { and, desc, eq } from "drizzle-orm";

import type { Database } from "../client";
import { providerAccounts } from "../schema";

export type ProviderAccountRecord = {
  id: string;
  provider: "copilot" | "codex" | "claude";
  label: string | null;
  accountId: string | null;
  isPrimary: boolean;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  metadataJson: string | null;
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
  metadataJson: row.metadataJson,
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
