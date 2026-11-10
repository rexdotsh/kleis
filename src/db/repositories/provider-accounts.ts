import {
  and,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { Database } from "../index";
import {
  providerAccounts,
  providers,
  reauthLinks,
  type Provider,
} from "../schema";
import {
  parseProviderAccountMetadata,
  serializeProviderAccountMetadata,
  type ProviderAccountMetadata,
} from "../../providers/metadata";
import { invalidateLookupCaches } from "../lookup-cache";
import { errorLogFields } from "../../utils/log";

// Every write clears the proxy's routing lookups once it completes.
const withInvalidation =
  <Args extends unknown[], Result>(
    write: (...args: Args) => Promise<Result>
  ): ((...args: Args) => Promise<Result>) =>
  async (...args) => {
    try {
      return await write(...args);
    } finally {
      invalidateLookupCaches();
    }
  };

export type ProviderAccountRecord = Omit<
  typeof providerAccounts.$inferSelect,
  "metadataJson"
> & {
  metadata: ProviderAccountMetadata | null;
};

export const toProviderAccountRecord = ({
  metadataJson,
  ...row
}: typeof providerAccounts.$inferSelect): ProviderAccountRecord => ({
  ...row,
  metadata: parseProviderAccountMetadata(metadataJson),
});

export const selectProviderAccounts = (database: Database) =>
  database
    .select()
    .from(providerAccounts)
    .orderBy(
      desc(providerAccounts.isPrimary),
      desc(providerAccounts.createdAt)
    );

export const listProviderAccounts = async (
  database: Database
): Promise<ProviderAccountRecord[]> =>
  (await selectProviderAccounts(database)).map(toProviderAccountRecord);

export const listConfiguredProviders = async (
  database: Database
): Promise<Provider[]> => {
  const rows = await database
    .select({
      provider: providerAccounts.provider,
    })
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.isPrimary, true),
        eq(providerAccounts.enabled, true)
      )
    );

  return rows.map((row) => row.provider);
};

export const findProviderAccountById = async (
  database: Database,
  id: string
): Promise<ProviderAccountRecord | null> => {
  const row = await database.query.providerAccounts.findFirst({
    where: eq(providerAccounts.id, id),
  });

  return row ? toProviderAccountRecord(row) : null;
};

export const findProviderAccountsByIds = async (
  database: Database,
  ids: readonly string[]
): Promise<ProviderAccountRecord[]> => {
  const uniqueIds = Array.from(
    new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))
  );
  if (!uniqueIds.length) {
    return [];
  }

  const rows = await database
    .select()
    .from(providerAccounts)
    .where(inArray(providerAccounts.id, uniqueIds));

  return rows
    .map(toProviderAccountRecord)
    .sort(
      (left, right) =>
        Number(right.isPrimary) - Number(left.isPrimary) ||
        right.createdAt - left.createdAt
    );
};

export const findPrimaryProviderAccount = async (
  database: Database,
  provider: Provider
): Promise<ProviderAccountRecord | null> => {
  const row = await database.query.providerAccounts.findFirst({
    where: and(
      eq(providerAccounts.provider, provider),
      eq(providerAccounts.isPrimary, true),
      eq(providerAccounts.enabled, true)
    ),
    orderBy: desc(providerAccounts.createdAt),
  });

  return row ? toProviderAccountRecord(row) : null;
};

const findProviderAccountByProviderAndAccountId = async (
  database: Database,
  provider: Provider,
  accountId: string
): Promise<typeof providerAccounts.$inferSelect | null> =>
  (await database.query.providerAccounts.findFirst({
    where: and(
      eq(providerAccounts.provider, provider),
      eq(providerAccounts.accountId, accountId)
    ),
  })) ?? null;

