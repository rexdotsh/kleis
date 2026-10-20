import type { Database } from "../../db";
import { createLookupCache } from "../../db/lookup-cache";
import {
  listProviderAccounts,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import { CLAUDE_ACCOUNT_ON_HOLD } from "../../providers/http";
import { toMillisecondsTimestamp } from "../../utils/timestamp";
import {
  type AccountQuota,
  getCachedProviderAccountQuota,
} from "./provider-account-tracking";

const accountCache = createLookupCache<ProviderAccountRecord[]>(15_000);
const REAUTHORIZE_WARNING_MS = 7 * 24 * 60 * 60_000;

const emptyCounts = () => ({
  total: 0,
  enabled: 0,
  healthy: 0,
  needsReauth: 0,
  onHold: 0,
  limited: 0,
});

const isExhausted = (
  percent: number | null | undefined,
  reset: number | string | null | undefined,
  now: number
): boolean => {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 100)
    return false;
  const resetsAt =
    typeof reset === "number"
      ? toMillisecondsTimestamp(reset)
      : typeof reset === "string"
        ? Date.parse(reset)
        : Number.NaN;
  return !Number.isFinite(resetsAt) || resetsAt > now;
};

const hasExhaustedLimits = (
  quota: AccountQuota | null,
  now: number
): boolean => {
  const data = quota?.data;
  if (data?.provider === "codex") {
    const status = data.status;
    return [
      status?.primaryWindow,
      status?.secondaryWindow,
      ...(status?.additionalRateLimits ?? []).flatMap((limit) => [
        limit.primaryWindow,
        limit.secondaryWindow,
      ]),
    ].some((window) =>
      isExhausted(
        window?.usedPercent,
        window?.resetAt ??
          (quota?.fetchedAt != null && window?.resetAfterSeconds != null
            ? quota.fetchedAt + window.resetAfterSeconds * 1000
            : null),
        now
      )
    );
  }
  if (data?.provider === "claude") {
    const usage = data.subscription;
    return (
      [
        usage?.fiveHour,
        usage?.sevenDay,
        ...Object.values(usage?.modelWindows ?? {}),
      ].some((window) =>
        isExhausted(window?.utilization, window?.resetsAt, now)
      ) ||
      (usage?.limits ?? []).some(
        (limit) =>
          limit.kind === "weekly_scoped" &&
          isExhausted(limit.percent, limit.resetsAt, now)
      )
    );
  }
  return false;
};

export const summarizeProviderAccountHealth = async (database: Database) => {
  const accounts = await accountCache.get(database, "all", () =>
    listProviderAccounts(database)
  );
  const summary = { codex: emptyCounts(), claude: emptyCounts() };
  const now = Date.now();
  for (const account of accounts) {
    if (account.ownerId !== null) continue;
    const counts = summary[account.provider];
    const quota = getCachedProviderAccountQuota(account);
    const deadline =
      account.metadata?.provider === "claude"
        ? account.metadata.refreshTokenExpiresAt
        : null;
    const needsReauth =
      !(account.expiresAt > now) ||
      Boolean(
        account.lastRefreshStatus && account.lastRefreshStatus !== "success"
      ) ||
      quota?.errorStatus === 401 ||
      quota?.errorStatus === 403 ||
      (typeof deadline === "number" && deadline - now < REAUTHORIZE_WARNING_MS);
    const onHold = account.lastRefreshStatus === CLAUDE_ACCOUNT_ON_HOLD;
    const limited = hasExhaustedLimits(quota, now);
    counts.total++;
    counts.enabled += Number(account.enabled);
    counts.needsReauth += Number(needsReauth);
    counts.onHold += Number(onHold);
    counts.limited += Number(limited);
    counts.healthy += Number(
      account.enabled && !needsReauth && !onHold && !limited
    );
  }
  return summary;
};
