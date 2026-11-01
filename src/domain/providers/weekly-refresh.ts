import type { Database } from "../../db";
import { listProviderAccounts } from "../../db/repositories/provider-accounts";
import { errorLogFields, logInfo, logWarn } from "../../utils/log";
import { refreshProviderAccount } from "./provider-service";

const REFRESH_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 60_000;

// Requests only refresh the accounts they route to, and a refresh token left
// unused for months can stop working, so every account is refreshed weekly.
export const refreshStaleProviderAccounts = async (
  database: Database,
  now: number
): Promise<{ due: number; refreshed: number; failed: number }> => {
  const accounts = await listProviderAccounts(database);
  const due = accounts.filter(
    (account) =>
      account.lastRefreshStatus !== "reauthorize" &&
      now - (account.lastRefreshAt ?? account.createdAt) >= REFRESH_EVERY_MS
  );
  let refreshed = 0;
  let failed = 0;
  for (const account of due) {
    try {
      const result = await refreshProviderAccount(
        database,
        account.id,
        Date.now(),
        { force: true }
      );
      if (result) {
        refreshed += 1;
      }
    } catch (error) {
      failed += 1;
      logWarn("provider_weekly_refresh_failed", {
        provider: account.provider,
        providerAccountId: account.id,
        ...errorLogFields(error),
      });
    }
  }
  if (due.length > 0) {
    logInfo("provider_weekly_refresh", {
      due: due.length,
      refreshed,
      failed,
    });
  }
  return { due: due.length, refreshed, failed };
};

// Checks hourly so restarts and deploys don't push the weekly refresh back.
export const scheduleWeeklyProviderAccountRefresh = (
  database: Database
): void => {
  let running: Promise<void> | null = null;
  const run = (): void => {
    running ??= refreshStaleProviderAccounts(database, Date.now())
      .then(() => undefined)
      .catch((error: unknown) => {
        logWarn("provider_weekly_refresh_failed", errorLogFields(error));
      })
      .finally(() => {
        running = null;
      });
  };
  setTimeout(run, FIRST_CHECK_DELAY_MS).unref();
  setInterval(run, CHECK_INTERVAL_MS).unref();
};
