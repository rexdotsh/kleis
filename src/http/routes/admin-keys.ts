import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { dbFromContext } from "../../db/client";
import { listApiKeyUsageSummaries } from "../../db/repositories/api-key-usage";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type CreateApiKeyInput,
} from "../../db/repositories/api-keys";
import { providers } from "../../db/schema";
import type { AppEnv } from "../app-env";

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

export const adminKeysRoutes = new Hono<AppEnv>()
  .get("/", async (context) => {
    const database = dbFromContext(context);
    const keys = await listApiKeys(database);
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

      const database = dbFromContext(context);
      const usage = await listApiKeyUsageSummaries(database, since);

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

    const database = dbFromContext(context);
    const key = await createApiKey(database, payload, Date.now());
    return context.json({ key }, 201);
  })
  .post(
    "/:id/revoke",
    zValidator("param", revokeApiKeyParamsSchema),
    async (context) => {
      const { id } = context.req.valid("param");
      const database = dbFromContext(context);
      const revoked = await revokeApiKey(database, id, Date.now());
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