const isUniqueConstraintError = (error: unknown): boolean => {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (
      current.message.toLowerCase().includes("unique constraint failed") ||
      ("code" in current && current.code === "SQLITE_CONSTRAINT_UNIQUE")
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
};

type UpsertProviderAccountInput = {
  provider: Provider;
  accountId: string | null;
  label?: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  metadata: ProviderAccountMetadata | null;
  now: number;
};

export const upsertProviderAccount = withInvalidation(
  async (
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

    const updateExisting = async (
      row: typeof providerAccounts.$inferSelect,
      retried = false
    ): Promise<ProviderAccountRecord> => {
      // Team members share a workspace ID, so a known, different user is
      // another person's sign-in.
      const storedUser = signedInUser(toProviderAccountRecord(row));
      const incomingUser = signedInUser(input);
      if (storedUser && incomingUser && storedUser !== incomingUser) {
        throw accountIdConflict();
      }
      // The write only lands on the metadata the user check read.
      const result = await database
        .update(providerAccounts)
        .set({
          label: input.label === undefined ? row.label : input.label,
          accessToken: input.accessToken,
          refreshToken: input.refreshToken,
          refreshLockToken: null,
          refreshLockExpiresAt: null,
          lastRefreshAt: input.now,
          lastRefreshStatus: "success",
          expiresAt: input.expiresAt,
          metadataJson: serializeProviderAccountMetadata(input.metadata),
          updatedAt: input.now,
        })
        .where(
          and(
            eq(providerAccounts.id, row.id),
            row.metadataJson === null
              ? isNull(providerAccounts.metadataJson)
              : eq(providerAccounts.metadataJson, row.metadataJson)
          )
        );
      if (result.rowsAffected === 0) {
        const current = await database.query.providerAccounts.findFirst({
          where: eq(providerAccounts.id, row.id),
        });
        if (!current || retried) {
          throw new ProviderAccountReauthorizationConflict(
            "Provider account changed during the import"
          );
        }
        return updateExisting(current, true);
      }

      const updated = await findProviderAccountById(database, row.id);
      if (!updated) {
        throw new Error("Failed to load updated provider account");
      }
      return updated;
    };
    if (existing) {
      return updateExisting(existing);
    }

    const { created, insertValues, attemptInsert } = await tryInsertAccount(
      database,
      input
    );
    if (created) {
      return created;
    }

    if (input.accountId) {
      const concurrent = await findProviderAccountByProviderAndAccountId(
        database,
        input.provider,
        input.accountId
      );
      if (concurrent) {
        return updateExisting(concurrent);
      }
    }

    return attemptInsert({
      ...insertValues,
      id: crypto.randomUUID(),
      isPrimary: false,
    });
  }
);

// Returns no account when the insert hit a unique index.
const tryInsertAccount = async (
  database: Database,
  input: UpsertProviderAccountInput
) => {
  const [primary, providerAccount] = await database.batch([
    database.query.providerAccounts.findFirst({
      where: and(
        eq(providerAccounts.provider, input.provider),
        eq(providerAccounts.isPrimary, true)
      ),
    }),
    database.query.providerAccounts.findFirst({
      where: eq(providerAccounts.provider, input.provider),
    }),
  ]);
  const insertValues: typeof providerAccounts.$inferInsert = {
    id: crypto.randomUUID(),
    provider: input.provider,
    label: input.label ?? null,
    accountId: input.accountId,
    isPrimary: !primary,
    enabled: providerAccount?.enabled ?? true,
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
    return {
      created: await attemptInsert(insertValues),
      insertValues,
      attemptInsert,
    };
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
  }
  return { created: null, insertValues, attemptInsert };
};

export class ProviderAccountReauthorizationConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAccountReauthorizationConflict";
  }
}

// The unique (provider, accountId) index allows one row per ChatGPT
// workspace, so another member of a connected workspace cannot be added.
const accountIdConflict = () =>
  new ProviderAccountReauthorizationConflict(
    "Another Kleis account already uses this provider account ID"
  );

