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
const isDev = process.env.NODE_ENV !== "production" && !isVercel;

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

// Vercel serves public/ via CDN. Locally, Bun's routes serve admin HTML with HMR.
const adminPage = isDev
  ? (await import("../public/admin/index.html")).default
  : undefined;

export default {
  port: Number(process.env.PORT ?? 3000),
  // Bun's router treats "/admin" and "/admin/" as distinct URLs
  routes: adminPage && { "/admin": adminPage, "/admin/": adminPage },
  development: isDev,
  fetch: app.fetch,
};
