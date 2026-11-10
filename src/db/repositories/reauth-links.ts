import { and, eq, gt, isNull, sql } from "drizzle-orm";

import type { Database } from "../index";
import { providerAccounts, reauthLinks } from "../schema";
import {
  selectProviderAccounts,
  toProviderAccountRecord,
  type ProviderAccountRecord,
} from "./provider-accounts";

export type ReauthLinkRecord = typeof reauthLinks.$inferSelect;

export type ReauthLinkSummary = Pick<
  ReauthLinkRecord,
  "expiresAt" | "createdAt"
>;

const hashReauthToken = (token: string): string =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

const isOpen = (now: number) =>
  and(
    isNull(reauthLinks.usedAt),
    isNull(reauthLinks.revokedAt),
    gt(reauthLinks.expiresAt, now)
  );

// Creating a link revokes the account's previous one in the same transaction.
export const createReauthLink = async (
  database: Database,
  input: { providerAccountId: string; token: string; expiresAt: number },
  now: number
): Promise<ReauthLinkSummary> => {
  await database.batch([
    database
      .update(reauthLinks)
      .set({ revokedAt: now })
      .where(
        and(
          eq(reauthLinks.providerAccountId, input.providerAccountId),
          isNull(reauthLinks.usedAt),
          isNull(reauthLinks.revokedAt)
        )
      ),
    database.insert(reauthLinks).values({
      id: crypto.randomUUID(),
      providerAccountId: input.providerAccountId,
      tokenHash: hashReauthToken(input.token),
      expiresAt: input.expiresAt,
      createdAt: now,
    }),
  ]);
  return { expiresAt: input.expiresAt, createdAt: now };
};

export const revokeReauthLink = async (
  database: Database,
  providerAccountId: string,
  now: number
): Promise<boolean> => {
  const result = await database
    .update(reauthLinks)
    .set({ revokedAt: now })
    .where(
      and(eq(reauthLinks.providerAccountId, providerAccountId), isOpen(now))
    );
  return result.rowsAffected > 0;
};

// The token is looked up by its hash, so no comparison runs on the token.
export const findOpenReauthLink = async (
  database: Database,
  token: string,
  now: number
): Promise<{
  link: ReauthLinkRecord;
  account: ProviderAccountRecord;
} | null> => {
  const [row] = await database
    .select({ link: reauthLinks, account: providerAccounts })
    .from(reauthLinks)
    .innerJoin(
      providerAccounts,
      eq(providerAccounts.id, reauthLinks.providerAccountId)
    )
    .where(and(eq(reauthLinks.tokenHash, hashReauthToken(token)), isOpen(now)))
    .limit(1);
  return row
    ? { link: row.link, account: toProviderAccountRecord(row.account) }
    : null;
};

export const setReauthLinkOAuthState = async (
  database: Database,
  linkId: string,
  state: string,
  now: number
): Promise<boolean> => {
  const result = await database
    .update(reauthLinks)
    .set({ oauthState: state })
    .where(and(eq(reauthLinks.id, linkId), isOpen(now)));
  return result.rowsAffected > 0;
};

// Only one completion can claim the link; the claim is the used_at time.
export const claimReauthLink = async (
  database: Database,
  linkId: string,
  now: number
): Promise<boolean> => {
  const result = await database
    .update(reauthLinks)
    .set({ usedAt: now })
    .where(and(eq(reauthLinks.id, linkId), isOpen(now)));
  return result.rowsAffected > 0;
};

// Reopens a claimed link whose sign-in was not saved, unless the admin has
// created a newer link meanwhile.
export const releaseReauthLink = async (
  database: Database,
  linkId: string,
  claimedAt: number
): Promise<void> => {
  await database
    .update(reauthLinks)
    .set({ usedAt: null })
    .where(
      and(
        eq(reauthLinks.id, linkId),
        eq(reauthLinks.usedAt, claimedAt),
        sql`not exists (select 1 from "reauth_links" as "other" where "other"."provider_account_id" = "reauth_links"."provider_account_id" and "other"."used_at" is null and "other"."revoked_at" is null)`
      )
    );
};

// Returns whether the link is now revoked; it is once it reaches the cap.
export const recordReauthLinkFailure = async (
  database: Database,
  linkId: string,
  maxFailedAttempts: number,
  now: number
): Promise<boolean> => {
  const [row] = await database
    .update(reauthLinks)
    .set({
      failedAttempts: sql`${reauthLinks.failedAttempts} + 1`,
      revokedAt: sql`case when ${reauthLinks.failedAttempts} + 1 >= ${maxFailedAttempts} then ${now} else ${reauthLinks.revokedAt} end`,
    })
    .where(and(eq(reauthLinks.id, linkId), isOpen(now)))
    .returning({ revokedAt: reauthLinks.revokedAt });
  return typeof row?.revokedAt === "number";
};

export const listProviderAccountsWithReauthLinks = async (
  database: Database,
  now: number
): Promise<{
  accounts: ProviderAccountRecord[];
  reauthLinks: Map<string, ReauthLinkSummary>;
}> => {
  const [accounts, links] = await database.batch([
    selectProviderAccounts(database),
    database
      .select({
        providerAccountId: reauthLinks.providerAccountId,
        expiresAt: reauthLinks.expiresAt,
        createdAt: reauthLinks.createdAt,
      })
      .from(reauthLinks)
      .where(isOpen(now)),
  ]);
  return {
    accounts: accounts.map(toProviderAccountRecord),
    reauthLinks: new Map(
      links.map(({ providerAccountId, ...link }) => [providerAccountId, link])
    ),
  };
};
