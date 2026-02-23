import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { dbFromContext } from "../../db/client";
import {
  completeProviderOAuth,
  refreshProviderAccount,
  startProviderOAuth,
} from "../../domain/providers/provider-service";
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

const oauthStartBodySchema = z
  .object({
    redirectUri: z.string().url(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const oauthCompleteBodySchema = z
  .object({
    state: z.string().trim().min(1),
    code: z.string().trim().min(1).optional(),
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
  metadata: account.metadata,
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
    async (context) => {
      const { id } = context.req.valid("param");
      const database = dbFromContext(context);

      const account = await refreshProviderAccount(database, id, Date.now());
      if (!account) {
        return context.json(
          {
            error: "not_found",
            message: "Account not found",
          },
          404
        );
      }

      return context.json({
        account: toAdminAccountView(account),
        refreshed: true,
      });
    }
  )
  .post(
    "/:provider/oauth/start",
    zValidator("param", oauthProviderParamsSchema),
    zValidator("json", oauthStartBodySchema),
    async (context) => {
      const { provider } = context.req.valid("param");
      const body = context.req.valid("json");
      const database = dbFromContext(context);

      const result = await startProviderOAuth(
        database,
        provider,
        {
          redirectUri: body.redirectUri,
          ...(body.options ? { options: body.options } : {}),
        },
        Date.now()
      );
      return context.json(result);
    }
  )
  .post(
    "/:provider/oauth/complete",
    zValidator("param", oauthProviderParamsSchema),
    zValidator("json", oauthCompleteBodySchema),
    async (context) => {
      const { provider } = context.req.valid("param");
      const body = context.req.valid("json");
      if ((provider === "codex" || provider === "claude") && !body.code) {
        return context.json(
          {
            error: "bad_request",
            message: `${provider} OAuth completion requires a code`,
          },
          400
        );
      }

      const database = dbFromContext(context);

      const account = await completeProviderOAuth(
        database,
        provider,
        {
          state: body.state,
          ...(body.code ? { code: body.code } : {}),
        },
        Date.now()
      );
      return context.json({ account: toAdminAccountView(account) });
    }
  );