export const signedInUser = ({
  metadata,
}: {
  metadata: ProviderAccountMetadata | null;
}): string | null | undefined => {
  if (metadata?.provider === "codex") {
    return metadata.chatgptUserId;
  }
  return metadata?.provider === "claude" ? metadata.accountUuid : null;
};

// Adds a new account and never takes over an existing row, even one with the
// same account ID.
export const addProviderAccount = withInvalidation(
  async (
    database: Database,
    input: UpsertProviderAccountInput
  ): Promise<ProviderAccountRecord> => {
    const accountIdTaken = async () =>
      input.accountId !== null &&
      (await findProviderAccountByProviderAndAccountId(
        database,
        input.provider,
        input.accountId
      )) !== null;
    if (await accountIdTaken()) {
      throw accountIdConflict();
    }

    const { created, insertValues, attemptInsert } = await tryInsertAccount(
      database,
      input
    );
    if (created) {
      return created;
    }
    if (await accountIdTaken()) {
      throw accountIdConflict();
    }
    return attemptInsert({
      ...insertValues,
      id: crypto.randomUUID(),
      isPrimary: false,
    });
  }
);

type OAuthIdentityInput = {
  provider: Provider;
  accountId: string | null;
  metadata: ProviderAccountMetadata | null;
};

// Who a sign-in belongs to: the Claude user and organization, or the ChatGPT
// workspace and user, since team members share a workspace ID. Older Claude
// rows kept the user UUID in accountId.
const oauthIdentity = ({
  provider,
  accountId,
  metadata,
}: OAuthIdentityInput): (string | null | undefined)[] =>
  provider === "claude"
    ? [
        (metadata?.provider === "claude" ? metadata.accountUuid : null) ||
          accountId,
        metadata?.provider === "claude" ? metadata.organizationUuid : null,
      ]
    : [
        accountId ||
          (metadata?.provider === "codex" ? metadata.chatgptAccountId : null),
        metadata?.provider === "codex" ? metadata.chatgptUserId : null,
      ];

export const oauthIdentityKey = (input: OAuthIdentityInput): string =>
  JSON.stringify([input.provider, ...oauthIdentity(input)]);

// Only an identity with every part known can match an account.
export const findProviderAccountsWithIdentity = async (
  database: Database,
  input: OAuthIdentityInput
): Promise<ProviderAccountRecord[]> => {
  const identity = oauthIdentity(input);
  if (identity.some((part) => !part)) {
    return [];
  }
  const rows = await database
    .select()
    .from(providerAccounts)
    .where(eq(providerAccounts.provider, input.provider));
  return rows
    .map(toProviderAccountRecord)
    .filter((account) =>
      oauthIdentity(account).every((part, index) => part === identity[index])
    );
};

const openReauthLink = (linkId: string, accountId: string, now: number) =>
  and(
    eq(reauthLinks.id, linkId),
    eq(reauthLinks.providerAccountId, accountId),
    isNull(reauthLinks.usedAt),
    isNull(reauthLinks.revokedAt),
    gt(reauthLinks.expiresAt, now)
  );

