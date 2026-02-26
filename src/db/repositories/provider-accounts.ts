import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";

import type { Database } from "../index";
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
  refreshLockToken: string | null;
  refreshLockExpiresAt: number | null;
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
  refreshLockToken: row.refreshLockToken,
  refreshLockExpiresAt: row.refreshLockExpiresAt,
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
    .orderBy(
      desc(providerAccounts.isPrimary),
      desc(providerAccounts.createdAt)
    );
  return rows.map(toRecord);
};

export const listConfiguredProviders = async (
  database: Database
): Promise<Provider[]> => {
  const rows = await database
    .select({
      provider: providerAccounts.provider,
    })
    .from(providerAccounts)
    .where(eq(providerAccounts.isPrimary, true));

  return rows.map((row) => row.provider);
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

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.toLowerCase().includes("unique constraint failed");

type UpsertProviderAccountInput = {
  provider: Provider;
  accountId: string | null;
  label?: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  metadata: ProviderAccountMetadata | null;
  now: number;
};

const buildProviderAccountUpsertUpdate = (input: {
  existingLabel: string | null;
  nextLabel: string | null | undefined;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  metadata: ProviderAccountMetadata | null;
  now: number;
}): Partial<typeof providerAccounts.$inferInsert> => ({
  label: input.nextLabel === undefined ? input.existingLabel : input.nextLabel,
  accessToken: input.accessToken,
  refreshToken: input.refreshToken,
  refreshLockToken: null,
  refreshLockExpiresAt: null,
  expiresAt: input.expiresAt,
  metadataJson: serializeProviderAccountMetadata(input.metadata),
  updatedAt: input.now,
});

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
      .set(
        buildProviderAccountUpsertUpdate({
          existingLabel: existing.label,
          nextLabel: input.label,
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          expiresAt: input.expiresAt,
          metadata: input.metadata,
          now: input.now,
        })
      )
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
  const insertValues: typeof providerAccounts.$inferInsert = {
    id: crypto.randomUUID(),
    provider: input.provider,
    label: input.label === undefined ? null : input.label,
    accountId: input.accountId,
    isPrimary,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    refreshLockToken: null,
    refreshLockExpiresAt: null,
    expiresAt: input.expiresAt,
    metadataJson: serializeProviderAccountMetadata(input.metadata),
    lastRefreshAt: null,
    lastRefreshStatus: null,
    createdAt: input.now,
    updatedAt: input.now,
  };

  const attemptInsert = async (
    values: typeof providerAccounts.$inferInsert
  ): Promise<ProviderAccountRecord> => {
    await database.insert(providerAccounts).values(values);
    const created = await findProviderAccountById(database, values.id);
    if (!created) {
      throw new Error("Failed to load created provider account");
    }

    return created;
  };

  try {
    return await attemptInsert(insertValues);
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
  }

  if (input.accountId) {
    const concurrent = await findProviderAccountByProviderAndAccountId(
      database,
      input.provider,
      input.accountId
    );
    if (concurrent) {
      await database
        .update(providerAccounts)
        .set(
          buildProviderAccountUpsertUpdate({
            existingLabel: concurrent.label,
            nextLabel: input.label,
            accessToken: input.accessToken,
            refreshToken: input.refreshToken,
            expiresAt: input.expiresAt,
            metadata: input.metadata,
            now: input.now,
          })
        )
        .where(eq(providerAccounts.id, concurrent.id));

      const updated = await findProviderAccountById(database, concurrent.id);
      if (!updated) {
        throw new Error("Failed to load updated provider account");
      }
      return updated;
    }
  }

  return attemptInsert({
    ...insertValues,
    id: crypto.randomUUID(),
    isPrimary: false,
  });
};

type UpdateProviderAccountTokensInput = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string | null;
  metadata?: ProviderAccountMetadata | null;
  refreshLockToken?: string;
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

  const whereClause = input.refreshLockToken
    ? and(
        eq(providerAccounts.id, id),
        eq(providerAccounts.refreshLockToken, input.refreshLockToken),
        gt(providerAccounts.refreshLockExpiresAt, input.now)
      )
    : eq(providerAccounts.id, id);

  const result = await database
    .update(providerAccounts)
    .set(setValues)
    .where(whereClause);
  if (result.rowsAffected === 0) {
    return null;
  }

  return findProviderAccountById(database, id);
};

export const recordProviderAccountRefreshFailure = async (
  database: Database,
  id: string,
  now: number,
  refreshLockToken?: string
): Promise<void> => {
  const whereClause = refreshLockToken
    ? and(
        eq(providerAccounts.id, id),
        eq(providerAccounts.refreshLockToken, refreshLockToken),
        gt(providerAccounts.refreshLockExpiresAt, now)
      )
    : eq(providerAccounts.id, id);

  await database
    .update(providerAccounts)
    .set({
      lastRefreshAt: now,
      lastRefreshStatus: "failed",
      updatedAt: now,
    })
    .where(whereClause);
};

