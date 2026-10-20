import { Hono } from "hono";
import { installErrorHandler } from "./http/error-handler";

import { requireAdminAuth } from "./http/middleware/bearer-env-auth";
import {
  requireApiKey,
  requireProxyApiKey,
} from "./http/middleware/api-key-auth";
import { adminAccountsRoutes } from "./http/routes/admin-accounts";
import { adminKeysRoutes } from "./http/routes/admin-keys";
import { adminUiRoutes } from "./http/routes/admin-ui";
import { adminUsageRoutes } from "./http/routes/admin-usage";
import { cronRoutes } from "./http/routes/cron";
import { healthRoutes } from "./http/routes/health";
import { createLimitsRoutes } from "./http/routes/limits";
import { modelsRoutes } from "./http/routes/models";
import {
  flushProxyFailureLogs,
  flushProxyUsage,
  proxyRoutes,
} from "./http/routes/proxy";
import { db } from "./db";
import { createAccountSnapshotStore } from "./domain/providers/account-snapshot-store";
import {
  restoreProviderAccountSnapshots,
  warmProviderAccountQuotas,
} from "./domain/providers/provider-account-tracking";
import { gracefulShutdown } from "./http/graceful-shutdown";
import { resolveRequestIdleTimeout } from "./http/utils/request-timeout";
import { errorLogFields, logWarn } from "./utils/log";

const QUOTA_WARMUP_DELAY_MS = 3000;

const app = new Hono();

installErrorHandler(app);

app.get("/", (context) => context.redirect("/admin"));

app.route("/", healthRoutes);
app.route("/", modelsRoutes);
app.route("/", cronRoutes);
app.route("/", adminUiRoutes);

const adminApi = new Hono();
adminApi.use("/*", requireAdminAuth);
adminApi.get("/session", (context) => context.body(null, 204));
adminApi.route("/accounts", adminAccountsRoutes);
adminApi.route("/keys", adminKeysRoutes);
adminApi.route("/usage", adminUsageRoutes);
app.route("/admin", adminApi);

app.use("/api/limits", requireApiKey);
app.route("/api/limits", createLimitsRoutes(db));

app.use("/openai/v1/*", requireProxyApiKey);
app.use("/anthropic/v1/*", requireProxyApiKey);
app.route("/", proxyRoutes);

const accountSnapshots = createAccountSnapshotStore(db);
const restoredAccounts = restoreProviderAccountSnapshots(db, accountSnapshots);

gracefulShutdown.beforeExit(flushProxyUsage);
gracefulShutdown.beforeExit(accountSnapshots.flush);
gracefulShutdown.beforeExit(flushProxyFailureLogs);
gracefulShutdown.install();

setTimeout(() => {
  restoredAccounts
    .then((accounts) => warmProviderAccountQuotas(db, accounts))
    .catch((error: unknown) => {
      logWarn("quota_warmup_failed", errorLogFields(error));
    });
}, QUOTA_WARMUP_DELAY_MS).unref();

export default {
  idleTimeout: 255,
  port: Number(process.env.PORT ?? 3003),
  fetch(request: Request, server: Bun.Server<unknown>) {
    gracefulShutdown.trackServer(server);
    const requestIdleTimeout = resolveRequestIdleTimeout(
      new URL(request.url).pathname
    );
    if (requestIdleTimeout !== null) {
      server.timeout(request, requestIdleTimeout);
    }

    return app.fetch(request);
  },
};
