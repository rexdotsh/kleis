import type { Database } from "../../db";
import {
  type ProviderAccountSnapshotWrite,
  upsertProviderAccountSnapshots,
} from "../../db/repositories/provider-account-snapshots";
import { errorLogFields, logWarn } from "../../utils/log";

const MIN_WRITE_INTERVAL_MS = 5 * 60_000;
const FLUSH_TICK_MS = 30_000;

// What decides whether a new quota is worth writing at once: the plan, and the
// times the limit windows reset.
export type QuotaSignature = { plan: string | null; resets: number[] };

type SnapshotAccount = { id: string; accountId: string | null };

type Pending = ProviderAccountSnapshotWrite & { dueAt: number };

const isImmediateChange = (
  previous: QuotaSignature | undefined,
  next: QuotaSignature,
  now: number
): boolean => {
  if (!previous) {
    return false;
  }
  if (previous.plan !== next.plan) {
    return true;
  }
  return previous.resets.some(
    (resetAt) => resetAt <= now && !next.resets.includes(resetAt)
  );
};

const mergePending = (older: Pending, newer: Pending): Pending => {
  const sameIdentity = older.accountIdentity === newer.accountIdentity;
  const merged: Pending = {
    ...newer,
    dueAt: Math.min(older.dueAt, newer.dueAt),
  };
  if (sameIdentity && !newer.profile && older.profile) {
    merged.profile = older.profile;
  }
  if (sameIdentity && !newer.quota && older.quota) {
    merged.quota = older.quota;
  }
  return merged;
};

// Quota lookups run every minute or few; their snapshots are written at most
// every five minutes per account, unless the plan changed or a limit window
// reset. Profiles change rarely and are written at once.
export const createAccountSnapshotStore = (
  database: Database,
  options: { minWriteIntervalMs?: number; flushTickMs?: number } = {}
) => {
  const minWriteIntervalMs =
    options.minWriteIntervalMs ?? MIN_WRITE_INTERVAL_MS;
  let pending = new Map<string, Pending>();
  const lastWrittenAt = new Map<string, number>();
  const signatures = new Map<string, QuotaSignature>();
  let flushing: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const write = async (rows: Pending[]): Promise<void> => {
    try {
      await upsertProviderAccountSnapshots(database, rows);
      return;
    } catch (error) {
      if (rows.length === 1) {
        logWarn("account_snapshot_write_failed", {
          providerAccountId: rows[0]?.providerAccountId,
          ...errorLogFields(error),
        });
        return;
      }
    }
    // One deleted account must not drop everyone else's snapshot.
    for (const row of rows) {
      await write([row]);
    }
  };

  const flush = async (input: { onlyDue?: boolean } = {}): Promise<void> => {
    while (flushing) {
      await flushing;
    }
    const now = Date.now();
    const rows = Array.from(pending.values()).filter(
      (row) => !input.onlyDue || row.dueAt <= now
    );
    if (!rows.length) {
      return;
    }
    const remaining = new Map(pending);
    for (const row of rows) {
      remaining.delete(row.providerAccountId);
      lastWrittenAt.set(row.providerAccountId, now);
    }
    pending = remaining;
    flushing = write(rows).finally(() => {
      flushing = null;
    });
    await flushing;
  };

  const ensureTimer = (): void => {
    if (timer) {
      return;
    }
    timer = setInterval(() => {
      flush({ onlyDue: true }).catch(() => undefined);
    }, options.flushTickMs ?? FLUSH_TICK_MS);
    timer.unref?.();
  };

  const enqueue = (row: Pending): void => {
    const existing = pending.get(row.providerAccountId);
    pending.set(
      row.providerAccountId,
      existing ? mergePending(existing, row) : row
    );
    if (row.dueAt <= Date.now()) {
      flush({ onlyDue: true }).catch(() => undefined);
    } else {
      ensureTimer();
    }
  };

  return {
    // Accounts restored from the database start their write interval from the
    // stored snapshot, not from zero.
    seed(
      providerAccountId: string,
      writtenAt: number,
      signature: QuotaSignature | null
    ): void {
      lastWrittenAt.set(providerAccountId, writtenAt);
      if (signature) {
        signatures.set(providerAccountId, signature);
      }
    },
    recordQuota(
      account: SnapshotAccount,
      quota: {
        fetchedAt: number | null;
        error: string | null;
        errorStatus: number | null;
        data: unknown;
      },
      signature: QuotaSignature
    ): void {
      const now = Date.now();
      const immediate = isImmediateChange(
        signatures.get(account.id),
        signature,
        now
      );
      signatures.set(account.id, signature);
      const writtenAt = lastWrittenAt.get(account.id);
      enqueue({
        providerAccountId: account.id,
        accountIdentity: account.accountId ?? "",
        quota: {
          json: JSON.stringify(quota.data),
          fetchedAt: quota.fetchedAt,
          error: quota.error,
          errorStatus: quota.errorStatus,
        },
        updatedAt: now,
        dueAt:
          immediate || writtenAt === undefined
            ? now
            : writtenAt + minWriteIntervalMs,
      });
    },
    recordProfile(
      account: SnapshotAccount,
      profile: unknown,
      fetchedAt: number | null
    ): void {
      const now = Date.now();
      enqueue({
        providerAccountId: account.id,
        accountIdentity: account.accountId ?? "",
        profile: { json: JSON.stringify(profile), fetchedAt },
        updatedAt: now,
        dueAt: now,
      });
    },
    flush: (): Promise<void> => flush(),
    settled: async (): Promise<void> => {
      while (flushing) {
        await flushing;
      }
    },
    pendingCount: (): number => pending.size,
  };
};

export type AccountSnapshotStore = ReturnType<
  typeof createAccountSnapshotStore
>;
