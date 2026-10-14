import { sql } from "drizzle-orm";

import type { Database } from "../index";
import { providerAccounts, providerAccountSnapshots } from "../schema";
import {
  type ProviderAccountRecord,
  toProviderAccountRecord,
} from "./provider-accounts";

export type ProviderAccountSnapshotRow =
  typeof providerAccountSnapshots.$inferSelect;

export type ProviderAccountSnapshotWrite = {
  providerAccountId: string;
  accountIdentity: string;
  profile?: { json: string; fetchedAt: number | null };
  quota?: {
    json: string;
    fetchedAt: number | null;
    error: string | null;
    errorStatus: number | null;
  };
  updatedAt: number;
};

// A row written for another identity of the same account keeps nothing from
// the old one: the section not being written is cleared.
const keepForSameIdentity = (column: string) =>
  sql.raw(
    `case when account_identity = excluded.account_identity then ${column} else null end`
  );

const toInsert = (write: ProviderAccountSnapshotWrite) => {
  const values = {
    providerAccountId: write.providerAccountId,
    accountIdentity: write.accountIdentity,
    profileJson: write.profile?.json ?? null,
    profileFetchedAt: write.profile?.fetchedAt ?? null,
    quotaJson: write.quota?.json ?? null,
    quotaFetchedAt: write.quota?.fetchedAt ?? null,
    lastError: write.quota?.error ?? null,
    lastErrorStatus: write.quota?.errorStatus ?? null,
    updatedAt: write.updatedAt,
  };
  const profile = write.profile
    ? {
        profileJson: sql`excluded.profile_json`,
        profileFetchedAt: sql`excluded.profile_fetched_at`,
      }
    : {
        profileJson: keepForSameIdentity("profile_json"),
        profileFetchedAt: keepForSameIdentity("profile_fetched_at"),
      };
  const quota = write.quota
    ? {
        quotaJson: sql`excluded.quota_json`,
        quotaFetchedAt: sql`excluded.quota_fetched_at`,
        lastError: sql`excluded.last_error`,
        lastErrorStatus: sql`excluded.last_error_status`,
      }
    : {
        quotaJson: keepForSameIdentity("quota_json"),
        quotaFetchedAt: keepForSameIdentity("quota_fetched_at"),
        lastError: keepForSameIdentity("last_error"),
        lastErrorStatus: keepForSameIdentity("last_error_status"),
      };
  return { values, set: { ...profile, ...quota } };
};

const upsertStatement = (
  database: Database,
  write: ProviderAccountSnapshotWrite
) => {
  const { values, set } = toInsert(write);
  return database
    .insert(providerAccountSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: providerAccountSnapshots.providerAccountId,
      set: {
        ...set,
        accountIdentity: sql`excluded.account_identity`,
        updatedAt: sql`excluded.updated_at`,
      },
    });
};

// Snapshot writes deliberately skip the lookup-cache invalidation that every
// provider_accounts write does: they never change how requests are routed.
export const upsertProviderAccountSnapshots = async (
  database: Database,
  writes: readonly ProviderAccountSnapshotWrite[]
): Promise<void> => {
  const [first, ...rest] = writes.map((write) =>
    upsertStatement(database, write)
  );
  if (!first) {
    return;
  }
  await database.batch([first, ...rest]);
};

export const listProviderAccountsWithSnapshots = async (
  database: Database
): Promise<{
  accounts: ProviderAccountRecord[];
  snapshots: ProviderAccountSnapshotRow[];
}> => {
  const [accountRows, snapshots] = await database.batch([
    database.select().from(providerAccounts),
    database.select().from(providerAccountSnapshots),
  ]);
  return { accounts: accountRows.map(toProviderAccountRecord), snapshots };
};
