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
const { installErrorHandler } = await import("../../src/http/error-handler");
const { adminAccountsRoutes } =
  await import("../../src/http/routes/admin-accounts");
await migrate(db, { migrationsFolder: "./drizzle/migrations" });

const app = new Hono();
installErrorHandler(app);
app.route("/admin/accounts", adminAccountsRoutes);

const EXISTING_ID = "2c8d0f5e-7d43-4b8e-9f0a-3a4b5c6d7e8f";
const originalFetch = globalThis.fetch;

const codexIdToken = (accountId: string, userId?: string) =>
  `header.${Buffer.from(
    JSON.stringify({
      chatgpt_account_id: accountId,
      ...(userId
        ? { "https://api.openai.com/auth": { chatgpt_user_id: userId } }
        : {}),
    })
  ).toString("base64url")}.signature`;

const claudeTokens = (user: string, org: string) => ({
  access_token: "fake-new-access",
  expires_in: 365 * 86_400,
  account: { uuid: user, email_address: "fake@example.com" },
  organization: { uuid: org },
});

const codexTokens = (accountId: string, userId: string) => ({
  access_token: "fake-new-access",
  refresh_token: "fake-new-refresh",
  expires_in: 3600,
  id_token: codexIdToken(accountId, userId),
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

const existingCodex = (
  accountId: string | null,
  chatgptUserId: string | null
) => ({
  provider: "codex" as const,
  accountId,
  refreshToken: "fake-old-refresh",
  metadataJson: JSON.stringify({
    provider: "codex",
    scope: null,
    chatgptAccountId: "fake-team",
    email: null,
    chatgptUserId,
  }),
});

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

const startSignIn = async (
  provider: "claude" | "codex",
  options: Record<string, unknown> = {}
) => {
  const start = await postJson(`/admin/accounts/${provider}/oauth/start`, {
    options: provider === "codex" ? { mode: "browser", ...options } : options,
  });
  const { state } = (await start.json()) as { state: string };
  return () =>
    postJson(`/admin/accounts/${provider}/oauth/complete`, {
      state,
      code: `fake-code#${state}`,
    });
};

const mockTokenResponse = (tokenResponse: Record<string, unknown>) => {
  globalThis.fetch = (async () =>
    Response.json(tokenResponse)) as unknown as typeof fetch;
};

type Existing = typeof existingClaude | ReturnType<typeof existingCodex>;

const insertExisting = async (existing: Existing) => {
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
    provider: existing.provider,
    endpoint: "fake-endpoint",
    requestCount: 3,
    lastRequestAt: 0,
  });
  return key;
};

test.each([
  [
    "a Claude sign-in for the same user and organization",
    existingClaude,
    claudeTokens("fake-user", "fake-org"),
    "renews",
  ],
  [
    "a Claude sign-in for another organization",
    existingClaude,
    claudeTokens("fake-user", "fake-other-org"),
    "adds",
  ],
  [
    "a Codex sign-in for the same workspace and user",
    existingCodex("fake-team", "fake-user-a"),
    codexTokens("fake-team", "fake-user-a"),
    "renews",
  ],
  [
    "a Codex sign-in for another user of the workspace",
    existingCodex(null, "fake-user-a"),
    codexTokens("fake-team", "fake-user-b"),
    "adds",
  ],
  [
    "a Codex sign-in for another user of a workspace that holds the ID",
    existingCodex("fake-team", "fake-user-a"),
    codexTokens("fake-team", "fake-user-b"),
    "conflicts",
  ],
  [
    "a Codex sign-in for a workspace whose row has no user",
    existingCodex("fake-team", null),
    codexTokens("fake-team", "fake-user-a"),
    "conflicts",
  ],
] as const)(
  "%s renews the existing account only when the identity matches",
  async (_name, existing, tokenResponse, outcome) => {
    const key = await insertExisting(existing);
    mockTokenResponse(tokenResponse);

    const response = await (await startSignIn(existing.provider))();

    expect(response.status).toBe(outcome === "conflicts" ? 409 : 200);
    const accounts = await db.select().from(providerAccounts);
    const existingRow = accounts.find((row) => row.id === EXISTING_ID);
    if (outcome === "renews") {
      expect(accounts).toHaveLength(1);
      expect(existingRow).toMatchObject({
        label: "Fake custom label",
        isPrimary: true,
        accessToken: "fake-new-access",
        lastRefreshStatus: "success",
      });
    } else {
      expect(accounts).toHaveLength(outcome === "adds" ? 2 : 1);
      expect(existingRow).toMatchObject({
        accessToken: "fake-old-access",
        metadataJson: existing.metadataJson,
      });
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

test("reauthorizing a Codex row without a user records the user", async () => {
  await insertExisting(existingCodex("fake-team", null));
  mockTokenResponse(codexTokens("fake-team", "fake-user-a"));

  const complete = await startSignIn("codex", {
    replaceAccountId: EXISTING_ID,
  });
  const response = await complete();

  expect(response.status).toBe(200);
  const accounts = await db.select().from(providerAccounts);
  expect(accounts).toHaveLength(1);
  expect(accounts[0]?.accessToken).toBe("fake-new-access");
  expect(JSON.parse(accounts[0]?.metadataJson ?? "{}")).toMatchObject({
    chatgptAccountId: "fake-team",
    chatgptUserId: "fake-user-a",
  });
});

test("concurrent Claude sign-ins for one identity add one account", async () => {
  mockTokenResponse(claudeTokens("fake-user", "fake-org"));
  const completes = [await startSignIn("claude"), await startSignIn("claude")];

  const responses = await Promise.all(
    completes.map(async (complete) => complete())
  );

  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(await db.select().from(providerAccounts)).toHaveLength(1);
});

test.each([
  ["another user", "fake-user-b", 409, "fake-old-access"],
  ["the same user", "fake-user-a", 200, "fake-imported-access"],
  ["an unknown user", null, 200, "fake-imported-access"],
] as const)(
  "importing %s of a connected Codex workspace only replaces their own sign-in",
  async (_name, chatgptUserId, status, storedAccessToken) => {
    await insertExisting(existingCodex("fake-team", "fake-user-a"));

    const response = await postJson("/admin/accounts/codex/import", {
      accessToken: "fake-imported-access",
      refreshToken: "fake-imported-refresh",
      expiresAt: Date.now() + 3_600_000,
      accountId: "fake-team",
      metadata: { chatgptUserId },
    });

    expect(response.status).toBe(status);
    const accounts = await db.select().from(providerAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: EXISTING_ID,
      accessToken: storedAccessToken,
    });
    if (status === 409) {
      expect(accounts[0]?.metadataJson).toBe(
        existingCodex("fake-team", "fake-user-a").metadataJson
      );
    }
  }
);
