import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../../db";
import {
  completeProviderOAuth,
  importProviderAccount,
  refreshProviderAccount,
  startProviderOAuth,
} from "../../domain/providers/provider-service";
import {
  getProviderAccountUsageDetail,
  listProviderAccountUsageSummaries,
} from "../../db/repositories/account-usage";
import {
  deleteProviderAccount,
  findProviderAccountById,
  listProviderAccounts,
  setPrimaryProviderAccount,
} from "../../db/repositories/provider-accounts";
import { providers } from "../../db/schema";
import {
  parseImportedProviderAccountMetadata,
  resolveImportedProviderAccountId,
  type ProviderAccountMetadata,
} from "../../providers/metadata";
import { resolveUsageWindow, usageWindowQuerySchema } from "./usage-window";
import { toMillisecondsTimestamp } from "../../utils/timestamp";

const accountIdParamsSchema = z.strictObject({
  id: z.string().trim().min(1).max(120),
});

const oauthProviderParamsSchema = z.strictObject({
  provider: z.enum(providers),
});

const oauthStartBodySchema = z.strictObject({
  options: z.record(z.string(), z.unknown()).optional(),
});

const oauthCompleteBodySchema = z.strictObject({
  state: z.string().trim().min(1),
  code: z.string().trim().min(1).optional(),
});

const importAccountBodySchema = z.strictObject({
  accessToken: z.string().trim().min(1),
  refreshToken: z.string().trim().min(1),
  expiresAt: z.int().positive(),
  accountId: z.string().trim().min(1).max(200).nullable().optional(),
  label: z.string().trim().min(1).max(160).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

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

export const adminAccountsRoutes = new Hono()
  .get("/", async (context) => {
    const accounts = await listProviderAccounts(db);
    return context.json({ accounts: accounts.map(toAdminAccountView) });
  })
  .get(
    "/usage",
    zValidator("query", usageWindowQuerySchema),
    async (context) => {
      const query = context.req.valid("query");
      const { windowMs, now, since } = resolveUsageWindow(query.windowMs);

      const usage = await listProviderAccountUsageSummaries(db, since);

      return context.json({
        windowMs,
        since,
        now,
        usage,
      });
    }
  )
  .get(
    "/:id/usage",
    zValidator("param", accountIdParamsSchema),
    zValidator("query", usageWindowQuerySchema),
    async (context) => {
      const { id } = context.req.valid("param");
      const query = context.req.valid("query");
      const { windowMs, now, since } = resolveUsageWindow(query.windowMs);

      const account = await findProviderAccountById(db, id);
      if (!account) {
        return context.json(
          {
            error: "not_found",
            message: "Account not found",
          },
          404
        );
      }

      const detail = await getProviderAccountUsageDetail(db, id, since);

      return context.json({
        windowMs,
        since,
        now,
        ...detail,
      });
    }
  )
  .delete(
    "/:id",
    zValidator("param", accountIdParamsSchema),
    async (context) => {
      const { id } = context.req.valid("param");
      const deleted = await deleteProviderAccount(db, id);

      if (!deleted) {
        return context.json(
          {
            error: "not_found",
            message: "Account not found",
          },
          404
        );
      }

      return context.json({ deleted: true });
    }
  )
  .post(
    "/:id/primary",
    zValidator("param", accountIdParamsSchema),
    async (context) => {
      const { id } = context.req.valid("param");
      const updated = await setPrimaryProviderAccount(db, id, Date.now());

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
      let account: Awaited<ReturnType<typeof refreshProviderAccount>>;
      try {
        account = await refreshProviderAccount(db, id, Date.now(), {
          force: true,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("already in progress")
        ) {
          return context.json(
            {
              error: "conflict",
              message: "Provider account refresh is already in progress",
            },
            409
          );
        }

        throw error;
      }

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
      const result = await startProviderOAuth(
        db,
        provider,
        {
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
      if (provider === "claude" && !body.code) {
        return context.json(
          {
            error: "bad_request",
            message: `${provider} OAuth completion requires a code`,
          },
          400
        );
      }

      const account = await completeProviderOAuth(
        db,
        provider,
        {
          state: body.state,
          ...(body.code ? { code: body.code } : {}),
        },
        Date.now()
      );
      return context.json({ account: toAdminAccountView(account) });
    }
  )
  .post(
    "/:provider/import",
    zValidator("param", oauthProviderParamsSchema),
    zValidator("json", importAccountBodySchema),
    async (context) => {
      const { provider } = context.req.valid("param");
      const body = context.req.valid("json");
      const explicitAccountId = body.accountId ?? null;

      let metadata: ProviderAccountMetadata;
      try {
        metadata = parseImportedProviderAccountMetadata({
          provider,
          accountId: explicitAccountId,
          metadata: body.metadata,
        });
      } catch (error) {
        return context.json(
          {
            error: "bad_request",
            message:
              error instanceof Error
                ? error.message
                : "Invalid provider metadata payload",
          },
          400
        );
      }

      const accountId = resolveImportedProviderAccountId(
        explicitAccountId,
        metadata
      );
      const now = Date.now();
      const expiresAt = toMillisecondsTimestamp(body.expiresAt);
      if (expiresAt <= now) {
        return context.json(
          {
            error: "bad_request",
            message: "expiresAt must be in the future",
          },
          400
        );
      }

      const account = await importProviderAccount(
        db,
        provider,
        {
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
          expiresAt,
          accountId,
          label: body.label ?? null,
          metadata,
        },
        now
      );

      return context.json({
        account: toAdminAccountView(account),
        imported: true,
      });
    }
  );
