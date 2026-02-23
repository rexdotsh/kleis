import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { dbFromContext } from "../../db/client";
import {
  listProviderAccounts,
  setPrimaryProviderAccount,
} from "../../db/repositories/provider-accounts";
import { providers } from "../../db/schema";
import type { AppEnv } from "../app-env";

const accountIdParamsSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
  })
  .strict();

const oauthProviderParamsSchema = z
  .object({
    provider: z.enum(providers),
  })
  .strict();

const toAdminAccountView = (
  account: Awaited<ReturnType<typeof listProviderAccounts>>[number]
) => ({
  id: account.id,
  provider: account.provider,
  label: account.label,
  accountId: account.accountId,
  isPrimary: account.isPrimary,
  expiresAt: account.expiresAt,
  lastRefreshAt: account.lastRefreshAt,
  lastRefreshStatus: account.lastRefreshStatus,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
});

export const adminAccountsRoutes = new Hono<AppEnv>()
  .get("/", async (context) => {
    const database = dbFromContext(context);
    const accounts = await listProviderAccounts(database);
    return context.json({ accounts: accounts.map(toAdminAccountView) });
  })
  .post(
    "/:id/primary",
    zValidator("param", accountIdParamsSchema),
    async (context) => {
      const { id } = context.req.valid("param");
      const database = dbFromContext(context);
      const updated = await setPrimaryProviderAccount(database, id, Date.now());

      if (!updated) {
        return context.json(
          {
            error: "not_found",
            message: "Account not found",
          },
          404
        );
      }

      return context.json({ account: toAdminAccountView(updated) });
    }
  )
  .post(
    "/:id/refresh",
    zValidator("param", accountIdParamsSchema),
    (context) => {
      const { id } = context.req.valid("param");
      return context.json(
        {
          error: "not_implemented",
          message: `Manual refresh for account ${id} will be implemented in provider phase`,
        },
        501
      );
    }
  )
  .post(
    "/:provider/oauth/start",
    zValidator("param", oauthProviderParamsSchema),
    (context) => {
      const { provider } = context.req.valid("param");
      return context.json(
        {
          error: "not_implemented",
          message: `OAuth start for ${provider} will be implemented in provider phase`,
        },
        501
      );
    }
  )
  .post(
    "/:provider/oauth/complete",
    zValidator("param", oauthProviderParamsSchema),
    (context) => {
      const { provider } = context.req.valid("param");
      return context.json(
        {
          error: "not_implemented",
          message: `OAuth completion for ${provider} will be implemented in provider phase`,
        },
        501
      );
    }
  );
