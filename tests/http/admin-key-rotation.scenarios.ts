import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";

if (
  process.env.TURSO_CONNECTION_URL !== ":memory:" ||
  process.env.TURSO_AUTH_TOKEN !== ""
) {
  throw new Error(
    "API key rotation scenarios require TURSO_CONNECTION_URL=:memory: and an empty TURSO_AUTH_TOKEN"
  );
}

globalThis.fetch = (async () =>
  Response.json({ output: [] })) as unknown as typeof fetch;

const { db } = await import("../../src/db");
const { apiKeys, requestUsageBuckets } = await import("../../src/db/schema");
const { createApiKey, revokeApiKey } =
  await import("../../src/db/repositories/api-keys");
const { upsertProviderAccount } =
  await import("../../src/db/repositories/provider-accounts");
const { requireProxyApiKey } =
  await import("../../src/http/middleware/api-key-auth");
const { proxyRoutes, flushProxyUsage } =
  await import("../../src/http/routes/proxy");
const { adminKeysRoutes } = await import("../../src/http/routes/admin-keys");
await migrate(db, { migrationsFolder: "./drizzle/migrations" });

const admin = new Hono().route("/admin/keys", adminKeysRoutes);
const proxy = new Hono();
proxy.use("*", requireProxyApiKey);
proxy.route("/", proxyRoutes);

const account = await upsertProviderAccount(db, {
  provider: "codex",
  accountId: "fake-codex-account",
  label: "Fake Codex",
  accessToken: "fake-codex-token",
  refreshToken: "fake-codex-refresh",
  expiresAt: Date.now() + 3_600_000,
  metadata: null,
  now: Date.now(),
});

const proxyStatus = async (secret: string) => {
  const response = await proxy.request("/openai/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: "gpt-fake" }),
  });
  await response.text();
  await flushProxyUsage();
  return response.status;
};

const rotate = (id: string, body?: string) =>
  admin.request(`/admin/keys/${id}/rotate`, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body }),
  });

const keyRow = async (id: string) =>
  db.query.apiKeys.findFirst({ where: eq(apiKeys.id, id) });

const usageRows = (id: string) =>
  db
    .select()
    .from(requestUsageBuckets)
    .where(eq(requestUsageBuckets.apiKeyId, id));

test("rotating swaps the secret on the same key and keeps its usage", async () => {
  const key = await createApiKey(db, { label: "fake key" }, Date.now());
  expect(await proxyStatus(key.key)).toBe(200);
  const before = await keyRow(key.id);

  for (const body of [undefined, "{}"]) {
    const previous = await keyRow(key.id);
    const usageBefore = await usageRows(key.id);
    expect(usageBefore).not.toEqual([]);
    const response = await rotate(key.id, body);
    expect(response.status).toBe(200);
    const { key: rotated } = (await response.json()) as {
      key: { id: string; key: string };
    };

    expect(rotated.id).toBe(key.id);
    expect(rotated.key).not.toBe(previous?.key);
    expect(await keyRow(key.id)).toEqual({
      ...before,
      key: rotated.key,
    } as typeof before);
    expect(await usageRows(key.id)).toEqual(usageBefore);
    expect(await proxyStatus(previous?.key ?? "")).toBe(401);
    expect(await proxyStatus(rotated.key)).toBe(200);
  }
  expect(await usageRows(key.id)).toMatchObject([
    { providerAccountId: account.id, requestCount: 3 },
  ]);
  expect(await db.select().from(apiKeys)).toHaveLength(1);
});

test("rotating a revoked key or sending unknown fields changes nothing", async () => {
  const revoked = await createApiKey(db, {}, Date.now());
  await revokeApiKey(db, revoked.id, Date.now());
  const active = await createApiKey(db, {}, Date.now());
  const snapshot = await db.select().from(apiKeys);

  const conflict = await rotate(revoked.id, "{}");
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ error: "conflict" });
  expect(
    (await rotate(active.id, JSON.stringify({ revokeOld: true }))).status
  ).toBe(400);
  expect((await rotate(crypto.randomUUID(), "{}")).status).toBe(404);

  expect(await db.select().from(apiKeys)).toEqual(snapshot);
  expect(await proxyStatus(active.key)).toBe(200);
});
