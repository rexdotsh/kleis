import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../../db";
import {
  completeProviderOAuth,
  importProviderAccount,
  ProviderReauthorizationTargetError,
  refreshProviderAccount,
  startProviderOAuth,
} from "../../domain/providers/provider-service";
import {
  expireProviderAccountTracking,
  listProviderAccountQuotas,
  peekProviderAccountProfiles,
  peekProviderAccountQuotas,
  providerAccountSnapshotsRestored,
  queryCodexThreadUsage,
} from "../../domain/providers/provider-account-tracking";
import {
  claimClaudeReset,
  describeClaudeResets,
  redeemCodexResetCredit,
  ResetSpendConflict,
  ResetSpendError,
} from "../../domain/providers/reset-spends";
import { listProviderAccountDailyTokens } from "../../db/repositories/account-daily-tokens";
import {
  getProviderAccountUsageDetail,
  listProviderAccountUsageSummaries,
} from "../../db/repositories/account-usage";
import {
  deleteProviderAccount,
  findProviderAccountById,
  listProviderAccounts,
  listProviderStatuses,
  summarizeProviderStatuses,
  setProviderAccountsEnabled,
  setPrimaryProviderAccount,
  type ProviderAccountRecord,
  updateProviderAccountProfile,
  ProviderAccountReauthorizationConflict,
} from "../../db/repositories/provider-accounts";
import { providers } from "../../db/schema";
import {
  parseImportedProviderAccountMetadata,
  providerAccountMetadataSchema,
  resolveImportedProviderAccountId,
  type ProviderAccountMetadata,
} from "../../providers/metadata";
import { normalizeEditableText, resolvePatchedValue } from "../../utils/patch";
import { resolveUsageWindow, usageWindowQuerySchema } from "./usage-window";
import { toMillisecondsTimestamp } from "../../utils/timestamp";

const accountIdParamsSchema = z.strictObject({
  id: z.string().trim().min(1).max(120),
});

const oauthProviderParamsSchema = z.strictObject({
  provider: z.enum(providers),
});

