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
const { proxyRoutes } = await import("../../src/http/routes/proxy");
await migrate(db, { migrationsFolder: "./drizzle/migrations" });

const app = new Hono();
installErrorHandler(app);
app.route("/admin/accounts", adminAccountsRoutes);

const proxyApp = new Hono();
installErrorHandler(proxyApp);
proxyApp.use("*", async (context, next) => {
  context.set("proxyApiKeyId", "fake-key");
  context.set("proxyApiKeyAccountScopeIds", [
    context.req.header("x-test-account") ?? "",
  ]);
  const text = await context.req.text();
  context.set("proxyRequestBody", {
    text,
    parsed: JSON.parse(text) as unknown,
    model: "gpt-fake",
  });
  await next();
});
proxyApp.route("/", proxyRoutes);

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
    "adds",
  ],
  [
    "a Codex sign-in for a workspace whose row has no user",
    existingCodex("fake-team", null),
    codexTokens("fake-team", "fake-user-a"),
    "adds",
  ],
] as const)(
  "%s renews the existing account only when the identity matches",
  async (_name, existing, tokenResponse, outcome) => {
    const key = await insertExisting(existing);
    mockTokenResponse(tokenResponse);

    const response = await (await startSignIn(existing.provider))();

    expect(response.status).toBe(200);
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
      expect(accounts).toHaveLength(2);
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
  [
    "another user",
    "fake-user-a",
    "fake-imported-access",
    "fake-user-b",
    "adds",
  ],
  [
    "the same user",
    "fake-user-a",
    "fake-imported-access",
    "fake-user-a",
    "renews",
  ],
  [
    "the same user, named only by the access token",
    "fake-user-a",
    codexIdToken("fake-team", "fake-user-a"),
    null,
    "renews",
  ],
  ["an unknown user", "fake-user-a", "fake-imported-access", null, "adds"],
  [
    "an unknown user over a row without a user",
    null,
    "fake-imported-access",
    null,
    "conflicts",
  ],
] as const)(
  "importing %s of a connected Codex workspace only replaces their own sign-in",
  async (_name, existingUser, accessToken, chatgptUserId, outcome) => {
    const existing = existingCodex("fake-team", existingUser);
    await insertExisting(existing);

    const response = await postJson("/admin/accounts/codex/import", {
      accessToken,
      refreshToken: "fake-imported-refresh",
      expiresAt: Date.now() + 3_600_000,
      accountId: "fake-team",
      metadata: { chatgptUserId },
    });

    expect(response.status).toBe(outcome === "conflicts" ? 409 : 200);
    const accounts = await db.select().from(providerAccounts);
    const existingRow = accounts.find((row) => row.id === EXISTING_ID);
    if (outcome === "renews") {
      expect(accounts).toHaveLength(1);
      expect(existingRow?.accessToken).toBe(accessToken);
    } else {
      expect(accounts).toHaveLength(outcome === "adds" ? 2 : 1);
      expect(existingRow).toMatchObject({
        accessToken: "fake-old-access",
        refreshToken: "fake-old-refresh",
        metadataJson: existing.metadataJson,
      });
    }
  }
);

test("imports of two users into a workspace whose row has no user add an account each", async () => {
  await insertExisting(existingCodex("fake-team", null));
  const importUser = (chatgptUserId: string) =>
    postJson("/admin/accounts/codex/import", {
      accessToken: `fake-access-${chatgptUserId}`,
      refreshToken: "fake-imported-refresh",
      expiresAt: Date.now() + 3_600_000,
      accountId: "fake-team",
      metadata: { chatgptUserId },
    });

  const responses = await Promise.all([
    importUser("fake-user-a"),
    importUser("fake-user-b"),
  ]);

  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const accounts = await db.select().from(providerAccounts);
  expect(accounts).toHaveLength(3);
  expect(accounts.find((row) => row.id === EXISTING_ID)).toMatchObject({
    accessToken: "fake-old-access",
    metadataJson: existingCodex("fake-team", null).metadataJson,
  });
});

test("two users of one workspace each route with their own token and the workspace header", async () => {
  const added: string[] = [];
  for (const user of ["fake-user-a", "fake-user-b"]) {
    mockTokenResponse({
      ...codexTokens("fake-team", user),
      access_token: `fake-access-${user}`,
    });
    const response = await (await startSignIn("codex"))();
    expect(response.status).toBe(200);
    const { account } = (await response.json()) as { account: { id: string } };
    added.push(account.id);
  }

  const upstream: Headers[] = [];
  globalThis.fetch = (async (_input, init) => {
    upstream.push(new Headers(init?.headers));
    return Response.json({ output: [] });
  }) as typeof fetch;
  for (const id of added) {
    const response = await proxyApp.request("/openai/v1/responses", {
      method: "POST",
      headers: { "x-test-account": id },
      body: "{}",
    });
    expect(response.status).toBe(200);
    await response.text();
  }

  expect(
    upstream.map((headers) => [
      headers.get("authorization"),
      headers.get("ChatGPT-Account-Id"),
    ])
  ).toEqual([
    ["Bearer fake-access-fake-user-a", "fake-team"],
    ["Bearer fake-access-fake-user-b", "fake-team"],
  ]);
});

test("a row without a user keeps its refreshed sign-in when another account holds that user", async () => {
  await insertExisting(existingCodex("fake-team", null));
  await db
    .update(providerAccounts)
    .set({ lastRefreshStatus: "success" })
    .where(eq(providerAccounts.id, EXISTING_ID));
  mockTokenResponse(codexTokens("fake-team", "fake-user-a"));
  expect((await (await startSignIn("codex"))()).status).toBe(200);
  mockTokenResponse({
    ...codexTokens("fake-team", "fake-user-a"),
    access_token: "fake-refreshed-access",
    refresh_token: "fake-refreshed-refresh",
  });

  const response = await postJson(`/admin/accounts/${EXISTING_ID}/refresh`, {});

  expect(response.status).toBe(200);
  const accounts = await db.select().from(providerAccounts);
  expect(accounts).toHaveLength(2);
  expect(accounts.find((row) => row.id === EXISTING_ID)).toMatchObject({
    accessToken: "fake-refreshed-access",
    refreshToken: "fake-refreshed-refresh",
  });
});

test.each([
  ["another user", "fake-user-b", "fake-old-access", "reauthorize"],
  ["the attached user", "fake-user-a", "fake-refreshed-access", "success"],
] as const)(
  "a refresh naming %s never replaces a user attached while it was in flight",
  async (_name, refreshedUser, accessToken, lastRefreshStatus) => {
    await insertExisting(existingCodex("fake-team", null));
    await db
      .update(providerAccounts)
      .set({ lastRefreshStatus: "success" })
      .where(eq(providerAccounts.id, EXISTING_ID));
    mockTokenResponse(codexTokens("fake-team", "fake-user-b"));
    expect((await (await startSignIn("codex"))()).status).toBe(200);
    globalThis.fetch = (async () => {
      await app.request(`/admin/accounts/${EXISTING_ID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { chatgptUserId: "fake-user-a" } }),
      });
      return Response.json({
        ...codexTokens("fake-team", refreshedUser),
        access_token: "fake-refreshed-access",
      });
    }) as unknown as typeof fetch;

    await postJson(`/admin/accounts/${EXISTING_ID}/refresh`, {});

    const [row] = await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, EXISTING_ID));
    expect(row).toMatchObject({ accessToken, lastRefreshStatus });
    expect(JSON.parse(row?.metadataJson ?? "{}")).toMatchObject({
      chatgptUserId: "fake-user-a",
    });
  }
);
