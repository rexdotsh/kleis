export type AppContextVariables = Record<string, never>;

export type AppBindings = CloudflareBindings & {
  ADMIN_TOKEN?: string;
};

export type AppEnv = {
  Bindings: AppBindings;
  Variables: AppContextVariables;
};
