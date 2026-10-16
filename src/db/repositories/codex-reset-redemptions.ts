import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { Database } from "../index";
import {
  codexResetCreditRedemptions,
  codexResetCreditFences,
  providerAccounts,
} from "../schema";
import {
  parseProviderAccountMetadata,
  type ProviderAccountMetadata,
} from "../../providers/metadata";

type Redemption = typeof codexResetCreditRedemptions.$inferSelect;
type Reservation = Redemption & {
  accountIdentity: string;
  executionToken: string;
};
const openStatuses = ["pending", "ambiguous", "retryable", "legacy_ambiguous"];
const orphanAfterMs = 120_000;

export const codexResetAccountIdentity = (account: {
  accountId: string | null;
  metadata: ProviderAccountMetadata | null;
}): string | null => {
  const metadataIdentity =
    account.metadata?.provider === "codex"
      ? account.metadata.chatgptAccountId
      : null;
  if (
    account.accountId &&
    metadataIdentity &&
    account.accountId !== metadataIdentity
  )
    return null;
  return account.accountId ?? metadataIdentity;
};

export class CodexResetReservationConflict extends Error {
  constructor(
    message: string,
    readonly redeemRequestId: string | null
  ) {
    super(message);
  }
}

export class CodexResetIdentityUnverified extends Error {
  constructor() {
    super(
      "Cannot remove or change this account while an older reset has no verified login identity. Reauthorize this same account, or review its pending reset in Codex settings first."
    );
  }
}

export const preserveCodexResetIdentity = async (
  database: Pick<Database, "query" | "update">,
  providerAccountId: string,
  verifiedIdentity?: string | null,
  originalAccount?: typeof providerAccounts.$inferSelect
): Promise<void> => {
  const account =
    originalAccount ??
    (await database.query.providerAccounts.findFirst({
      where: eq(providerAccounts.id, providerAccountId),
    }));
  if (account?.provider !== "codex") return;
  const rows = await database.query.codexResetCreditRedemptions.findMany({
    where: and(
      eq(codexResetCreditRedemptions.providerAccountId, providerAccountId),
      isNull(codexResetCreditRedemptions.accountIdentity)
    ),
  });
  if (!rows.length) return;
  const identity =
    codexResetAccountIdentity({
      accountId: account.accountId,
      metadata: parseProviderAccountMetadata(account.metadataJson),
    }) ?? verifiedIdentity;
  if (!identity) {
    if (rows.some((row) => openStatuses.includes(row.status)))
      throw new CodexResetIdentityUnverified();
    return;
  }
  // Historical duplicates retain their uncertainty outside the active unique index.
  await database
    .update(codexResetCreditRedemptions)
    .set({
      accountIdentity: identity,
      status: sql`case when ${codexResetCreditRedemptions.status} in ('pending', 'ambiguous', 'retryable') then 'legacy_ambiguous' else ${codexResetCreditRedemptions.status} end`,
    })
    .where(
      and(
        eq(codexResetCreditRedemptions.providerAccountId, providerAccountId),
        isNull(codexResetCreditRedemptions.accountIdentity)
      )
    );
};

export const findCodexResetCreditRedemption = (
  database: Database,
  redeemRequestId: string
) =>
  database.query.codexResetCreditRedemptions.findFirst({
    where: eq(codexResetCreditRedemptions.redeemRequestId, redeemRequestId),
  });

export const saveCodexResetCreditRedemption = async (
  database: Pick<Database, "insert">,
  input: typeof codexResetCreditRedemptions.$inferInsert
): Promise<void> => {
  await database
    .insert(codexResetCreditRedemptions)
    .values(input)
    .onConflictDoUpdate({
      target: codexResetCreditRedemptions.redeemRequestId,
      set: {
        status: input.status,
        resultCode: input.resultCode,
        windowsReset: input.windowsReset,
        lastError: input.lastError,
        updatedAt: input.updatedAt,
      },
    });
};

// Unbound rows block fresh claims while their original IDs are reconciled.
const openRows = (database: Pick<Database, "select">, identity: string) =>
  database
    .select({
      redemption: codexResetCreditRedemptions,
      accountId: providerAccounts.accountId,
      metadataJson: providerAccounts.metadataJson,
    })
    .from(codexResetCreditRedemptions)
    .leftJoin(
      providerAccounts,
      eq(providerAccounts.id, codexResetCreditRedemptions.providerAccountId)
    )
    .where(
      and(
        inArray(codexResetCreditRedemptions.status, openStatuses),
        or(
          eq(codexResetCreditRedemptions.accountIdentity, identity),
          isNull(codexResetCreditRedemptions.accountIdentity)
        )
      )
    )
    .orderBy(asc(codexResetCreditRedemptions.createdAt));

