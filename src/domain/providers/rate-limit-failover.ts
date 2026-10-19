import type { Database } from "../../db";
import { createLookupCache } from "../../db/lookup-cache";
import {
  listProviderAccounts,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import { getRateLimitFailoverEnabled } from "../../db/repositories/proxy-settings";
import type { Provider } from "../../db/schema";
import { accountCooldowns } from "../../providers/account-tracking/rate-limit-cooldowns";
import {
  findPinnedProviderAccounts,
  getPreferredProviderAccount,
} from "./provider-service";

const accountsCache = createLookupCache<ProviderAccountRecord[]>(15_000);

export const getProviderAccountRouting = async (
  database: Database,
  provider: Provider,
  allowedAccountIds: readonly string[] | null
) => {
  const enabled = await getRateLimitFailoverEnabled(database);
  const preferred = await getPreferredProviderAccount(database, provider, {
    allowedAccountIds,
  });
  if (!preferred) return { enabled, preferred, candidates: [] };
  if (!enabled) return { enabled, preferred, candidates: [preferred] };
  const pinned = await findPinnedProviderAccounts(
    database,
    provider,
    allowedAccountIds
  );
  const accounts = pinned.length
    ? pinned
    : await accountsCache.get(database, "all", () =>
        listProviderAccounts(database)
      );
  // Exclusion fences fallback traffic; explicit primary/pin routing still works.
  const candidates = [
    preferred,
    ...accounts
      .filter(
        (account) =>
          account.id !== preferred.id &&
          account.provider === provider &&
          account.enabled &&
          !account.excludeFromFailover
      )
      .sort(
        (left, right) =>
          right.createdAt - left.createdAt || left.id.localeCompare(right.id)
      ),
  ];
  return { enabled, preferred, candidates };
};

export const availableFailoverAccounts = (
  accounts: readonly ProviderAccountRecord[]
): ProviderAccountRecord[] =>
  accounts.filter((account) => !accountCooldowns.get(account));