// With a reauthorize link, the credential write and the link's use commit in
// one transaction: the write needs the link open, and the link is only marked
// used when the account holds the credentials just written.
export const replaceProviderAccountCredentials = withInvalidation(
  async (
    database: Database,
    id: string,
    input: {
      provider: Provider;
      accountId: string | null;
      accessToken: string;
      refreshToken: string | null;
      expiresAt: number;
      metadata: ProviderAccountMetadata | null;
      now: number;
      reauthLinkId?: string;
    }
  ): Promise<ProviderAccountRecord | "reauth_link_unavailable" | null> => {
    const existing = await findProviderAccountById(database, id);
    if (!existing || existing.provider !== input.provider) {
      return null;
    }
    const known = oauthIdentity(existing);
    if (input.reauthLinkId && known.some((part) => !part)) {
      throw new ProviderAccountReauthorizationConflict(
        "The account has no stored user and organization to check the sign-in against"
      );
    }
    const received = oauthIdentity(input);
    if (known.some((part, index) => part && part !== received[index])) {
      throw new ProviderAccountReauthorizationConflict(
        "OAuth account identity does not match the selected account"
      );
    }

    const unchanged = and(
      eq(providerAccounts.id, id),
      eq(providerAccounts.provider, input.provider),
      eq(providerAccounts.updatedAt, existing.updatedAt)
    );
    const write = database.update(providerAccounts).set({
      accountId: input.accountId ?? existing.accountId,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      metadataJson: serializeProviderAccountMetadata(input.metadata),
      refreshLockToken: null,
      refreshLockExpiresAt: null,
      lastRefreshAt: input.now,
      lastRefreshStatus: "success",
      updatedAt: input.now,
    });
    const { reauthLinkId } = input;
    let written: { rowsAffected: number };
    try {
      if (reauthLinkId) {
        [written] = await database.batch([
          write.where(
            and(
              unchanged,
              exists(
                database
                  .select({ one: sql`1` })
                  .from(reauthLinks)
                  .where(openReauthLink(reauthLinkId, id, input.now))
              )
            )
          ),
          database
            .update(reauthLinks)
            .set({ usedAt: input.now })
            .where(
              and(
                openReauthLink(reauthLinkId, id, input.now),
                exists(
                  database
                    .select({ one: sql`1` })
                    .from(providerAccounts)
                    .where(
                      and(
                        eq(providerAccounts.id, id),
                        eq(providerAccounts.accessToken, input.accessToken),
                        eq(providerAccounts.updatedAt, input.now)
                      )
                    )
                )
              )
            ),
        ]);
      } else {
        written = await write.where(unchanged);
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ProviderAccountReauthorizationConflict(
          "OAuth account identity is already connected to another account"
        );
      }
      if (input.provider === "claude") {
        // libSQL errors may include the token-bearing UPDATE parameters.
        throw new Error("Unable to replace Claude account credentials");
      }
      throw error;
    }
    if (written.rowsAffected === 0) {
      if (
        reauthLinkId &&
        !(await database
          .select({ id: reauthLinks.id })
          .from(reauthLinks)
          .where(openReauthLink(reauthLinkId, id, Date.now()))
          .get())
      ) {
        return "reauth_link_unavailable";
      }
      throw new ProviderAccountReauthorizationConflict(
        "Provider account changed during reauthorization"
      );
    }
    return findProviderAccountById(database, id);
  }
);

type UpdateProviderAccountTokensInput = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string | null;
  metadata?: ProviderAccountMetadata | null;
  refreshLockToken?: string;
  expectedRefreshToken?: string;
  lastRefreshStatus: "success" | "failed";
  now: number;
};

export const updateProviderAccountTokens = withInvalidation(
  async (
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

    const whereClause = and(
      eq(providerAccounts.id, id),
      ...(input.refreshLockToken
        ? [
            eq(providerAccounts.refreshLockToken, input.refreshLockToken),
            gt(providerAccounts.refreshLockExpiresAt, Date.now()),
          ]
        : []),
      ...(input.expectedRefreshToken
        ? [eq(providerAccounts.refreshToken, input.expectedRefreshToken)]
        : [])
    );

    const result = await database
      .update(providerAccounts)
      .set(setValues)
      .where(whereClause);
    if (result.rowsAffected === 0) {
      return null;
    }

    return findProviderAccountById(database, id);
  }
);

export const recordProviderAccountRefreshFailure = withInvalidation(
  async (
    database: Database,
    id: string,
    now: number,
    refreshLockToken?: string,
    status?: string
  ): Promise<void> => {
    const whereClause = refreshLockToken
      ? and(
          eq(providerAccounts.id, id),
          eq(providerAccounts.refreshLockToken, refreshLockToken),
          gt(providerAccounts.refreshLockExpiresAt, Date.now())
        )
      : eq(providerAccounts.id, id);

    await database
      .update(providerAccounts)
      .set({
        lastRefreshAt: now,
        lastRefreshStatus: status ?? "failed",
        updatedAt: now,
      })
      .where(whereClause);
  }
);

