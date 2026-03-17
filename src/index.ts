import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { requireAdminAuth } from "./http/middleware/bearer-env-auth";
import { requireProxyApiKey } from "./http/middleware/api-key-auth";
import { adminAccountsRoutes } from "./http/routes/admin-accounts";
import { adminKeysRoutes } from "./http/routes/admin-keys";
import { adminUiRoutes } from "./http/routes/admin-ui";
import { adminUsageRoutes } from "./http/routes/admin-usage";
import { cronRoutes } from "./http/routes/cron";
import { healthRoutes } from "./http/routes/health";
import { modelsRoutes } from "./http/routes/models";
import { proxyRoutes } from "./http/routes/proxy";
import { resolveRequestIdleTimeout } from "./http/utils/request-timeout";

const app = new Hono();

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

app.get("/", (context) => context.redirect("/admin"));

app.route("/", healthRoutes);
app.route("/", modelsRoutes);
app.route("/", cronRoutes);
app.route("/", adminUiRoutes);

const adminApi = new Hono();
adminApi.use("/*", requireAdminAuth);
adminApi.route("/accounts", adminAccountsRoutes);
adminApi.route("/keys", adminKeysRoutes);
adminApi.route("/usage", adminUsageRoutes);
app.route("/admin", adminApi);

app.use("/openai/v1/*", requireProxyApiKey);
app.use("/anthropic/v1/*", requireProxyApiKey);
app.use("/copilot/v1/*", requireProxyApiKey);
app.route("/", proxyRoutes);

export default {
  idleTimeout: 255,
  port: Number(process.env.PORT ?? 3003),
  fetch(request: Request, server: Bun.Server<unknown>) {
    const requestIdleTimeout = resolveRequestIdleTimeout(
      new URL(request.url).pathname
    );
    if (requestIdleTimeout !== null) {
      server.timeout(request, requestIdleTimeout);
    }

    return app.fetch(request);
  },
};