const rowIdentity = (row: Awaited<ReturnType<typeof openRows>>[number]) =>
  row.redemption.accountIdentity ??
  codexResetAccountIdentity({
    accountId: row.accountId,
    metadata: parseProviderAccountMetadata(row.metadataJson),
  });

const matchingRows = (
  rows: Awaited<ReturnType<typeof openRows>>,
  identity: string
): Redemption[] =>
  rows
    .filter((row) => rowIdentity(row) === identity || rowIdentity(row) === null)
    .map((row) => row.redemption);

export const readCodexResetCreditState = async (
  database: Database,
  accountIdentity: string
) => {
  const [fences, rows] = await database.batch([
    database
      .select()
      .from(codexResetCreditFences)
      .where(eq(codexResetCreditFences.accountIdentity, accountIdentity)),
    openRows(database, accountIdentity),
  ]);
  const claims = matchingRows(rows, accountIdentity);
  const pending =
    claims.find(
      (row) => row.accountIdentity !== null && row.status !== "legacy_ambiguous"
    ) ??
    claims[0] ??
    null;
  return {
    generation: fences[0]?.generation ?? 0,
    pending,
    unverified: rows.some(
      (row) =>
        row.redemption.redeemRequestId === pending?.redeemRequestId &&
        rowIdentity(row) === null
    ),
  };
};

const advanceFence = async (
  database: Pick<Database, "insert">,
  accountIdentity: string
): Promise<void> => {
  await database
    .insert(codexResetCreditFences)
    .values({ accountIdentity, generation: 1 })
    .onConflictDoUpdate({
      target: codexResetCreditFences.accountIdentity,
      set: { generation: sql`${codexResetCreditFences.generation} + 1` },
    });
};

export const reserveCodexResetCredit = async (
  database: Database,
  input: {
    accountIdentity: string;
    providerAccountId: string;
    redeemRequestId: string;
    creditId: string | null;
    offerGeneration?: number | null;
    recovery?: "spend" | "resolve" | "review" | null;
    now: number;
  }
): Promise<
  | { completed: Redemption; reservation?: never }
  | { reservation: Reservation; completed?: never }
