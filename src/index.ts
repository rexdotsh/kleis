import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { requireAdminAuth } from "./http/middleware/admin-auth";
import { requireProxyApiKey } from "./http/middleware/api-key-auth";
import { adminAccountsRoutes } from "./http/routes/admin-accounts";
import { adminKeysRoutes } from "./http/routes/admin-keys";
import { adminUsageRoutes } from "./http/routes/admin-usage";
import { healthRoutes } from "./http/routes/health";
import { modelsRoutes } from "./http/routes/models";
import { proxyRoutes } from "./http/routes/proxy";

const app = new Hono();
const isVercel = process.env.VERCEL === "1";

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
  context.redirect("https://github.com/rexdotsh/kleis")
);

app.route("/", healthRoutes);
app.route("/", modelsRoutes);

if (!isVercel) {
  // Vercel serves public/ automatically, manual setup needed for local dev.
  // https://vercel.com/docs/frameworks/backend/hono#serving-static-assets
  const { serveStatic } = await import("hono/bun");
  app.get(
    "/admin",
    serveStatic({
      root: "./public",
      path: "admin/index.html",
    })
  );
  app.get(
    "/admin/",
    serveStatic({
      root: "./public",
      path: "admin/index.html",
    })
  );
  app.use(
    "/admin/*",
    serveStatic({
      root: "./public",
    })
  );
}

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
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
