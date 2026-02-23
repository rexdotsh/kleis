import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { dbFromContext } from "../../db/client";
import {
  completeProviderOAuth,
  importProviderAccount,
  refreshProviderAccount,
  startProviderOAuth,
} from "../../domain/providers/provider-service";
import {
  listProviderAccounts,
  setPrimaryProviderAccount,
} from "../../db/repositories/provider-accounts";
import { providers } from "../../db/schema";
import {
  providerAccountMetadataSchema,
  type ProviderAccountMetadata,
} from "../../providers/metadata";
import {
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_REQUIRED_BETA_HEADERS,
  CLAUDE_SYSTEM_IDENTITY,
  CLAUDE_TOOL_PREFIX,
  CODEX_REQUEST_PROFILE,
  COPILOT_REQUEST_PROFILE,
} from "../../providers/constants";
import { isObjectRecord } from "../../utils/object";
import type { AppEnv } from "../app-env";

const accountIdParamsSchema = z.strictObject({
  id: z.string().trim().min(1).max(120),
});

const oauthProviderParamsSchema = z.strictObject({
  provider: z.enum(providers),
});

const oauthStartBodySchema = z.strictObject({
  redirectUri: z.url(),
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

const toMillisecondsTimestamp = (value: number): number =>
  value < 10_000_000_000 ? value * 1000 : value;

const buildDefaultImportedMetadata = (
  provider: (typeof providers)[number],
  accountId: string | null
): ProviderAccountMetadata => {
  if (provider === "codex") {
    return {
      provider,
      tokenType: null,
      scope: null,
      idToken: null,
      chatgptAccountId: accountId,
      organizationIds: [],
      email: null,
      requestProfile: CODEX_REQUEST_PROFILE,
    };
  }

  if (provider === "copilot") {
    return {
      provider,
      tokenType: null,
      scope: null,
      enterpriseDomain: null,
      copilotApiBaseUrl: null,
      githubUserId: accountId,
      githubLogin: null,
      githubEmail: null,
      requestProfile: COPILOT_REQUEST_PROFILE,
    };
  }

  return {
    provider,
    tokenType: null,
    scope: null,
    oauthMode: "max",
    oauthHost: "claude.ai",
    betaHeaders: [...CLAUDE_REQUIRED_BETA_HEADERS],
    userAgent: CLAUDE_CLI_USER_AGENT,
    systemIdentity: CLAUDE_SYSTEM_IDENTITY,
    toolPrefix: CLAUDE_TOOL_PREFIX,
  };
};

const parseImportedMetadata = (
  provider: (typeof providers)[number],
  rawMetadata: Record<string, unknown> | null | undefined,
  accountId: string | null
): ProviderAccountMetadata => {
  const defaults = buildDefaultImportedMetadata(provider, accountId);
  if (!rawMetadata) {
    return defaults;
  }

  const mergedMetadata: Record<string, unknown> = {
    ...defaults,
    ...rawMetadata,
    provider,
  };
  const defaultRequestProfile = isObjectRecord(
    (defaults as Record<string, unknown>).requestProfile
  )
    ? (defaults as Record<string, unknown>).requestProfile
    : null;
  if (defaultRequestProfile && isObjectRecord(rawMetadata.requestProfile)) {
    mergedMetadata.requestProfile = {
      ...defaultRequestProfile,
      ...rawMetadata.requestProfile,
    };
  }

  const parsed = providerAccountMetadataSchema.safeParse(mergedMetadata);
  if (!parsed.success) {
    throw new Error("Invalid provider metadata payload");
  }

  return parsed.data;
};

const resolveImportedAccountId = (
  explicitAccountId: string | null,
  metadata: ProviderAccountMetadata
): string | null => {
  if (explicitAccountId) {
    return explicitAccountId;
  }

  if (metadata.provider === "codex") {
    return metadata.chatgptAccountId;
  }

  if (metadata.provider === "copilot") {
    return metadata.githubUserId;
  }

  return null;
};

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
        metadata = parseImportedMetadata(
          provider,
          body.metadata,
          explicitAccountId
        );
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

      const accountId = resolveImportedAccountId(explicitAccountId, metadata);
      const database = dbFromContext(context);
      const account = await importProviderAccount(
        database,
        provider,
        {
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
          expiresAt: toMillisecondsTimestamp(body.expiresAt),
          accountId,
          label: body.label ?? null,
          metadata,
        },
        Date.now()
      );

      return context.json({
        account: toAdminAccountView(account),
        imported: true,
      });
    }
  );