> =>
  database.transaction(async (tx) => {
    const existing = await tx.query.codexResetCreditRedemptions.findFirst({
      where: eq(
        codexResetCreditRedemptions.redeemRequestId,
        input.redeemRequestId
      ),
    });
    const original =
      existing && !existing.accountIdentity
        ? await tx.query.providerAccounts.findFirst({
            where: eq(providerAccounts.id, existing.providerAccountId),
          })
        : null;
    const originalIdentity =
      existing?.accountIdentity ??
      (original
        ? codexResetAccountIdentity({
            accountId: original.accountId,
            metadata: parseProviderAccountMetadata(original.metadataJson),
          })
        : null);
    if (
      existing &&
      originalIdentity &&
      originalIdentity !== input.accountIdentity
    ) {
      throw new CodexResetReservationConflict(
        "This reset-credit redemption belongs to another account identity. Reconnect the original account before checking its result.",
        null
      );
    }
    const claims = matchingRows(
      await openRows(tx, input.accountIdentity),
      input.accountIdentity
    );
    if (
      existing &&
      (existing.status === "completed" || existing.resultCode !== null)
    ) {
      if (
        openStatuses.includes(existing.status) &&
        existing.updatedAt <= input.now - orphanAfterMs
      ) {
        await tx
          .update(codexResetCreditRedemptions)
          .set({
            status: "completed",
            executionToken: null,
            accountIdentity: input.accountIdentity,
            updatedAt: input.now,
          })
          .where(
            eq(
              codexResetCreditRedemptions.redeemRequestId,
              input.redeemRequestId
            )
          );
        await advanceFence(tx, input.accountIdentity);
      }
      return { completed: existing };
    }
    const open =
      claims.find(
        (row) =>
          row.accountIdentity !== null && row.status !== "legacy_ambiguous"
      ) ??
      claims.find((row) => row.redeemRequestId === input.redeemRequestId) ??
      claims[0];
    if (open && open.redeemRequestId !== input.redeemRequestId) {
      throw new CodexResetReservationConflict(
        "Another reset-credit redemption is pending or may have spent a credit. Retry only that original request; do not start a new redemption.",
        open.redeemRequestId
      );
    }
    if (open?.executionToken && open.updatedAt > input.now - orphanAfterMs) {
      throw new CodexResetReservationConflict(
        "This reset-credit redemption is already in progress. Wait before retrying the same request.",
        open.redeemRequestId
      );
    }
    {
      const fence = await tx.query.codexResetCreditFences.findFirst({
        where: eq(
          codexResetCreditFences.accountIdentity,
          input.accountIdentity
        ),
      });
      if (
        (!open && (existing || !input.creditId)) ||
        (open && !input.recovery) ||
        input.offerGeneration == null ||
        input.offerGeneration !== (fence?.generation ?? 0)
      ) {
        throw new CodexResetReservationConflict(
          open
            ? "Check fresh credit availability and confirm the current warning before retrying this original request."
            : "Reset-credit offer changed or is missing. Refresh limits and confirm the displayed credit again.",
          open?.redeemRequestId ?? null
        );
      }
    }
    if (input.recovery === "resolve" || input.recovery === "review") {
      if (!open || open.updatedAt > input.now - orphanAfterMs)
        throw new CodexResetReservationConflict(
          "Wait for a later credit sync before reviewing this uncertain result.",
          input.redeemRequestId
        );
      const [closed] = await tx
        .update(codexResetCreditRedemptions)
        .set({
          status: "completed",
          accountIdentity: originalIdentity ?? input.accountIdentity,
          resultCode:
            input.recovery === "resolve" ? "already_redeemed" : "reconciled",
          executionToken: null,
          updatedAt: input.now,
        })
        .where(
          eq(codexResetCreditRedemptions.redeemRequestId, input.redeemRequestId)
        )
        .returning();
      if (!closed) throw new Error("Reset reconciliation failed");
      await advanceFence(tx, input.accountIdentity);
      return { completed: closed };
    }
    if (open && (!originalIdentity || !open.creditId))
      throw new CodexResetReservationConflict(
        "Review this legacy reset in Codex settings; its identity or original credit cannot be verified for spending.",
        input.redeemRequestId
      );
    await advanceFence(tx, input.accountIdentity);
    const reservation: Reservation = {
      redeemRequestId: input.redeemRequestId,
      providerAccountId: existing?.providerAccountId ?? input.providerAccountId,
      accountIdentity: input.accountIdentity,
      creditId: open ? open.creditId : input.creditId,
      executionToken: crypto.randomUUID(),
      status: "pending",
      resultCode: null,
      windowsReset: null,
      lastError: null,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    await tx
      .insert(codexResetCreditRedemptions)
      .values(reservation)
      .onConflictDoUpdate({
        target: codexResetCreditRedemptions.redeemRequestId,
        set: {
          accountIdentity: reservation.accountIdentity,
          executionToken: reservation.executionToken,
          status: "pending",
          resultCode: null,
          windowsReset: null,
          lastError: null,
          updatedAt: input.now,
        },
      });
    return { reservation };
  });

const ownedExecution = (reservation: Reservation) =>
  and(
    eq(
      codexResetCreditRedemptions.redeemRequestId,
      reservation.redeemRequestId
    ),
    eq(
      codexResetCreditRedemptions.accountIdentity,
      reservation.accountIdentity
    ),
    eq(codexResetCreditRedemptions.executionToken, reservation.executionToken),
    inArray(codexResetCreditRedemptions.status, openStatuses)
  );

export const settleCodexResetCredit = async (
  database: Database,
  reservation: Reservation,
  outcome: Pick<
    Redemption,
    "status" | "resultCode" | "windowsReset" | "lastError"
  >,
  now: number
): Promise<void> => {
  await database.transaction(async (tx) => {
    const result = await tx
      .update(codexResetCreditRedemptions)
      .set({
        ...outcome,
        // Keep the ledger lock through the quota refresh, even with a known result.
        status: outcome.status === "completed" ? "pending" : "ambiguous",
        executionToken:
          outcome.status === "completed" ? reservation.executionToken : null,
        updatedAt: now,
      })
      .where(ownedExecution(reservation));
    if (result.rowsAffected && outcome.status !== "completed")
      await advanceFence(tx, reservation.accountIdentity);
  });
};

export const finishCodexResetCredit = async (
  database: Database,
  reservation: Reservation,
  status: "completed" | "failed" = "completed"
): Promise<void> => {
  await database.transaction(async (tx) => {
    const result = await tx
      .update(codexResetCreditRedemptions)
      .set({ status, executionToken: null, updatedAt: Date.now() })
      .where(
        and(
          ownedExecution(reservation),
          status === "completed"
            ? isNotNull(codexResetCreditRedemptions.resultCode)
            : undefined
        )
      );
    if (result.rowsAffected)
      await advanceFence(tx, reservation.accountIdentity);
  });
};
