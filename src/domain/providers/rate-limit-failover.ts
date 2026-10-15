import type { Database } from "../../db";
import { createLookupCache } from "../../db/lookup-cache";
import {
  listProviderAccounts,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import { getRateLimitFailoverEnabled } from "../../db/repositories/proxy-settings";
import type { Provider } from "../../db/schema";
import {
  readClaudeLiveLimits,
  readCodexLiveLimits,
} from "../../providers/account-tracking/live-limits";
import { logInfo } from "../../utils/log";
import {
  findPinnedProviderAccounts,
  getPreferredProviderAccount,
} from "./provider-service";

const accountsCache = createLookupCache<ProviderAccountRecord[]>(15_000);

// Explicit primary/pin routing wins over exclusion; exclusion fences fallback traffic.
export const failoverCandidates = (
  preferred: ProviderAccountRecord,
  accounts: readonly ProviderAccountRecord[],
  pinned: readonly ProviderAccountRecord[]
): ProviderAccountRecord[] => [
  preferred,
  ...(pinned.length ? pinned : accounts)
    .filter(
      (account) =>
        account.id !== preferred.id &&
        account.provider === preferred.provider &&
        account.enabled &&
        !account.excludeFromFailover
    )
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || left.id.localeCompare(right.id)
    ),
];

export const createAccountCooldowns = () => {
  const resets = new Map<string, number>();
  return {
    resetAt(id: string, now = Date.now()): number {
      const reset = resets.get(id) ?? 0;
      if (reset > now) return reset;
      resets.delete(id);
      return 0;
    },
    mark(id: string, reset: number, now = Date.now()): void {
      for (const [key, value] of resets) {
        if (value <= now) resets.delete(key);
      }
      resets.set(id, Math.max(resets.get(id) ?? 0, reset));
    },
  };
};

export const accountCooldowns = createAccountCooldowns();

export const readRateLimitReset = (
  provider: Provider,
  headers: Headers,
  now = Date.now()
): number => {
  const resets: number[] = [];
  const retryAfter = headers.get("retry-after");
  if (retryAfter?.trim()) {
    const seconds = Number(retryAfter);
    resets.push(
      Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter)
    );
  }
  if (provider === "claude") {
    const reset = headers.get("anthropic-ratelimit-unified-reset");
    if (reset) resets.push(Number(reset) * 1000);
    const limits = readClaudeLiveLimits(headers);
    for (const window of Object.values(limits?.windows ?? {})) {
      if ((window.utilization ?? 0) >= 100 && window.resetsAt) {
        resets.push(Date.parse(window.resetsAt));
      }
    }
  } else {
    const limits = readCodexLiveLimits(headers);
    for (const window of [limits?.primaryWindow, limits?.secondaryWindow]) {
      if (window && window.usedPercent >= 100 && window.resetAt) {
        resets.push(window.resetAt * 1000);
      }
    }
  }
  const future = resets.filter(
    (reset) => Number.isFinite(reset) && reset > now
  );
  return future.length ? Math.max(...future) : now + 30_000;
};

export const logRateLimitFailover = (
  from: ProviderAccountRecord,
  to: ProviderAccountRecord
): void => {
  logInfo("proxy_rate_limit_failover", {
    provider: from.provider,
    fromAccountId: from.id,
    toAccountId: to.id,
    resetInSeconds: Math.max(
      0,
      Math.ceil((accountCooldowns.resetAt(from.id) - Date.now()) / 1000)
    ),
  });
};

export const getProviderAccountRouting = async (
  database: Database,
  provider: Provider,
  allowedAccountIds: readonly string[] | null
) => {
  const enabled = await getRateLimitFailoverEnabled(database);
  const preferred = await getPreferredProviderAccount(database, provider, {
    allowedAccountIds,
  });
  if (!preferred)
    return { enabled, preferred, accounts: [], retryAfterSeconds: 0 };
  if (!enabled)
    return { enabled, preferred, accounts: [preferred], retryAfterSeconds: 0 };
  const pinned = await findPinnedProviderAccounts(
    database,
    provider,
    allowedAccountIds
  );
  const all = pinned.length
    ? pinned
    : await accountsCache.get(database, "all", () =>
        listProviderAccounts(database)
      );
  const candidates = failoverCandidates(preferred, all, pinned);
  const now = Date.now();
  const accounts = candidates.filter(
    (account) => !accountCooldowns.resetAt(account.id, now)
  );
  const nextReset = Math.min(
    ...candidates.map((account) => accountCooldowns.resetAt(account.id, now))
  );
  const retryAfterSeconds = accounts.length
    ? 0
    : Math.max(1, Math.ceil((nextReset - now) / 1000));
  return { enabled, preferred, accounts, retryAfterSeconds };
};
