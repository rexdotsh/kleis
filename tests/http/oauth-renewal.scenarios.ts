import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";

if (
  process.env.TURSO_CONNECTION_URL !== ":memory:" ||
  process.env.TURSO_AUTH_TOKEN !== ""
) {
  throw new Error(
    "OAuth renewal scenarios require TURSO_CONNECTION_URL=:memory: and an empty TURSO_AUTH_TOKEN"
  );
}

const { db } = await import("../../src/db");
const { apiKeys, providerAccounts, requestUsageBuckets } =
  await import("../../src/db/schema");
const { createApiKey, findApiKeyById } =
  await import("../../src/db/repositories/api-keys");
const { adminAccountsRoutes } =
  await import("../../src/http/routes/admin-accounts");
await migrate(db, { migrationsFolder: "./drizzle/migrations" });

const app = new Hono().route("/admin/accounts", adminAccountsRoutes);

const EXISTING_ID = "2c8d0f5e-7d43-4b8e-9f0a-3a4b5c6d7e8f";
const originalFetch = globalThis.fetch;

const codexIdToken = (accountId: string) =>
  `header.${Buffer.from(JSON.stringify({ chatgpt_account_id: accountId })).toString("base64url")}.signature`;

const claudeTokens = (user: string, org: string) => ({
  access_token: "fake-new-access",
  expires_in: 365 * 86_400,
  account: { uuid: user, email_address: "fake@example.com" },
  organization: { uuid: org },
});

const codexTokens = (accountId: string) => ({
  access_token: "fake-new-access",
  refresh_token: "fake-new-refresh",
  expires_in: 3600,
  id_token: codexIdToken(accountId),
});

const existingClaude = {
  provider: "claude" as const,
  accountId: null,
  refreshToken: null,
  metadataJson: JSON.stringify({
    provider: "claude",
    scope: null,
    accountUuid: "fake-user",
    organizationUuid: "fake-org",
  }),
};

const existingCodex = {
  provider: "codex" as const,
  accountId: "fake-chatgpt-account",
  refreshToken: "fake-old-refresh",
  metadataJson: null,
};

beforeEach(async () => {
  await db.delete(providerAccounts);
  await db.delete(apiKeys);
  await db.delete(requestUsageBuckets);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const postJson = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const signIn = async (
  provider: "claude" | "codex",
  tokenResponse: Record<string, unknown>
) => {
  globalThis.fetch = (async () =>
    Response.json(tokenResponse)) as unknown as typeof fetch;
  const start = await postJson(
    `/admin/accounts/${provider}/oauth/start`,
    provider === "codex" ? { options: { mode: "browser" } } : {}
  );
  const { state } = (await start.json()) as { state: string };
  return postJson(`/admin/accounts/${provider}/oauth/complete`, {
    state,
    code: `fake-code#${state}`,
  });
};

test.each([
  [
    "a Claude sign-in for the same user and organization",
    existingClaude,
    "claude",
    claudeTokens("fake-user", "fake-org"),
    true,
  ],
  [
    "a Claude sign-in for another organization",
    existingClaude,
    "claude",
    claudeTokens("fake-user", "fake-other-org"),
    false,
  ],
  [
    "a Codex sign-in for the same ChatGPT account",
    existingCodex,
    "codex",
    codexTokens("fake-chatgpt-account"),
    true,
  ],
] as const)(
  "%s renews the existing account only when the identity matches",
  async (_name, existing, provider, tokenResponse, renews) => {
    const now = Date.now();
    await db.insert(providerAccounts).values({
      ...existing,
      id: EXISTING_ID,
      label: "Fake custom label",
      isPrimary: true,
      accessToken: "fake-old-access",
      expiresAt: now + 60_000,
      lastRefreshStatus: "reauthorize",
      createdAt: now,
      updatedAt: now,
    });
    const key = await createApiKey(
      db,
      { label: "fake key", accountScopes: [EXISTING_ID] },
      now
    );
    await db.insert(requestUsageBuckets).values({
      bucketStart: 0,
      apiKeyId: key.id,
      providerAccountId: EXISTING_ID,
      provider,
      endpoint: "fake-endpoint",
      requestCount: 3,
      lastRequestAt: 0,
    });

    const response = await signIn(provider, tokenResponse);

    expect(response.status).toBe(200);
    const accounts = await db.select().from(providerAccounts);
    const existingRow = accounts.find((row) => row.id === EXISTING_ID);
    if (renews) {
      expect(accounts).toHaveLength(1);
      expect(existingRow).toMatchObject({
        label: "Fake custom label",
        isPrimary: true,
        accessToken: "fake-new-access",
        lastRefreshStatus: "success",
      });
    } else {
      expect(accounts).toHaveLength(2);
      expect(existingRow?.accessToken).toBe("fake-old-access");
    }
    expect((await findApiKeyById(db, key.id))?.accountScopes).toEqual([
      EXISTING_ID,
    ]);
    expect(
      await db
        .select()
        .from(requestUsageBuckets)
        .where(eq(requestUsageBuckets.providerAccountId, EXISTING_ID))
    ).toMatchObject([{ requestCount: 3 }]);
  }
);