// Only flags the credential that failed, so a reauthorization that already
// replaced it stays healthy.
export const markProviderAccountNeedsReauthorization = withInvalidation(
  async (
    database: Database,
    id: string,
    accessToken: string,
    now: number
  ): Promise<void> => {
    try {
      await database
        .update(providerAccounts)
        .set({
          lastRefreshAt: now,
          lastRefreshStatus: "reauthorize",
          updatedAt: now,
        })
        .where(
          and(
            eq(providerAccounts.id, id),
            eq(providerAccounts.accessToken, accessToken)
          )
        );
    } catch (error) {
      // The query error lists its parameters, including the access token.
      throw new Error(errorLogFields(error).errorMessage);
    }
  }
);

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

export const tryAcquireProviderAccountRefreshLock = withInvalidation(
  async (
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
  }
);

export const extendProviderAccountRefreshLock = withInvalidation(
  async (
    database: Database,
    id: string,
    input: TryAcquireProviderAccountRefreshLockInput
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
  }
);

export const releaseProviderAccountRefreshLock = withInvalidation(
  async (
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
  }
);

export const updateProviderAccountProfile = withInvalidation(
  async (
    database: Database,
    id: string,
    input: {
      label: string | null;
      accountId: string | null;
      metadata: ProviderAccountMetadata | null;
      now: number;
    }
  ): Promise<ProviderAccountRecord | "account_id_conflict" | null> => {
    try {
      const result = await database
        .update(providerAccounts)
        .set({
          label: input.label,
          accountId: input.accountId,
          metadataJson: serializeProviderAccountMetadata(input.metadata),
          updatedAt: input.now,
        })
        .where(eq(providerAccounts.id, id));
      if (result.rowsAffected === 0) {
        return null;
      }
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return "account_id_conflict";
      }
      throw error;
    }

    const updated = await findProviderAccountById(database, id);
    if (!updated) {
      throw new Error("Failed to load updated provider account");
    }

    return updated;
  }
);

export const deleteProviderAccount = withInvalidation(
  async (database: Database, id: string): Promise<boolean> => {
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
  }
);

export const setPrimaryProviderAccount = withInvalidation(
  async (
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

        return toProviderAccountRecord(row);
      });
    } catch (error) {
      if (error instanceof Error && error.message === accountChangedMessage) {
        return null;
      }

      throw error;
    }
  }
);

export type ProviderStatus = {
  provider: Provider;
  enabled: boolean;
  accountCount: number;
  enabledAccountCount: number;
};

export const summarizeProviderStatuses = (
  rows: readonly { provider: Provider; enabled: boolean }[]
): ProviderStatus[] =>
  providers.map((provider) => {
    const accounts = rows.filter((row) => row.provider === provider);
    const enabledAccountCount = accounts.filter((row) => row.enabled).length;
    return {
      provider,
      enabled: enabledAccountCount > 0,
      accountCount: accounts.length,
      enabledAccountCount,
    };
  });

export const listProviderStatuses = async (
  database: Database
): Promise<ProviderStatus[]> =>
  summarizeProviderStatuses(
    await database
      .select({
        provider: providerAccounts.provider,
        enabled: providerAccounts.enabled,
      })
      .from(providerAccounts)
  );

export const setProviderAccountsEnabled = withInvalidation(
  async (
    database: Database,
    provider: Provider,
    enabled: boolean,
    now: number
  ): Promise<ProviderStatus> => {
    await database
      .update(providerAccounts)
      .set({ enabled, updatedAt: now })
      .where(eq(providerAccounts.provider, provider));

    const statuses = await listProviderStatuses(database);
    const status = statuses.find((item) => item.provider === provider);
    if (!status) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    return status;
  }
);
