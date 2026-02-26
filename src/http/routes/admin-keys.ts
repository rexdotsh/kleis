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
import { providers } from "../../db/schema";
import { toMillisecondsTimestamp } from "../../utils/timestamp";
import { invalidateModelsRegistryCache } from "../utils/models-cache";
import { resolveUsageWindow, usageWindowQuerySchema } from "./usage-window";

const createApiKeyBodySchema = z.strictObject({
  label: z.string().trim().min(1).max(120).optional(),
  providerScopes: z
    .array(z.enum(providers))
    .min(1)
    .max(providers.length)
    .optional(),
  modelScopes: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(200)
    .optional(),
  expiresAt: z.int().positive().nullable().optional(),
});

const updateApiKeyBodySchema = z.strictObject({
  label: z.string().trim().max(120).nullable().optional(),
  providerScopes: z
    .array(z.enum(providers))
    .max(providers.length)
    .nullable()
    .optional(),
  modelScopes: z
    .array(z.string().trim().min(1).max(200))
    .max(200)
    .nullable()
    .optional(),
  expiresAt: z.int().positive().nullable().optional(),
});

const keyIdParamsSchema = z.strictObject({
  id: z.uuid(),
});

const normalizeEditableText = (
  value: string | null | undefined
): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  return value.length > 0 ? value : null;
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
    const requestUrl = new URL(context.req.url);
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

    if (expiresAt !== null && expiresAt <= now) {
      return context.json(
        {
          error: "bad_request",
          message: "expiresAt must be in the future",
        },
        400
      );
    }

    const payload: CreateApiKeyInput = {
      label: input.label ?? null,
      expiresAt,
    };
    if (input.providerScopes) {
      payload.providerScopes = input.providerScopes;
    }
    if (input.modelScopes) {
      payload.modelScopes = input.modelScopes;
    }

    const key = await createApiKey(db, payload, now);
    invalidateModelsRegistryCache();
    return context.json(
      {
        key: toApiKeyView(new URL(context.req.url), key),
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
        return context.json(
          {
            error: "not_found",
            message: "API key was not found",
          },
          404
        );
      }

      const now = Date.now();
      const nextLabel = normalizeEditableText(body.label);
      const label = nextLabel === undefined ? existing.label : nextLabel;
      const providerScopes =
        body.providerScopes === undefined
          ? existing.providerScopes
          : body.providerScopes;
      const modelScopes =
        body.modelScopes === undefined
          ? existing.modelScopes
          : body.modelScopes;
      const expiresAt =
        body.expiresAt === undefined
          ? existing.expiresAt
          : body.expiresAt === null
            ? null
            : toMillisecondsTimestamp(body.expiresAt);

      if (
        body.expiresAt !== undefined &&
        expiresAt !== null &&
        expiresAt <= now
      ) {
        return context.json(
          {
            error: "bad_request",
            message: "expiresAt must be in the future",
          },
          400
        );
      }

      const payload: UpdateApiKeyInput = {
        label,
        providerScopes: providerScopes?.length ? providerScopes : null,
        modelScopes: modelScopes?.length ? modelScopes : null,
        expiresAt,
      };

      const updated = await updateApiKey(db, id, payload);
      if (!updated) {
        return context.json(
          {
            error: "not_found",
            message: "API key was not found",
          },
          404
        );
      }

      invalidateModelsRegistryCache();
      return context.json({
        key: toApiKeyView(new URL(context.req.url), updated),
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

      invalidateModelsRegistryCache();
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

    invalidateModelsRegistryCache();
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
        return context.json(
          {
            error: "not_found",
            message: "API key was not found",
          },
          404
        );
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
