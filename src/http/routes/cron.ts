import { Hono } from "hono";

import { db } from "../../db";
import { listProviderAccounts } from "../../db/repositories/provider-accounts";
import { refreshProviderAccount } from "../../domain/providers/provider-service";
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
        ...(failed.length > 0 ? { failures: failed } : {}),
      },
      status
    );
  }
);
