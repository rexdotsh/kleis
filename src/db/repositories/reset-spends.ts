import { and, eq, lt, sql } from "drizzle-orm";

import type { Database } from "../index";
import { type Provider, resetSpends } from "../schema";

// A pending spend older than this stops blocking its account.
const PENDING_EXPIRES_MS = 3 * 60_000;

// Records a pending spend with a new request ID. Refused while the account
// has a pending spend, or one that settled or expired after `observedAt`, the
// time the discovery data the spend was checked against was read. Settle
// times are taken after the upstream answered, so a read started at that
// time already shows the outcome.
export const startResetSpend = async (
  database: Database,
  spend: { provider: Provider; providerAccountId: string; itemId: string },
  observedAt: number,
  now = Date.now()
): Promise<{ requestId: string } | { blocked: "in_progress" | "stale" }> => {
  const requestId = crypto.randomUUID();
  const account = spend.providerAccountId;
  const [, inserted, pending] = await database.batch([
    database
      .update(resetSpends)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(resetSpends.providerAccountId, account),
          eq(resetSpends.status, "pending"),
          lt(resetSpends.createdAt, now - PENDING_EXPIRES_MS)
        )
      ),
    database.run(sql`
      insert into reset_spends (request_id, provider, provider_account_id,
        item_id, status, created_at, updated_at)
      select ${requestId}, ${spend.provider}, ${account}, ${spend.itemId},
        'pending', ${now}, ${now}
      where not exists (
        select 1 from reset_spends where provider_account_id = ${account}
          and (status = 'pending' or updated_at > ${observedAt})
      )`),
    database
      .select({ requestId: resetSpends.requestId })
      .from(resetSpends)
      .where(
        and(
          eq(resetSpends.providerAccountId, account),
          eq(resetSpends.status, "pending")
        )
      ),
  ]);
  if (inserted.rowsAffected) return { requestId };
  return { blocked: pending.length ? "in_progress" : "stale" };
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
