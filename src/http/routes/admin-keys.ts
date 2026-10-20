import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../../db";
import {
  getApiKeyUsageDetail,
  listApiKeyUsageSummaries,
} from "../../db/repositories/request-usage";
import {
  createApiKey,
  deleteRevokedApiKey,
  findApiKeyById,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  updateApiKey,
} from "../../db/repositories/api-keys";
import { findProviderAccountsByIds } from "../../db/repositories/provider-accounts";
import { providers, type Provider } from "../../db/schema";
import { normalizeEditableText, resolvePatchedValue } from "../../utils/patch";
import { toMillisecondsTimestamp } from "../../utils/timestamp";
import { normalizeStringList } from "../../utils/string-list";
import { resolveExternalRequestUrl } from "../utils/request-origin";
import { resolveUsageWindow, usageWindowQuerySchema } from "./usage-window";

const providerScopeListSchema = z
  .array(z.enum(providers))
  .max(providers.length);
const modelScopeListSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(200);
const accountScopeListSchema = z.array(z.uuid()).max(200);

const createApiKeyBodySchema = z.strictObject({
  label: z.string().trim().min(1).max(120).optional(),
  providerScopes: providerScopeListSchema.min(1).optional(),
  modelScopes: modelScopeListSchema.min(1).optional(),
  accountScopes: accountScopeListSchema.min(1).optional(),
  delegate: z.boolean().optional(),
  expiresAt: z.int().positive().nullable().optional(),
});

const updateApiKeyBodySchema = z.strictObject({
  label: z.string().trim().max(120).nullable().optional(),
  providerScopes: providerScopeListSchema.nullable().optional(),
  modelScopes: modelScopeListSchema.nullable().optional(),
  accountScopes: accountScopeListSchema.nullable().optional(),
  delegate: z.boolean().optional(),
  expiresAt: z.int().positive().nullable().optional(),
});

const keyIdParamsSchema = z.strictObject({
  id: z.uuid(),
});

const rotateApiKeyBodySchema = z.strictObject({
  revokeOld: z.boolean(),
});

const apiKeyNotFoundBody = {
  error: "not_found",
  message: "API key was not found",
} as const;

const expiresAtInvalidBody = {
  error: "bad_request",
  message: "expiresAt must be in the future",
} as const;

const invalidAccountScopesBody = {
  error: "bad_request",
  message: "accountScopes must reference existing provider accounts",
} as const;

const invalidScopedAccountProvidersBody = {
  error: "bad_request",
  message: "accountScopes must belong to providers allowed by providerScopes",
} as const;

const ownedScopedAccountBody = {
  error: "bad_request",
  message: "accountScopes can't include accounts linked by an owner",
} as const;

const duplicateScopedAccountProvidersBody = {
  error: "bad_request",
  message: "accountScopes can include at most one account per provider",
} as const;

const normalizeProviderScopeList = (
  scopes: readonly Provider[] | null | undefined
): Provider[] | null => (scopes?.length ? Array.from(new Set(scopes)) : null);

const validateAccountScopes = async (input: {
  providerScopes: readonly Provider[] | null;
  accountScopes: readonly string[] | null;
}) => {
  if (!input.accountScopes) {
    return null;
  }

  const accounts = await findProviderAccountsByIds(db, input.accountScopes);
  if (accounts.length !== input.accountScopes.length) {
    return invalidAccountScopesBody;
  }
  if (accounts.some((account) => account.ownerId !== null)) {
    return ownedScopedAccountBody;
  }

  const seenProviders = new Set<Provider>();
  for (const account of accounts) {
    if (seenProviders.has(account.provider)) {
      return duplicateScopedAccountProvidersBody;
    }
    seenProviders.add(account.provider);
  }

  if (
    input.providerScopes?.length &&
    accounts.some(
      (account) => !input.providerScopes?.includes(account.provider)
    )
  ) {
    return invalidScopedAccountProvidersBody;
  }

  return null;
};

type ApiKeyRecord = Awaited<ReturnType<typeof listApiKeys>>[number];

const toApiKeyView = (requestUrl: URL, key: ApiKeyRecord) => ({
  ...key,
  scopedModelsUrl: key.modelsDiscoveryToken
    ? `${requestUrl.origin}/api/${key.modelsDiscoveryToken}`
    : null,
});

