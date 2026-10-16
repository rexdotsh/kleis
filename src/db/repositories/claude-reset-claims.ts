import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";

import type { Database } from "../index";
import {
  claudeResetClaimFences,
  claudeResetClaims,
  providerAccounts,
} from "../schema";
import {
  type ProviderAccountRecord,
  toProviderAccountRecord,
} from "./provider-accounts";

export type ClaudeResetClaimRow = typeof claudeResetClaims.$inferSelect;
export type ClaudeResetClaimFenceRow =
  typeof claudeResetClaimFences.$inferSelect;
export type ClaudeResetClaimIdentity = Pick<
  ClaudeResetClaimRow,
  "accountIdentity" | "organizationUuid"
>;

export class ClaudeResetReservationConflict extends Error {
  constructor() {
    super("The reset reservation changed; review the offer again");
    this.name = "ClaudeResetReservationConflict";
  }
}

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
  fences: ClaudeResetClaimFenceRow[];
}> => {
  const [accountRows, claims, fences] = await database.batch([
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
    database.select().from(claudeResetClaimFences),
  ]);
  return { accounts: accountRows.map(toProviderAccountRecord), claims, fences };
};

const sameIdentity = (
  table: typeof claudeResetClaims | typeof claudeResetClaimFences,
  identity: ClaudeResetClaimIdentity
) =>
  and(
    eq(table.accountIdentity, identity.accountIdentity),
    eq(table.organizationUuid, identity.organizationUuid)
  );

export const readClaudeResetClaimLedger = async (
  database: Database,
  identity: ClaudeResetClaimIdentity,
  since: number
): Promise<{ version: number; claims: ClaudeResetClaimRow[] }> => {
  const [, fences, claims] = await database.batch([
    database
      .insert(claudeResetClaimFences)
      .values(identity)
      .onConflictDoNothing(),
    database
      .select()
      .from(claudeResetClaimFences)
      .where(sameIdentity(claudeResetClaimFences, identity)),
    database
      .select()
      .from(claudeResetClaims)
      .where(
        and(sameIdentity(claudeResetClaims, identity), relevantClaims(since))
      )
      .orderBy(desc(claudeResetClaims.updatedAt)),
  ]);
  const fence = fences[0];
  if (!fence) throw new Error("Claude reset claim fence is missing");
  return { version: fence.version, claims };
};

// Atomically advances the identity's version, which must still be the one the
// claim was validated against, then records `claim` as pending. The open
// claim read with that version is reopened when `claim` reuses its request
// ID, and closed otherwise; it too must be unchanged.
export const reserveClaudeResetClaim = async (
  database: Database,
  claim: Omit<ClaudeResetClaimRow, "status">,
  version: number,
  open: Pick<ClaudeResetClaimRow, "requestId" | "updatedAt"> | null
): Promise<void> => {
  const reopen = open?.requestId === claim.requestId;
  await database.transaction(async (tx) => {
    const fenced = await tx
      .update(claudeResetClaimFences)
      .set({ version: sql`${claudeResetClaimFences.version} + 1` })
      .where(
        and(
          sameIdentity(claudeResetClaimFences, claim),
          eq(claudeResetClaimFences.version, version)
        )
      )
      .returning({ version: claudeResetClaimFences.version });
    if (!fenced.length) throw new ClaudeResetReservationConflict();
    if (open) {
      const updated = await tx
        .update(claudeResetClaims)
        .set({
          status: reopen ? "pending" : "reconciled",
          updatedAt: claim.updatedAt,
        })
        .where(
          and(
            sameIdentity(claudeResetClaims, claim),
            eq(claudeResetClaims.requestId, open.requestId),
            eq(claudeResetClaims.updatedAt, open.updatedAt),
            inArray(claudeResetClaims.status, activeStatuses)
          )
        )
        .returning({ requestId: claudeResetClaims.requestId });
      if (!updated.length) throw new ClaudeResetReservationConflict();
    }
    if (!reopen) {
      await tx
        .insert(claudeResetClaims)
        .values({ ...claim, status: "pending" });
    }
  });
};

export const settleClaudeResetClaim = async (
  database: Database,
  requestId: string,
  status: "ambiguous" | "completed" | "failed"
): Promise<void> => {
  await database
    .update(claudeResetClaims)
    .set({ status, updatedAt: Date.now() })
    .where(
      and(
        eq(claudeResetClaims.requestId, requestId),
        eq(claudeResetClaims.status, "pending")
      )
    );
};
