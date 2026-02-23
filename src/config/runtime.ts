import { z } from "zod";

import type { AppBindings } from "../http/app-env";

const runtimeConfigSchema = z.object({
  modelsDevUrl: z.string().url(),
  modelsDevCacheTtlSeconds: z.number().int().positive(),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";
const DEFAULT_MODELS_DEV_CACHE_TTL_SECONDS = 900;

export const getRuntimeConfig = (bindings: AppBindings): RuntimeConfig => {
  const parsed = runtimeConfigSchema.safeParse({
    modelsDevUrl: bindings.MODELS_DEV_URL ?? DEFAULT_MODELS_DEV_URL,
    modelsDevCacheTtlSeconds: Number(
      bindings.MODELS_DEV_CACHE_TTL_SECONDS ??
        DEFAULT_MODELS_DEV_CACHE_TTL_SECONDS
    ),
  });

  if (!parsed.success) {
    throw new Error(`Invalid runtime config: ${parsed.error.message}`);
  }

  return parsed.data;
};

export const getAdminToken = (bindings: AppBindings): string | null => {
  const token = bindings.ADMIN_TOKEN?.trim();
  if (!token) {
    return null;
  }

  return token;
};
