import { and, eq, lt } from "drizzle-orm";

import type { Database } from "../index";
import { type Provider, resetSpends } from "../schema";

// A pending spend older than this stops blocking its account. The next spend
// resends its request ID, which the upstream answers as a replay.
const PENDING_EXPIRES_MS = 3 * 60_000;

// Returns the request ID to send, or null while another spend is pending.
export const startResetSpend = async (
  database: Database,
  spend: { provider: Provider; providerAccountId: string; itemId: string },
  now = Date.now()
): Promise<string | null> => {
  const [expired] = await database
    .update(resetSpends)
    .set({ itemId: spend.itemId, updatedAt: now })
    .where(
      and(
        eq(resetSpends.providerAccountId, spend.providerAccountId),
        eq(resetSpends.status, "pending"),
        lt(resetSpends.updatedAt, now - PENDING_EXPIRES_MS)
      )
    )
    .returning({ requestId: resetSpends.requestId });
  if (expired) return expired.requestId;
  const requestId = crypto.randomUUID();
  const inserted = await database
    .insert(resetSpends)
    .values({
      ...spend,
      requestId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ requestId: resetSpends.requestId });
  return inserted.length ? requestId : null;
};

export const settleResetSpend = async (
  database: Database,
  requestId: string,
  status: "completed" | "failed"
): Promise<void> => {
  await database
    .update(resetSpends)
    .set({ status, updatedAt: Date.now() })
    .where(
      and(
        eq(resetSpends.requestId, requestId),
        eq(resetSpends.status, "pending")
      )
    );
};
