import { and, desc, eq, gt, isNull } from "drizzle-orm";

import type { Database } from "../index";
import { grants, providerAccounts, type Provider } from "../schema";
import {
  toProviderAccountRecord,
  type ProviderAccountRecord,
} from "./provider-accounts";

export type GrantRecord = typeof grants.$inferSelect;

const isLive = (now: number) =>
  and(isNull(grants.revokedAt), gt(grants.expiresAt, now));

export const createGrant = async (
  database: Database,
  input: {
    apiKeyId: string;
    ownerId: string;
    purpose: string | null;
    expiresAt: number;
  },
  now: number
): Promise<GrantRecord> => {
  const row = {
    id: crypto.randomUUID(),
    ...input,
    revokedAt: null,
    createdAt: now,
  };
  await database.insert(grants).values(row);
  return row;
};

export const listLiveGrants = async (
  database: Database,
  now: number,
  apiKeyId?: string
): Promise<GrantRecord[]> =>
  database
    .select()
    .from(grants)
    .where(
      and(isLive(now), apiKeyId ? eq(grants.apiKeyId, apiKeyId) : undefined)
    )
    .orderBy(desc(grants.createdAt));

// Revokes a live grant; with a key ID, only one that key holds.
export const revokeGrant = async (
  database: Database,
  id: string,
  now: number,
  apiKeyId?: string
): Promise<boolean> => {
  const result = await database
    .update(grants)
    .set({ revokedAt: now })
    .where(
      and(
        eq(grants.id, id),
        isLive(now),
        apiKeyId ? eq(grants.apiKeyId, apiKeyId) : undefined
      )
    );
  return result.rowsAffected > 0;
};

const liveGrant = (
  database: Database,
  input: { apiKeyId: string; ownerId: string; now: number }
) =>
  database
    .select({ id: grants.id })
    .from(grants)
    .where(
      and(
        eq(grants.apiKeyId, input.apiKeyId),
        eq(grants.ownerId, input.ownerId),
        isLive(input.now)
      )
    )
    .limit(1);

// Owner requests read the grant and the owner's accounts fresh every time, so
// a revoke or an unlink in any process applies at once. Null without a grant.
export const findGrantedOwnedAccounts = async (
  database: Database,
  input: { apiKeyId: string; ownerId: string; provider: Provider; now: number }
): Promise<ProviderAccountRecord[] | null> => {
  const [grant, accounts] = await database.batch([
    liveGrant(database, input),
    database
      .select()
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.ownerId, input.ownerId),
          eq(providerAccounts.provider, input.provider),
          isNull(providerAccounts.unlinkedAt)
        )
      )
      .orderBy(desc(providerAccounts.createdAt)),
  ]);
  return grant.length ? accounts.map(toProviderAccountRecord) : null;
};

// Checked right before a credential goes upstream: the grant is still live
// and the credential is still the owner's current one.
export const isOwnedCredentialLive = async (
  database: Database,
  input: {
    apiKeyId: string;
    ownerId: string;
    accountId: string;
    accessToken: string;
    now: number;
  }
): Promise<boolean> => {
  const [grant, account] = await database.batch([
    liveGrant(database, input),
    database
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .where(
        and(
          eq(providerAccounts.id, input.accountId),
          eq(providerAccounts.ownerId, input.ownerId),
          eq(providerAccounts.accessToken, input.accessToken),
          eq(providerAccounts.enabled, true),
          isNull(providerAccounts.unlinkedAt)
        )
      ),
  ]);
  return grant.length > 0 && account.length > 0;
};
