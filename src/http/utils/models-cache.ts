import { invalidateByTag, waitUntil } from "@vercel/functions";

const MODELS_REGISTRY_CACHE_TAG = "models-registry";
const MODELS_REGISTRY_CACHE_CONTROL =
  "public, s-maxage=3600, stale-while-revalidate=86400";
const isVercelRuntime = process.env.VERCEL === "1";

export const modelsRegistryCacheHeaders = {
  "Cache-Control": MODELS_REGISTRY_CACHE_CONTROL,
  "Vercel-Cache-Tag": MODELS_REGISTRY_CACHE_TAG,
} as const;

export const invalidateModelsRegistryCache = (): void => {
  if (!isVercelRuntime) {
    return;
  }

  waitUntil(invalidateByTag(MODELS_REGISTRY_CACHE_TAG).catch(() => undefined));
};