export const hasActiveProviderAccountRefreshLock = (
  account: ProviderAccountRecord,
  now: number
): boolean =>
  Boolean(
    account.refreshLockToken &&
      account.refreshLockExpiresAt &&
      account.refreshLockExpiresAt > now
  );

type TryAcquireProviderAccountRefreshLockInput = {
  token: string;
  now: number;
  expiresAt: number;
};

export const tryAcquireProviderAccountRefreshLock = async (
  database: Database,
  id: string,
  input: TryAcquireProviderAccountRefreshLockInput
): Promise<boolean> => {
  await database
    .update(providerAccounts)
    .set({
      refreshLockToken: input.token,
      refreshLockExpiresAt: input.expiresAt,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(providerAccounts.id, id),
        or(
          isNull(providerAccounts.refreshLockToken),
          isNull(providerAccounts.refreshLockExpiresAt),
          lte(providerAccounts.refreshLockExpiresAt, input.now)
        )
      )
    );

  const account = await findProviderAccountById(database, id);
  return Boolean(
    account &&
      account.refreshLockToken === input.token &&
      account.refreshLockExpiresAt !== null &&
      account.refreshLockExpiresAt > input.now
  );
};

type ExtendProviderAccountRefreshLockInput = {
  token: string;
  now: number;
  expiresAt: number;
};

export const extendProviderAccountRefreshLock = async (
  database: Database,
  id: string,
  input: ExtendProviderAccountRefreshLockInput
): Promise<boolean> => {
  const result = await database
    .update(providerAccounts)
    .set({
      refreshLockExpiresAt: input.expiresAt,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(providerAccounts.id, id),
        eq(providerAccounts.refreshLockToken, input.token),
        gt(providerAccounts.refreshLockExpiresAt, input.now)
      )
    );

  return result.rowsAffected > 0;
};

export const releaseProviderAccountRefreshLock = async (
  database: Database,
  id: string,
  token: string,
  now: number
): Promise<void> => {
  await database
    .update(providerAccounts)
    .set({
      refreshLockToken: null,
      refreshLockExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(providerAccounts.id, id),
        eq(providerAccounts.refreshLockToken, token)
      )
    );
};

export const deleteProviderAccount = async (
  database: Database,
  id: string
): Promise<boolean> => {
  const account = await findProviderAccountById(database, id);
  if (!account) {
    return false;
  }

  const result = await database
    .delete(providerAccounts)
    .where(eq(providerAccounts.id, id));
  if (result.rowsAffected === 0) {
    return false;
  }

  if (account.isPrimary) {
    const currentPrimary = await findPrimaryProviderAccount(
      database,
      account.provider
    );
    if (!currentPrimary) {
      const next = await database.query.providerAccounts.findFirst({
        where: eq(providerAccounts.provider, account.provider),
        orderBy: desc(providerAccounts.createdAt),
      });
      if (next) {
        await setPrimaryProviderAccount(database, next.id, Date.now());
      }
    }
  }

  return true;
};

export const setPrimaryProviderAccount = async (
  database: Database,
  id: string,
  now: number
): Promise<ProviderAccountRecord | null> => {
  const accountChangedMessage =
    "Provider account changed while setting primary";

  try {
    return await database.transaction(async (tx) => {
      const account = await tx.query.providerAccounts.findFirst({
        where: eq(providerAccounts.id, id),
      });
      if (!account) {
        return null;
      }

      await tx
        .update(providerAccounts)
        .set({ isPrimary: false, updatedAt: now })
        .where(
          and(
            eq(providerAccounts.provider, account.provider),
            eq(providerAccounts.isPrimary, true)
          )
        );

      const result = await tx
        .update(providerAccounts)
        .set({ isPrimary: true, updatedAt: now })
        .where(
          and(
            eq(providerAccounts.id, id),
            eq(providerAccounts.provider, account.provider)
          )
        );

      if (result.rowsAffected === 0) {
        throw new Error(accountChangedMessage);
      }

      const row = await tx.query.providerAccounts.findFirst({
        where: and(
          eq(providerAccounts.id, id),
          eq(providerAccounts.provider, account.provider)
        ),
      });
      if (!row) {
        throw new Error(accountChangedMessage);
      }

      return toRecord(row);
    });
  } catch (error) {
    if (error instanceof Error && error.message === accountChangedMessage) {
      return null;
    }

    throw error;
  }
};
