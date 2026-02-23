export type AppContextVariables = Record<string, never>;

export type AppBindings = CloudflareBindings & {
  ADMIN_TOKEN?: string;
  MODELS_DEV_URL?: string;
  MODELS_DEV_CACHE_TTL_SECONDS?: string;
};

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppContextVariables;
};
