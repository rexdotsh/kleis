import { Hono } from "hono";

import { db } from "../../db";
import { listProviderAccounts } from "../../db/repositories/provider-accounts";
import { refreshProviderAccount } from "../../domain/providers/provider-service";
import { refreshProviderAccountTracking } from "../../domain/providers/provider-account-tracking";
import { requireCronAuth } from "../middleware/bearer-env-auth";

const isRefreshInProgressError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("already in progress");

const formatErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown refresh error";

export const cronRoutes = new Hono().get(
  "/cron/refresh-provider-accounts",
  requireCronAuth,
  async (context) => {
    const startedAt = Date.now();
    const accounts = await listProviderAccounts(db);
    const failed: Array<{
      id: string;
      provider: string;
      message: string;
    }> = [];
    let refreshedCount = 0;
    let inProgressCount = 0;
    let trackingRefreshedCount = 0;
    let trackingStaleCount = 0;

    for (const account of accounts) {
      try {
        const refreshed = await refreshProviderAccount(
          db,
          account.id,
          Date.now(),
          {
            force: true,
          }
        );

        if (refreshed) {
          refreshedCount += 1;
        }
        if (account.provider === "codex" || account.provider === "claude") {
          const tracking = await refreshProviderAccountTracking(
            db,
            account.id,
            {
              force: true,
            }
          );
          if (tracking?.lastError) {
            trackingStaleCount += 1;
          } else if (tracking) {
            trackingRefreshedCount += 1;
          }
        }
      } catch (error) {
        if (isRefreshInProgressError(error)) {
          inProgressCount += 1;
          continue;
        }

        failed.push({
          id: account.id,
          provider: account.provider,
          message: formatErrorMessage(error),
        });
      }
    }

    const durationMs = Date.now() - startedAt;
    const hasFailures = failed.length > 0;
    const status = hasFailures ? 500 : 200;

    return context.json(
      {
        ok: !hasFailures,
        startedAt,
        finishedAt: Date.now(),
        durationMs,
        accounts: {
          total: accounts.length,
          refreshed: refreshedCount,
          inProgress: inProgressCount,
          failed: failed.length,
        },
        tracking: {
          refreshed: trackingRefreshedCount,
          stale: trackingStaleCount,
        },
        ...(failed.length > 0 ? { failures: failed } : {}),
      },
      status
    );
  }
);
