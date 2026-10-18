import { and, eq, lt } from "drizzle-orm";

import type { Database } from "../index";
import type { ResetSpendLedger } from "../schema";

// A pending spend older than this stops blocking its account. The next spend
// resends its request ID, which the upstream answers as a replay.
const PENDING_EXPIRES_MS = 3 * 60_000;

// Returns the request ID to send, or null while another spend is pending.
export const startResetSpend = async (
  database: Database,
  ledger: ResetSpendLedger,
  providerAccountId: string,
  itemId: string,
  now = Date.now()
): Promise<string | null> => {
  const [expired] = await database
    .update(ledger)
    .set({ itemId, updatedAt: now })
    .where(
      and(
        eq(ledger.providerAccountId, providerAccountId),
        eq(ledger.status, "pending"),
        lt(ledger.updatedAt, now - PENDING_EXPIRES_MS)
      )
    )
    .returning({ requestId: ledger.requestId });
  if (expired) return expired.requestId;
  const requestId = crypto.randomUUID();
  const inserted = await database
    .insert(ledger)
    .values({
      requestId,
      providerAccountId,
      itemId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ requestId: ledger.requestId });
  return inserted.length ? requestId : null;
};

export const settleResetSpend = async (
  database: Database,
  ledger: ResetSpendLedger,
  requestId: string,
  status: "completed" | "failed",
  resultCode: string | null
): Promise<void> => {
  await database
    .update(ledger)
    .set({ status, resultCode, updatedAt: Date.now() })
    .where(and(eq(ledger.requestId, requestId), eq(ledger.status, "pending")));
};
