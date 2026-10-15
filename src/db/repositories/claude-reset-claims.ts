import { and, desc, eq, gt, inArray, or } from "drizzle-orm";

import type { Database } from "../index";
import { claudeResetClaims, providerAccounts } from "../schema";
import {
  type ProviderAccountRecord,
  toProviderAccountRecord,
} from "./provider-accounts";

export type ClaudeResetClaimRow = typeof claudeResetClaims.$inferSelect;

const activeStatuses = ["pending", "ambiguous"] as const;

// Open claims, plus any settled since `since`: a reset offer read before a
// claim settled is out of date, even when another process made the claim.
const relevantClaims = (since: number) =>
  or(
    inArray(claudeResetClaims.status, activeStatuses),
    gt(claudeResetClaims.updatedAt, since)
  );

export const listProviderAccountsWithClaudeResetClaims = async (
  database: Database,
  since: number
): Promise<{
  accounts: ProviderAccountRecord[];
  claims: ClaudeResetClaimRow[];
}> => {
  const [accountRows, claims] = await database.batch([
    database
      .select()
      .from(providerAccounts)
      .orderBy(
        desc(providerAccounts.isPrimary),
        desc(providerAccounts.createdAt)
      ),
    database
      .select()
      .from(claudeResetClaims)
      .where(relevantClaims(since))
      .orderBy(desc(claudeResetClaims.updatedAt)),
  ]);
  return { accounts: accountRows.map(toProviderAccountRecord), claims };
};

export const listClaudeResetClaims = (
  database: Database,
  providerAccountId: string,
  since: number
): Promise<ClaudeResetClaimRow[]> =>
  database
    .select()
    .from(claudeResetClaims)
    .where(
      and(
        eq(claudeResetClaims.providerAccountId, providerAccountId),
        relevantClaims(since)
      )
    )
    .orderBy(desc(claudeResetClaims.updatedAt));

// Fails on the unique index when the account identity already has an open
// claim, which is what keeps two processes from claiming at once.
export const insertClaudeResetClaim = async (
  database: Database,
  claim: typeof claudeResetClaims.$inferInsert,
  closing: { requestId: string; updatedAt: number } | null
): Promise<void> => {
  const insert = database.insert(claudeResetClaims).values(claim);
  if (!closing) {
    await insert;
    return;
  }
  await database.batch([
    database
      .update(claudeResetClaims)
      .set({ status: "reconciled", updatedAt: claim.createdAt })
      .where(
        and(
          eq(claudeResetClaims.requestId, closing.requestId),
          eq(claudeResetClaims.updatedAt, closing.updatedAt)
        )
      ),
    insert,
  ]);
};

// Moves an open claim back to pending only if nobody touched it since it was
// read; returns false when another attempt got there first.
export const reopenClaudeResetClaim = async (
  database: Database,
  claim: { requestId: string; updatedAt: number; offerKey: string },
  now: number
): Promise<boolean> => {
  const rows = await database
    .update(claudeResetClaims)
    .set({
      status: "pending",
      offerKey: claim.offerKey,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(claudeResetClaims.requestId, claim.requestId),
        eq(claudeResetClaims.updatedAt, claim.updatedAt),
        inArray(claudeResetClaims.status, activeStatuses)
      )
    )
    .returning({ requestId: claudeResetClaims.requestId });
  return rows.length > 0;
};

export const settleClaudeResetClaim = async (
  database: Database,
  requestId: string,
  settlement: Pick<
    typeof claudeResetClaims.$inferInsert,
    | "status"
    | "result"
    | "reason"
    | "resetsLeft"
    | "clearedJson"
    | "weeklyResetsAt"
    | "lastError"
    | "updatedAt"
  >
): Promise<void> => {
  await database
    .update(claudeResetClaims)
    .set(settlement)
    .where(
      and(
        eq(claudeResetClaims.requestId, requestId),
        eq(claudeResetClaims.status, "pending")
      )
    );
};
