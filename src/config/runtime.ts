import type { AppBindings } from "../http/app-env";

export type RuntimeConfig = {
  modelsDevUrl: string;
  modelsDevCacheTtlSeconds: number;
};

const DEFAULT_MODELS_DEV_URL = "https://models.dev/api.json";
const DEFAULT_MODELS_DEV_CACHE_TTL_SECONDS = 900;

export const getRuntimeConfig = (_bindings: AppBindings): RuntimeConfig => ({
  modelsDevUrl: DEFAULT_MODELS_DEV_URL,
  modelsDevCacheTtlSeconds: DEFAULT_MODELS_DEV_CACHE_TTL_SECONDS,
});

export const getAdminToken = (bindings: AppBindings): string | null => {
  const token = bindings.ADMIN_TOKEN?.trim();
  if (!token) {
    return null;
  }

  return token;
};
