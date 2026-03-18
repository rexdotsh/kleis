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
  type CreateApiKeyInput,
  type UpdateApiKeyInput,
  updateApiKey,
} from "../../db/repositories/api-keys";
import { findProviderAccountsByIds } from "../../db/repositories/provider-accounts";
import { providers, type Provider } from "../../db/schema";
import { normalizeEditableText, resolvePatchedValue } from "../../utils/patch";
import { toMillisecondsTimestamp } from "../../utils/timestamp";
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
  expiresAt: z.int().positive().nullable().optional(),
});

const updateApiKeyBodySchema = z.strictObject({
  label: z.string().trim().max(120).nullable().optional(),
  providerScopes: providerScopeListSchema.nullable().optional(),
  modelScopes: modelScopeListSchema.nullable().optional(),
  accountScopes: accountScopeListSchema.nullable().optional(),
  expiresAt: z.int().positive().nullable().optional(),
});

const keyIdParamsSchema = z.strictObject({
  id: z.uuid(),
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

const duplicateScopedAccountProvidersBody = {
  error: "bad_request",
  message: "accountScopes can include at most one account per provider",
} as const;

const normalizeScopeList = <T extends string>(
  scopes: readonly T[] | null | undefined
): T[] | null => {
  if (!scopes?.length) {
    return null;
  }

  const normalized = new Set<T>();
  for (const scope of scopes) {
    const value = scope.trim();
    if (value) {
      normalized.add(value as T);
    }
  }

  return normalized.size ? Array.from(normalized) : null;
};

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

const resolvePatchedExpiresAt = (
  current: number | null,
  patched: number | null | undefined
): number | null => {
  if (patched === undefined) {
    return current;
  }

  if (patched === null) {
    return null;
  }

  return toMillisecondsTimestamp(patched);
};

type ApiKeyRecord = Awaited<ReturnType<typeof listApiKeys>>[number];

type ApiKeyView = ApiKeyRecord & {
  scopedModelsUrl: string | null;
};

const scopedModelsUrl = (
  requestUrl: URL,
  modelsDiscoveryToken: string | null
): string | null => {
  if (!modelsDiscoveryToken) {
    return null;
  }

  return `${requestUrl.origin}/api/${modelsDiscoveryToken}`;
};

const toApiKeyView = (requestUrl: URL, key: ApiKeyRecord): ApiKeyView => ({
  ...key,
  scopedModelsUrl: scopedModelsUrl(requestUrl, key.modelsDiscoveryToken),
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
    const providerScopes = normalizeScopeList(input.providerScopes) as
      | Provider[]
      | null;
    const modelScopes = normalizeScopeList(input.modelScopes);
    const accountScopes = normalizeScopeList(input.accountScopes);

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

    const payload: CreateApiKeyInput = {
      label: input.label ?? null,
      expiresAt,
    };
    if (providerScopes) {
      payload.providerScopes = providerScopes;
    }
    if (modelScopes) {
      payload.modelScopes = modelScopes;
    }
    if (accountScopes) {
      payload.accountScopes = accountScopes;
    }

    const key = await createApiKey(db, payload, now);
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
      const label = resolvePatchedValue(
        existing.label,
        normalizeEditableText(body.label)
      );
      const providerScopes = resolvePatchedValue(
        existing.providerScopes,
        body.providerScopes
      ) as Provider[] | null;
      const modelScopes = resolvePatchedValue(
        existing.modelScopes,
        body.modelScopes
      );
      const accountScopes = resolvePatchedValue(
        existing.accountScopes,
        body.accountScopes
      );
      const expiresAt = resolvePatchedExpiresAt(
        existing.expiresAt,
        body.expiresAt
      );

      if (
        body.expiresAt !== undefined &&
        expiresAt !== null &&
        expiresAt <= now
      ) {
        return context.json(expiresAtInvalidBody, 400);
      }

      const normalizedProviderScopes = normalizeScopeList(providerScopes) as
        | Provider[]
        | null;
      const normalizedModelScopes = normalizeScopeList(modelScopes);
      const normalizedAccountScopes = normalizeScopeList(accountScopes);
      const accountScopeError = await validateAccountScopes({
        providerScopes: normalizedProviderScopes,
        accountScopes: normalizedAccountScopes,
      });
      if (accountScopeError) {
        return context.json(accountScopeError, 400);
      }

      const payload: UpdateApiKeyInput = {
        label,
        providerScopes: normalizedProviderScopes,
        modelScopes: normalizedModelScopes,
        accountScopes: normalizedAccountScopes,
        expiresAt,
      };

      const updated = await updateApiKey(db, id, payload);
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
      return context.json(
        {
          error: "not_found",
          message: "API key was not found",
        },
        404
      );
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

      const key = await findApiKeyById(db, id);
      if (!key) {
        return context.json(apiKeyNotFoundBody, 404);
      }

      const detail = await getApiKeyUsageDetail(db, id, since);

      return context.json({
        windowMs,
        since,
        now,
        ...detail,
      });
    }
  );
