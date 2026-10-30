import { afterAll, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";

const originalDatabaseUrl = process.env.TURSO_CONNECTION_URL;
const originalDatabaseToken = process.env.TURSO_AUTH_TOKEN;
const originalAdminToken = process.env.ADMIN_TOKEN;
const originalFetch = globalThis.fetch;
process.env.TURSO_CONNECTION_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.ADMIN_TOKEN = "test-admin-token";

const { db } = await import("../../src/db");
const { modelsRoutes } = await import("../../src/http/routes/models");
const { createApiKey, updateApiKey } =
  await import("../../src/db/repositories/api-keys");
const { upsertProviderAccount } =
  await import("../../src/db/repositories/provider-accounts");
await migrate(db, { migrationsFolder: "./drizzle/migrations" });

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalDatabaseUrl === undefined) {
    Reflect.deleteProperty(process.env, "TURSO_CONNECTION_URL");
  } else {
    process.env.TURSO_CONNECTION_URL = originalDatabaseUrl;
  }
  if (originalAdminToken === undefined) {
    Reflect.deleteProperty(process.env, "ADMIN_TOKEN");
  } else {
    process.env.ADMIN_TOKEN = originalAdminToken;
  }
  if (originalDatabaseToken === undefined) {
    Reflect.deleteProperty(process.env, "TURSO_AUTH_TOKEN");
  } else {
    process.env.TURSO_AUTH_TOKEN = originalDatabaseToken;
  }
});

test("public models discovery cannot force a new upstream fetch", async () => {
  let fetchCount = 0;
  globalThis.fetch = ((_url, init) => {
    fetchCount++;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Promise.resolve(
      Response.json({ anthropic: { id: "anthropic", models: {} } })
    );
  }) as typeof fetch;
  const app = new Hono().route("/", modelsRoutes);

  const unauthorized = await app.request("http://localhost/api.json?refresh=1");
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get("Cache-Control")).toBe("no-store");
  expect(fetchCount).toBe(0);

  const publicDiscovery = await app.request("http://localhost/api.json");
  expect(publicDiscovery.status).toBe(200);
  expect(fetchCount).toBe(1);

  const wrongToken = await app.request(
    "http://localhost/api.json?refresh=true",
    {
      headers: { Authorization: "Bearer wrong" },
    }
  );
  expect(wrongToken.status).toBe(401);
  expect(fetchCount).toBe(1);

  const adminRefresh = await app.request(
    "http://localhost/api.json?refresh=1",
    {
      headers: { Authorization: "Bearer test-admin-token" },
    }
  );
  expect(adminRefresh.status).toBe(200);
  expect(fetchCount).toBe(2);
});

const app = new Hono().route("/", modelsRoutes);

const serveUpstream = (claudeName: string) => {
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({
        anthropic: {
          id: "anthropic",
          models: { "claude-fake": { id: "claude-fake", name: claudeName } },
        },
        openai: {
          id: "openai",
          models: { "gpt-6": { id: "gpt-6", name: "GPT Fake" } },
        },
      })
    )) as typeof fetch;
  return app.request("http://localhost/api.json?refresh=1", {
    headers: { Authorization: "Bearer test-admin-token" },
  });
};

const requestScoped = (token: string, ifNoneMatch?: string) =>
  app.request(`http://localhost/api/${token}/api.json`, {
    headers: ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {},
  });

const kleisModelIds = async (response: Response): Promise<string[]> => {
  const body = (await response.json()) as {
    kleis: { models: Record<string, unknown> };
  };
  return Object.keys(body.kleis.models);
};

for (const provider of ["claude", "codex"] as const) {
  await upsertProviderAccount(db, {
    provider,
    accountId: `fake-${provider}-account`,
    accessToken: "fake-access-token",
    refreshToken: "fake-refresh-token",
    expiresAt: Date.now() + 3_600_000,
    metadata: null,
    now: Date.now(),
  });
}
const claudeKey = await createApiKey(
  db,
  { providerScopes: ["claude"] },
  Date.now()
);
const codexKey = await createApiKey(
  db,
  { providerScopes: ["codex"] },
  Date.now()
);

test.each([
  ["models.dev refreshes", () => serveUpstream("Claude Fake v2")],
  [
    "the key's scopes change",
    (keyId: string) =>
      updateApiKey(db, keyId, {
        label: null,
        providerScopes: ["codex"],
        modelScopes: null,
        accountScopes: null,
        expiresAt: null,
      }),
  ],
])(
  "catalog revalidates with its ETag until %s",
  async (_change, changeCatalog) => {
    await serveUpstream("Claude Fake v1");
    const key = await createApiKey(
      db,
      { providerScopes: ["claude"] },
      Date.now()
    );
    const token = key.modelsDiscoveryToken;
    const first = await requestScoped(token);
    const etag = first.headers.get("ETag");
    const firstBody = await first.text();
    expect(first.status).toBe(200);
    expect(etag).toBeTruthy();

    for (const ifNoneMatch of [`${etag}`, `"stale", W/${etag}`, "*"]) {
      const revalidated = await requestScoped(token, ifNoneMatch);
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("ETag")).toBe(etag);
      expect(await revalidated.text()).toBe("");
    }

    await changeCatalog(key.id);
    const changed = await requestScoped(token, `${etag}`);
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(etag);
    expect(await changed.text()).not.toBe(firstBody);
  }
);

test("one key's ETag never revalidates another key's catalog", async () => {
  await serveUpstream("Claude Fake");
  const claude = await requestScoped(claudeKey.modelsDiscoveryToken);
  const codex = await requestScoped(codexKey.modelsDiscoveryToken);
  const claudeEtag = `${claude.headers.get("ETag")}`;
  const codexEtag = `${codex.headers.get("ETag")}`;
  expect(claudeEtag).not.toBe(codexEtag);

  const codexWithClaudeEtag = await requestScoped(
    codexKey.modelsDiscoveryToken,
    claudeEtag
  );
  expect(codexWithClaudeEtag.status).toBe(200);
  expect(await kleisModelIds(codexWithClaudeEtag)).toEqual(["gpt-6"]);

  const claudeWithCodexEtag = await requestScoped(
    claudeKey.modelsDiscoveryToken,
    codexEtag
  );
  expect(claudeWithCodexEtag.status).toBe(200);
  expect(await kleisModelIds(claudeWithCodexEtag)).toEqual([
    "anthropic/claude-fake",
  ]);
});