export const adminKeysRoutes = new Hono()
  .get("/", async (context) => {
    const requestUrl = resolveExternalRequestUrl(context.req.raw);
    const keys = await listApiKeys(db);
    return context.json({
      keys: keys.map((key) => toApiKeyView(requestUrl, key)),
    });
  })
  .get(
    "/usage",
    zValidator("query", usageWindowQuerySchema),
    async (context) => {
      const query = context.req.valid("query");
      const { windowMs, now, since } = resolveUsageWindow(query.windowMs);

      const usage = await listApiKeyUsageSummaries(db, since);

      return context.json({
        windowMs,
        since,
        now,
        usage,
      });
    }
  )
  .post("/", zValidator("json", createApiKeyBodySchema), async (context) => {
    const input = context.req.valid("json");
    const now = Date.now();
    const expiresAt =
      input.expiresAt != null ? toMillisecondsTimestamp(input.expiresAt) : null;
    const providerScopes = normalizeProviderScopeList(input.providerScopes);
    const modelScopes = normalizeStringList(input.modelScopes);
    const accountScopes = normalizeStringList(input.accountScopes);

    if (expiresAt !== null && expiresAt <= now) {
      return context.json(expiresAtInvalidBody, 400);
    }

    const accountScopeError = await validateAccountScopes({
      providerScopes,
      accountScopes,
    });
    if (accountScopeError) {
      return context.json(accountScopeError, 400);
    }

    const key = await createApiKey(
      db,
      {
        label: input.label ?? null,
        delegate: input.delegate ?? false,
        expiresAt,
        ...(providerScopes ? { providerScopes } : {}),
        ...(modelScopes ? { modelScopes } : {}),
        ...(accountScopes ? { accountScopes } : {}),
      },
      now
    );
    return context.json(
      {
        key: toApiKeyView(resolveExternalRequestUrl(context.req.raw), key),
      },
      201
    );
  })
  .patch(
    "/:id",
    zValidator("param", keyIdParamsSchema),
    zValidator("json", updateApiKeyBodySchema),
    async (context) => {
      const { id } = context.req.valid("param");
      const body = context.req.valid("json");

      const existing = await findApiKeyById(db, id);
      if (!existing) {
        return context.json(apiKeyNotFoundBody, 404);
      }

      const now = Date.now();
      const providerScopes = normalizeProviderScopeList(
        resolvePatchedValue(existing.providerScopes, body.providerScopes)
      );
      const modelScopes = normalizeStringList(
        resolvePatchedValue(existing.modelScopes, body.modelScopes)
      );
      const accountScopes = normalizeStringList(
        resolvePatchedValue(existing.accountScopes, body.accountScopes)
      );
      const expiresAt = resolvePatchedValue(
        existing.expiresAt,
        body.expiresAt == null
          ? body.expiresAt
          : toMillisecondsTimestamp(body.expiresAt)
      );

      if (
        body.expiresAt !== undefined &&
        expiresAt !== null &&
        expiresAt <= now
      ) {
        return context.json(expiresAtInvalidBody, 400);
      }

      const accountScopeError = await validateAccountScopes({
        providerScopes,
        accountScopes,
      });
      if (accountScopeError) {
        return context.json(accountScopeError, 400);
      }

      const updated = await updateApiKey(db, id, {
        label: resolvePatchedValue(
          existing.label,
          normalizeEditableText(body.label)
        ),
        providerScopes,
        modelScopes,
        accountScopes,
        delegate: body.delegate ?? existing.delegate,
        expiresAt,
      });
      if (!updated) {
        return context.json(apiKeyNotFoundBody, 404);
      }

      return context.json({
        key: toApiKeyView(resolveExternalRequestUrl(context.req.raw), updated),
        updated: true,
      });
    }
  )
  .post(
    "/:id/rotate",
    zValidator("param", keyIdParamsSchema),
    zValidator("json", rotateApiKeyBodySchema),
    async (context) => {
      const { id } = context.req.valid("param");
      const { revokeOld } = context.req.valid("json");
      const existing = await findApiKeyById(db, id);
      if (!existing) {
        return context.json(apiKeyNotFoundBody, 404);
      }
      const key = await rotateApiKey(db, existing, revokeOld, Date.now());
      return context.json(
        { key: toApiKeyView(resolveExternalRequestUrl(context.req.raw), key) },
        201
      );
    }
  )
  .post(
    "/:id/revoke",
    zValidator("param", keyIdParamsSchema),
    async (context) => {
      const { id } = context.req.valid("param");
      const revoked = await revokeApiKey(db, id, Date.now());
      if (!revoked) {
        return context.json(
          {
            error: "not_found",
            message: "API key was not found or already revoked",
          },
          404
        );
      }

      return context.json({ revoked: true });
    }
  )
  .delete("/:id", zValidator("param", keyIdParamsSchema), async (context) => {
    const { id } = context.req.valid("param");
    const result = await deleteRevokedApiKey(db, id);

    if (result === "not_found") {
      return context.json(apiKeyNotFoundBody, 404);
    }

    if (result === "not_revoked") {
      return context.json(
        {
          error: "bad_request",
          message: "Only revoked API keys can be deleted",
        },
        400
      );
    }

    return context.json({ deleted: true });
  })
  .get(
    "/:id/usage",
    zValidator("param", keyIdParamsSchema),
    zValidator("query", usageWindowQuerySchema),
    async (context) => {
      const { id } = context.req.valid("param");
      const query = context.req.valid("query");
      const { windowMs, now, since } = resolveUsageWindow(query.windowMs);

      const detail = await getApiKeyUsageDetail(db, id, since);
      if (!detail) {
        return context.json(apiKeyNotFoundBody, 404);
      }

      return context.json({
        windowMs,
        since,
        now,
        ...detail,
      });
    }
  );
