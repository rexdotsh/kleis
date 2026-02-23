import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../../db";
import { listApiKeyUsageSummaries } from "../../db/repositories/api-key-usage";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type CreateApiKeyInput,
} from "../../db/repositories/api-keys";
import { providers } from "../../db/schema";

const createApiKeyBodySchema = z.strictObject({
  label: z.string().trim().min(1).max(120).optional(),
  providerScopes: z.array(z.enum(providers)).max(providers.length).optional(),
  modelScopes: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
  expiresAt: z.int().positive().nullable().optional(),
});

const revokeApiKeyParamsSchema = z.strictObject({
  id: z.uuid(),
});

const listApiKeyUsageQuerySchema = z.strictObject({
  windowMs: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(30 * 24 * 60 * 60 * 1000)
    .optional(),
});

const DEFAULT_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const adminKeysRoutes = new Hono()
  .get("/", async (context) => {
    const keys = await listApiKeys(db);
    return context.json({ keys });
  })
  .get(
    "/usage",
    zValidator("query", listApiKeyUsageQuerySchema),
    async (context) => {
      const query = context.req.valid("query");
      const windowMs = query.windowMs ?? DEFAULT_USAGE_WINDOW_MS;
      const now = Date.now();
      const since = now - windowMs;

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
    const payload: CreateApiKeyInput = {
      label: input.label ?? null,
      expiresAt: input.expiresAt ?? null,
    };
    if (input.providerScopes) {
      payload.providerScopes = input.providerScopes;
    }
    if (input.modelScopes) {
      payload.modelScopes = input.modelScopes;
    }

    const key = await createApiKey(db, payload, Date.now());
    return context.json({ key }, 201);
  })
  .post(
    "/:id/revoke",
    zValidator("param", revokeApiKeyParamsSchema),
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
  );
