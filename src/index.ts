import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import type { AppEnv } from "./http/app-env";
import { requireAdminAuth } from "./http/middleware/admin-auth";
import { requireProxyApiKey } from "./http/middleware/api-key-auth";
import { adminAccountsRoutes } from "./http/routes/admin-accounts";
import { adminKeysRoutes } from "./http/routes/admin-keys";
import { adminUiRoutes } from "./http/routes/admin-ui";
import { healthRoutes } from "./http/routes/health";
import { modelsRoutes } from "./http/routes/models";
import { v1Routes } from "./http/routes/v1";

const app = new Hono<AppEnv>();

app.onError((error, context) => {
  if (error instanceof HTTPException) {
    return context.json(
      {
        error: "request_error",
        message: error.message,
      },
      error.status
    );
  }

  return context.json(
    {
      error: "internal_error",
      message: error.message,
    },
    500
  );
});

app.get("/", (context) =>
  context.json({
    service: "kleis",
    status: "ok",
  })
);

app.route("/", healthRoutes);
app.route("/", modelsRoutes);
app.route("/admin", adminUiRoutes);

const adminApi = new Hono<AppEnv>();
adminApi.use("/*", requireAdminAuth);
adminApi.route("/accounts", adminAccountsRoutes);
adminApi.route("/keys", adminKeysRoutes);
app.route("/admin", adminApi);

const api = new Hono<AppEnv>();
api.use("/*", requireProxyApiKey);
api.route("/", v1Routes);
app.route("/v1", api);

export default app;
