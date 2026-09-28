import { afterAll, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDatabaseUrl = process.env.TURSO_CONNECTION_URL;
const originalAdminToken = process.env.ADMIN_TOKEN;
const originalFetch = globalThis.fetch;
const databaseDirectory = await mkdtemp(join(tmpdir(), "kleis-models-auth-"));
process.env.TURSO_CONNECTION_URL = `file:${join(databaseDirectory, "test.db")}`;
process.env.ADMIN_TOKEN = "test-admin-token";

const { db } = await import("../../src/db");
const { modelsRoutes } = await import("../../src/http/routes/models");
await migrate(db, { migrationsFolder: "./drizzle/migrations" });

afterAll(async () => {
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
  await rm(databaseDirectory, { recursive: true, force: true });
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
