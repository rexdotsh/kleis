import { afterAll, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalDatabaseUrl = process.env.TURSO_CONNECTION_URL;
const originalFetch = globalThis.fetch;
const databaseDirectory = await mkdtemp(join(tmpdir(), "kleis-claude-resets-"));
process.env.TURSO_CONNECTION_URL = `file:${join(databaseDirectory, "test.db")}`;

const { db } = await import("../../src/db");
const { providerAccounts } = await import("../../src/db/schema");
const { adminAccountsRoutes } =
  await import("../../src/http/routes/admin-accounts");
await migrate(db, { migrationsFolder: "./drizzle/migrations" });

afterAll(async () => {
  globalThis.fetch = originalFetch;
  if (originalDatabaseUrl === undefined) {
    Reflect.deleteProperty(process.env, "TURSO_CONNECTION_URL");
  } else {
    process.env.TURSO_CONNECTION_URL = originalDatabaseUrl;
  }
  await rm(databaseDirectory, { recursive: true, force: true });
});

const app = new Hono().route("/admin/accounts", adminAccountsRoutes);

const addAccount = async (provider: "claude" | "codex", metadata: unknown) => {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.insert(providerAccounts).values({
    id,
    provider,
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: now + 60 * 60_000,
    metadataJson: JSON.stringify(metadata),
    createdAt: now,
    updatedAt: now,
  });
  return id;
};

const consume = (id: string, body: unknown) =>
  app.request(
    `http://localhost/admin/accounts/${id}/tracking/claude/reset-credits/consume`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

const validBody = { grantId: "grant_fake_1", offerKey: "a".repeat(32) };

test("the Claude reset claim route checks the account and body before anything is sent", async () => {
  const sent: string[] = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    sent.push(String(input));
    return Promise.reject(new Error("no network in tests"));
  }) as typeof fetch;
  const claude = await addAccount("claude", {
    provider: "claude",
    oauthMode: "max",
    oauthHost: "claude.ai",
  });
  const codex = await addAccount("codex", {
    provider: "codex",
    chatgptAccountId: null,
    email: null,
  });

  expect((await consume("missing", validBody)).status).toBe(404);
  expect((await consume(codex, validBody)).status).toBe(400);
  for (const body of [
    {},
    { ...validBody, grantId: "../../orgs" },
    { ...validBody, offerKey: "short" },
    { ...validBody, organizationUuid: "someone-else" },
  ]) {
    expect((await consume(claude, body)).status).toBe(400);
  }

  const unknownOrganization = await consume(claude, validBody);
  expect(unknownOrganization.status).toBe(409);
  expect(await unknownOrganization.json()).toMatchObject({
    error: "conflict",
    reason: "organization_unknown",
  });
  expect(sent.filter((url) => url.includes("reset_rate_limits"))).toEqual([]);
});

test("account lists carry no reset view until resets were read", async () => {
  globalThis.fetch = (() =>
    Promise.reject(
      new Error("no network in tests")
    )) as unknown as typeof fetch;
  const response = await app.request("http://localhost/admin/accounts");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    accounts: { provider: string; claudeResets: unknown }[];
  };
  expect(body.accounts.length).toBeGreaterThan(0);
  for (const account of body.accounts) {
    expect(account.claudeResets).toBeNull();
  }
});