const updateProviderStatusBodySchema = z.strictObject({
  enabled: z.boolean(),
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

const updateAccountBodySchema = z.strictObject({
  accountId: z.string().trim().max(200).nullable().optional(),
  label: z.string().trim().max(160).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const codexThreadUsageBodySchema = z.strictObject({
  threadIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
});

const resetSpendParamsSchema = accountIdParamsSchema.extend({
  provider: z.enum(["codex", "claude"]),
});

const resetSpendBodySchema = z.strictObject({
  resetId: z.string().trim().min(1).max(300),
});

const DAILY_TOKENS_DEFAULT_DAYS = 30;
const DAILY_TOKENS_MAX_DAYS = 90;

const dailyTokensDaysSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(DAILY_TOKENS_MAX_DAYS)
  .default(DAILY_TOKENS_DEFAULT_DAYS);

const dailyTokensQuerySchema = z.strictObject({
  days: dailyTokensDaysSchema,
});

const dailyTokensBatchQuerySchema = z.strictObject({
  days: dailyTokensDaysSchema,
  ids: z
    .string()
    .transform((value) =>
      Array.from(
        new Set(
          value
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean)
        )
      )
    )
    .pipe(z.array(z.string().max(120)).min(1).max(50))
    .optional(),
  provider: z.enum(providers).optional(),
});

const accountNotFoundBody = {
  error: "not_found",
  message: "Account not found",
} as const;

const invalidMetadataBody = {
  error: "bad_request",
  message: "Invalid provider metadata payload",
} as const;

const resolveUpdatedAccountMetadata = (input: {
  account: ProviderAccountRecord;
  accountId: string | null;
  patch: Record<string, unknown> | null | undefined;
}): ProviderAccountMetadata | null | "invalid" => {
  if (input.patch === undefined) {
    return input.account.metadata;
  }

  if (input.patch === null) {
    return null;
  }

  const baseMetadata =
    input.account.metadata ??
    parseImportedProviderAccountMetadata({
      provider: input.account.provider,
      accountId: input.accountId,
      metadata: null,
    });

  const parsedMetadata = providerAccountMetadataSchema.safeParse({
    ...baseMetadata,
    ...input.patch,
    provider: input.account.provider,
  });

  if (!parsedMetadata.success) {
    return "invalid";
  }

  return parsedMetadata.data;
};

const toAdminAccountView = (account: ProviderAccountRecord) => ({
  id: account.id,
  provider: account.provider,
  label: account.label,
  accountId: account.accountId,
  isPrimary: account.isPrimary,
  enabled: account.enabled,
  metadata: account.metadata,
  expiresAt: account.expiresAt,
  lastRefreshAt: account.lastRefreshAt,
  lastRefreshStatus: account.lastRefreshStatus,
  ownerId: account.ownerId,
  ownerLabel: account.ownerLabel,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
});

export const adminAccountsRoutes = new Hono()
  .get("/", async (context) => {
    const [accounts] = await Promise.all([
      listProviderAccounts(db),
      providerAccountSnapshotsRestored(),
    ]);
    const quotas = peekProviderAccountQuotas(db, accounts);
    const profiles = peekProviderAccountProfiles(accounts);
    return context.json({
      accounts: accounts.map((account) => ({
        ...toAdminAccountView(account),
        quota: quotas.get(account.id) ?? null,
        profile: profiles.get(account.id) ?? null,
        claudeResets: describeClaudeResets(account),
      })),
      providers: summarizeProviderStatuses(accounts),
    });
  })
  .get("/quotas", async (context) => {
    const [accounts] = await Promise.all([
      listProviderAccounts(db),
      providerAccountSnapshotsRestored(),
    ]);
    const quotas = await listProviderAccountQuotas(db, accounts);
    return context.json({
      quotas: Object.fromEntries(quotas),
      profiles: Object.fromEntries(peekProviderAccountProfiles(accounts)),
      claudeResets: Object.fromEntries(
        accounts.map((account) => [account.id, describeClaudeResets(account)])
      ),
    });
  })
  .get("/providers", async (context) => {
    const providerStatuses = await listProviderStatuses(db);
    return context.json({ providers: providerStatuses });
  })
  .patch(
    "/providers/:provider",
    zValidator("param", oauthProviderParamsSchema),
    zValidator("json", updateProviderStatusBodySchema),
    async (context) => {
      const { provider } = context.req.valid("param");
      const { enabled } = context.req.valid("json");
      const status = await setProviderAccountsEnabled(
        db,
        provider,
        enabled,
        Date.now()
      );
      return context.json({ provider: status, updated: true });
    }
  )
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
    "/daily-tokens",
    zValidator("query", dailyTokensBatchQuerySchema),
    async (context) => {
      const { days, ids, provider } = context.req.valid("query");
      const now = Date.now();
      const accounts = await listProviderAccountDailyTokens(db, {
        days,
        now,
        ...(ids ? { accountIds: ids } : {}),
        ...(provider ? { provider } : {}),
      });
      return context.json({ days, now, accounts });
    }
  )
  .get(
    "/:id/daily-tokens",
    zValidator("param", accountIdParamsSchema),
    zValidator("query", dailyTokensQuerySchema),
    async (context) => {
      const { id } = context.req.valid("param");
      const { days } = context.req.valid("query");
      const now = Date.now();
      const [account] = await listProviderAccountDailyTokens(db, {
        days,
        now,
        accountIds: [id],
      });
      if (!account) {
        return context.json(accountNotFoundBody, 404);
      }
      return context.json({ days, now, ...account });
    }
  )
  .post(
    "/:id/tracking/codex/threads",
    zValidator("param", accountIdParamsSchema),
    zValidator("json", codexThreadUsageBodySchema),
    async (context) => {
      const { id } = context.req.valid("param");
      const { threadIds } = context.req.valid("json");
      const account = await findProviderAccountById(db, id);
      if (!account) {
        return context.json(accountNotFoundBody, 404);
      }
      if (account.provider !== "codex") {
        return context.json(
          { error: "bad_request", message: "Account is not a Codex account" },
          400
        );
      }
      const threads = await queryCodexThreadUsage(
        db,
        id,
        Array.from(new Set(threadIds))
      );
      return context.json({ threads: threads ?? [] });
    }
  )
  .post(
    "/:id/tracking/:provider/reset-credits/consume",
    zValidator("param", resetSpendParamsSchema),
    zValidator("json", resetSpendBodySchema),
    async (context) => {
      const { id, provider } = context.req.valid("param");
      const { resetId } = context.req.valid("json");
      const account = await findProviderAccountById(db, id);
      if (!account) {
        return context.json(accountNotFoundBody, 404);
      }
      if (account.provider !== provider) {
        return context.json(
          {
            error: "bad_request",
            message: `Account is not a ${provider} account`,
          },
          400
        );
      }
      try {
        const result =
          provider === "codex"
            ? await redeemCodexResetCredit(db, id, resetId)
            : await claimClaudeReset(db, id, resetId);
        return result
          ? context.json({ result })
          : context.json(accountNotFoundBody, 404);
      } catch (error) {
        if (error instanceof ResetSpendConflict) {
          return context.json(
            { error: "conflict", message: error.message },
            409
          );
        }
        if (error instanceof ResetSpendError) {
          return context.json(
            { error: "upstream_error", message: error.message },
            502
          );
        }
        throw error;
      }
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

      const detail = await getProviderAccountUsageDetail(db, id, since);
      if (!detail) {
        return context.json(accountNotFoundBody, 404);
      }

      return context.json({
        windowMs,
        since,
        now,
        ...detail,
      });
    }
  )
  .patch(
    "/:id",
    zValidator("param", accountIdParamsSchema),
    zValidator("json", updateAccountBodySchema),
    async (context) => {
      const { id } = context.req.valid("param");
      const body = context.req.valid("json");

      const existing = await findProviderAccountById(db, id);
      if (!existing) {
        return context.json(accountNotFoundBody, 404);
      }

      const label = resolvePatchedValue(
        existing.label,
        normalizeEditableText(body.label)
      );
      const accountId = resolvePatchedValue(
        existing.accountId,
        normalizeEditableText(body.accountId)
      );

      const metadata = resolveUpdatedAccountMetadata({
        account: existing,
        accountId,
        patch: body.metadata,
      });

      if (metadata === "invalid") {
        return context.json(invalidMetadataBody, 400);
      }

      const updated = await updateProviderAccountProfile(db, id, {
        label,
        accountId,
        metadata,
        now: Date.now(),
      });

      if (updated === "account_id_conflict") {
        return context.json(
          {
            error: "conflict",
            message:
              "Another account for this provider already uses that account ID",
          },
          409
        );
      }

      if (!updated) {
        return context.json(accountNotFoundBody, 404);
      }

      return context.json({
        account: toAdminAccountView(updated),
        updated: true,
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
        return context.json(accountNotFoundBody, 404);
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
        return context.json(accountNotFoundBody, 404);
      }
      if (updated === "owned") {
        return context.json(
          {
            error: "conflict",
            message: "An account linked by its owner can't be primary",
          },
          409
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
        return context.json(accountNotFoundBody, 404);
      }
      expireProviderAccountTracking(account.id);

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
      try {
        const result = await startProviderOAuth(
          db,
          provider,
          body.options ? { options: body.options } : {},
          Date.now()
        );
        return context.json(result);
      } catch (error) {
        if (error instanceof ProviderReauthorizationTargetError) {
          return context.json(
            { error: "bad_request", message: error.message },
            400
          );
        }
        throw error;
      }
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

      try {
        const account = await completeProviderOAuth(
          db,
          provider,
          {
            state: body.state,
            ...(body.code ? { code: body.code } : {}),
          },
          Date.now()
        );
        expireProviderAccountTracking(account.id);

        return context.json({ account: toAdminAccountView(account) });
      } catch (error) {
        if (error instanceof ProviderAccountReauthorizationConflict) {
          return context.json(
            { error: "conflict", message: error.message },
            409
          );
        }
        throw error;
      }
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
