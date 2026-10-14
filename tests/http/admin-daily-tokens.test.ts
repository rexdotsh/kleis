import { afterAll, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDatabaseUrl = process.env.TURSO_CONNECTION_URL;
const originalAdminToken = process.env.ADMIN_TOKEN;
const databaseDirectory = await mkdtemp(join(tmpdir(), "kleis-daily-route-"));
process.env.TURSO_CONNECTION_URL = `file:${join(databaseDirectory, "test.db")}`;
process.env.ADMIN_TOKEN = "test-admin-token";

const { db } = await import("../../src/db");
const { providerAccounts, requestUsageBuckets } = await import(
  "../../src/db/schema"
);
const { default: server } = await import("../../src/index");
await migrate(db, { migrationsFolder: "./drizzle/migrations" });

const now = Date.now();
await db.insert(providerAccounts).values(
  (["claude-a", "claude-b"] as const).map((id, index) => ({
    id,
    provider: "claude" as const,
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: now + 3_600_000,
    createdAt: index,
    updatedAt: index,
  }))
);
await db.insert(requestUsageBuckets).values({
  bucketStart: now - (now % 60_000),
  apiKeyId: "key",
  providerAccountId: "claude-a",
  provider: "claude",
  endpoint: "messages",
  model: "claude-opus",
  requestCount: 2,
  successCount: 2,
  inputTokens: 3,
  outputTokens: 4,
  cacheReadTokens: 5,
  lastRequestAt: now,
});

afterAll(async () => {
  for (const [name, value] of [
    ["TURSO_CONNECTION_URL", originalDatabaseUrl],
    ["ADMIN_TOKEN", originalAdminToken],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  await rm(databaseDirectory, { recursive: true, force: true });
});

const get = (path: string, token: string | null = "test-admin-token") =>
  server.fetch(
    new Request(`http://localhost${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
    {} as Bun.Server<unknown>
  );

test("daily tokens require the admin token", async () => {
  expect((await get("/admin/accounts/daily-tokens", null)).status).toBe(401);
  expect(
    (await get("/admin/accounts/claude-a/daily-tokens", "nope")).status
  ).toBe(401);
});

test("one account defaults to 30 UTC days", async () => {
  const response = await get("/admin/accounts/claude-a/daily-tokens");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.days).toBe(30);
  expect(body.providerAccountId).toBe("claude-a");
  expect(body.provider).toBe("claude");
  expect(body.daily).toHaveLength(30);
  expect(body.daily.at(-1)).toMatchObject({
    date: new Date(now).toISOString().slice(0, 10),
    requestCount: 2,
    totalTokens: 12,
  });
  expect(body.totals.totalTokens).toBe(12);

  expect((await get("/admin/accounts/missing/daily-tokens")).status).toBe(404);
});

test("batched daily tokens return the requested accounts", async () => {
  const response = await get(
    "/admin/accounts/daily-tokens?days=7&ids=claude-b,claude-a,claude-a"
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.days).toBe(7);
  expect(
    body.accounts.map(
      (account: { providerAccountId: string; daily: unknown[] }) => [
        account.providerAccountId,
        account.daily.length,
      ]
    )
  ).toEqual([
    ["claude-a", 7],
    ["claude-b", 7],
  ]);

  const all = await (
    await get("/admin/accounts/daily-tokens?provider=claude")
  ).json();
  expect(all.accounts).toHaveLength(2);
  expect(all.accounts[0].daily).toHaveLength(30);
});

test("daily tokens validate their query", async () => {
  for (const path of [
    "/admin/accounts/daily-tokens?days=0",
    "/admin/accounts/daily-tokens?days=91",
    "/admin/accounts/daily-tokens?days=abc",
    "/admin/accounts/daily-tokens?ids=,",
    "/admin/accounts/daily-tokens?provider=gemini",
    "/admin/accounts/daily-tokens?unknown=1",
    "/admin/accounts/claude-a/daily-tokens?days=1.5",
    "/admin/accounts/claude-a/daily-tokens?ids=claude-a",
  ]) {
    expect({ path, status: (await get(path)).status }).toEqual({
      path,
      status: 400,
    });
  }
});
