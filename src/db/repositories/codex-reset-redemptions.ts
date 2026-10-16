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
const openStatuses = ["pending", "ambiguous", "retryable"];
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

const matchingRows = (
  rows: Awaited<ReturnType<typeof openRows>>,
  identity: string
): Redemption[] =>
  rows
    .filter(
      (row) =>
        (row.redemption.accountIdentity ??
          codexResetAccountIdentity({
            accountId: row.accountId,
            metadata: parseProviderAccountMetadata(row.metadataJson),
          })) === identity
    )
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
  return {
    generation: fences[0]?.generation ?? 0,
    pending:
      claims.find((row) => row.accountIdentity !== null) ?? claims[0] ?? null,
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
    if (existing && originalIdentity !== input.accountIdentity) {
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
      claims.find((row) => row.accountIdentity !== null) ??
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
    if (!open) {
      const fence = await tx.query.codexResetCreditFences.findFirst({
        where: eq(
          codexResetCreditFences.accountIdentity,
          input.accountIdentity
        ),
      });
      if (
        existing ||
        !input.creditId ||
        input.offerGeneration == null ||
        input.offerGeneration !== (fence?.generation ?? 0)
      ) {
        throw new CodexResetReservationConflict(
          "Reset-credit offer changed or is missing. Refresh limits and confirm the displayed credit again.",
          null
        );
      }
    }
    if (!open?.accountIdentity) await advanceFence(tx, input.accountIdentity);
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
  await database
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
