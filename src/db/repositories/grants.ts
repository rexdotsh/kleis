import { and, desc, eq, gt, isNull } from "drizzle-orm";

import type { Database } from "../index";
import { createLookupCache, invalidateLookupCaches } from "../lookup-cache";
import { grants } from "../schema";

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
  try {
    await database.insert(grants).values(row);
  } finally {
    invalidateLookupCaches();
  }
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
  try {
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
  } finally {
    invalidateLookupCaches();
  }
};

const GRANT_CACHE_TTL_MS = 15_000;
const grantExpiryCache = createLookupCache<number | null>(GRANT_CACHE_TTL_MS);

export const hasLiveGrant = async (
  database: Database,
  apiKeyId: string,
  ownerId: string,
  now: number
): Promise<boolean> => {
  const expiresAt = await grantExpiryCache.get(
    database,
    `${apiKeyId}:${ownerId}`,
    async () => {
      const [grant] = await database
        .select({ expiresAt: grants.expiresAt })
        .from(grants)
        .where(
          and(
            eq(grants.apiKeyId, apiKeyId),
            eq(grants.ownerId, ownerId),
            isLive(now)
          )
        )
        .orderBy(desc(grants.expiresAt))
        .limit(1);
      return grant?.expiresAt ?? null;
    }
  );
  return expiresAt !== null && expiresAt > now;
};
