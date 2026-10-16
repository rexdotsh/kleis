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

const matchingIdentity = (identity: ClaudeResetClaimIdentity) =>
  and(
    eq(claudeResetClaims.accountIdentity, identity.accountIdentity),
    eq(claudeResetClaims.organizationUuid, identity.organizationUuid)
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
      .where(
        and(
          eq(claudeResetClaimFences.accountIdentity, identity.accountIdentity),
          eq(claudeResetClaimFences.organizationUuid, identity.organizationUuid)
        )
      ),
    database
      .select()
      .from(claudeResetClaims)
      .where(and(matchingIdentity(identity), relevantClaims(since)))
      .orderBy(desc(claudeResetClaims.updatedAt)),
  ]);
  const fence = fences[0];
  if (!fence) throw new Error("Claude reset claim fence is missing");
  return { version: fence.version, claims };
};

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const advanceFence = async (
  tx: Transaction,
  identity: ClaudeResetClaimIdentity,
  version: number
): Promise<void> => {
  const rows = await tx
    .update(claudeResetClaimFences)
    .set({ version: sql`${claudeResetClaimFences.version} + 1` })
    .where(
      and(
        eq(claudeResetClaimFences.accountIdentity, identity.accountIdentity),
        eq(claudeResetClaimFences.organizationUuid, identity.organizationUuid),
        eq(claudeResetClaimFences.version, version)
      )
    )
    .returning({ version: claudeResetClaimFences.version });
  if (!rows.length) throw new ClaudeResetReservationConflict();
};

// The version read with the validated ledger must still own this reservation,
// including when a competing claim has already settled.
export const insertClaudeResetClaim = async (
  database: Database,
  claim: typeof claudeResetClaims.$inferInsert,
  closing: { requestId: string; updatedAt: number } | null,
  version: number
): Promise<void> => {
  await database.transaction(async (tx) => {
    await advanceFence(tx, claim, version);
    if (closing) {
      const rows = await tx
        .update(claudeResetClaims)
        .set({ status: "reconciled", updatedAt: claim.createdAt })
        .where(
          and(
            matchingIdentity(claim),
            eq(claudeResetClaims.requestId, closing.requestId),
            eq(claudeResetClaims.updatedAt, closing.updatedAt),
            inArray(claudeResetClaims.status, activeStatuses)
          )
        )
        .returning({ requestId: claudeResetClaims.requestId });
      if (!rows.length) throw new ClaudeResetReservationConflict();
    }
    await tx.insert(claudeResetClaims).values(claim);
  });
};

// Both the identity version and open claim must still match the validated read.
export const reopenClaudeResetClaim = async (
  database: Database,
  claim: ClaudeResetClaimIdentity & {
    requestId: string;
    updatedAt: number;
    offerKey: string;
  },
  now: number,
  version: number
): Promise<void> => {
  await database.transaction(async (tx) => {
    await advanceFence(tx, claim, version);
    const rows = await tx
      .update(claudeResetClaims)
      .set({
        status: "pending",
        offerKey: claim.offerKey,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          matchingIdentity(claim),
          eq(claudeResetClaims.requestId, claim.requestId),
          eq(claudeResetClaims.updatedAt, claim.updatedAt),
          inArray(claudeResetClaims.status, activeStatuses)
        )
      )
      .returning({ requestId: claudeResetClaims.requestId });
    if (!rows.length) throw new ClaudeResetReservationConflict();
  });
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
