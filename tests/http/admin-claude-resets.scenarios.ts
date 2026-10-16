import { beforeEach, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";

if (
  process.env.TURSO_CONNECTION_URL !== ":memory:" ||
  process.env.TURSO_AUTH_TOKEN !== ""
) {
  throw new Error(
    "Claude reset scenarios require TURSO_CONNECTION_URL=:memory: and an empty TURSO_AUTH_TOKEN"
  );
}

const sent: string[] = [];
globalThis.fetch = ((input: string | URL | Request) => {
  sent.push(String(input));
  return Promise.reject(new Error("no network in Claude reset scenarios"));
}) as typeof fetch;

const { db } = await import("../../src/db");
const { providerAccounts } = await import("../../src/db/schema");
const { adminAccountsRoutes } =
  await import("../../src/http/routes/admin-accounts");
await migrate(db, { migrationsFolder: "./drizzle/migrations" });

beforeEach(() => {
  sent.length = 0;
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
    reason: "identity_unverified",
  });
  expect(sent.filter((url) => url.includes("reset_rate_limits"))).toEqual([]);
});

test("account lists carry no reset view until resets were read", async () => {
  await addAccount("claude", {
    provider: "claude",
    oauthMode: "max",
    oauthHost: "claude.ai",
  });
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
