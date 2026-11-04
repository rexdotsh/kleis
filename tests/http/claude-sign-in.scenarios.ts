import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";

if (
  process.env.TURSO_CONNECTION_URL !== ":memory:" ||
  process.env.TURSO_AUTH_TOKEN !== ""
) {
  throw new Error(
    "Claude sign-in scenarios require TURSO_CONNECTION_URL=:memory: and an empty TURSO_AUTH_TOKEN"
  );
}

const { db } = await import("../../src/db");
const { providerAccounts } = await import("../../src/db/schema");
const { createApiKey } = await import("../../src/db/repositories/api-keys");
const { upsertProviderAccount } =
  await import("../../src/db/repositories/provider-accounts");
const { requireProxyApiKey } =
  await import("../../src/http/middleware/api-key-auth");
const { installErrorHandler } = await import("../../src/http/error-handler");
const { proxyRoutes, flushProxyUsage } =
  await import("../../src/http/routes/proxy");
const { adminAccountsRoutes } =
  await import("../../src/http/routes/admin-accounts");
await migrate(db, { migrationsFolder: "./drizzle/migrations" });

const app = new Hono();
installErrorHandler(app);
app.route("/admin/accounts", adminAccountsRoutes);
app.use("/anthropic/*", requireProxyApiKey);
app.route("/", proxyRoutes);

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const YEAR_SECONDS = 365 * 86_400;
const originalFetch = globalThis.fetch;
let tokenRequests: Record<string, unknown>[];
let messageTokens: string[];
let messageStatus: number;
let grantedExpiresIn: number | undefined;

beforeEach(async () => {
  await db.delete(providerAccounts);
  tokenRequests = [];
  messageTokens = [];
  messageStatus = 200;
  grantedExpiresIn = YEAR_SECONDS;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      tokenRequests.push(JSON.parse(String(init?.body)) as never);
      return Response.json({
        access_token: "fake-year-access",
        refresh_token: "fake-refresh-to-ignore",
        refresh_token_expires_in: 28 * 86_400,
        expires_in: grantedExpiresIn,
        scope: "user:inference user:profile",
        account: { uuid: "fake-user", email_address: "fake@example.com" },
        organization: { uuid: "fake-org" },
      });
    }
    if (url.startsWith("https://api.anthropic.com/v1/messages")) {
      messageTokens.push(new Headers(init?.headers).get("authorization") ?? "");
      return Response.json(
        messageStatus === 200
          ? { type: "message", content: [] }
          : { type: "error", error: { type: "authentication_error" } },
        { status: messageStatus }
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const postJson = (path: string, body: unknown, headers = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const signIn = async () => {
  const start = await postJson("/admin/accounts/claude/oauth/start", {});
  const { authorizationUrl, state } = (await start.json()) as {
    authorizationUrl: string;
    state: string;
  };
  const complete = await postJson("/admin/accounts/claude/oauth/complete", {
    state,
    code: `fake-code#${state}`,
  });
  return { authorizationUrl: new URL(authorizationUrl), complete };
};

const sendMessage = async () => {
  const key = await createApiKey(db, { label: "fake key" }, Date.now());
  const response = await postJson(
    "/anthropic/v1/messages",
    { model: "claude-fake", max_tokens: 1, messages: [] },
    { authorization: `Bearer ${key.key}` }
  );
  await response.text();
  await flushProxyUsage();
  return response;
};

const storedAccounts = () => db.select().from(providerAccounts);

test("a sign-in asks for a year and keeps no refresh token", async () => {
  const { authorizationUrl, complete } = await signIn();

  expect(complete.status).toBe(200);
  expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
    "https://claude.ai/oauth/authorize"
  );
  expect(authorizationUrl.searchParams.get("scope")).toBe(
    "user:profile user:inference"
  );
  expect(tokenRequests).toMatchObject([
    { grant_type: "authorization_code", expires_in: YEAR_SECONDS },
  ]);
  const [account] = await storedAccounts();
  expect(account).toMatchObject({
    accessToken: "fake-year-access",
    refreshToken: null,
  });
  expect(account?.expiresAt).toBeGreaterThan(
    Date.now() + (YEAR_SECONDS - 86_400) * 1000
  );
});

test.each([
  ["a shorter lifetime", 8 * 3600],
  ["no lifetime", undefined],
])(
  "a sign-in granted %s is rejected without saving",
  async (_name, expiresIn) => {
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    grantedExpiresIn = expiresIn;
    try {
      const { complete } = await signIn();
      expect(complete.status).toBe(500);
      expect(((await complete.json()) as { message: string }).message).toMatch(
        "instead of one year"
      );
      expect(await storedAccounts()).toEqual([]);
    } finally {
      error.mockRestore();
    }
  }
);

test.each([
  ["rejected by Anthropic", Date.now() + 3_600_000, 401, 401, 1],
  ["past its expiry", Date.now() - 1000, 200, 502, 0],
])(
  "a sign-in %s is flagged for reauthorization without a refresh",
  async (_name, expiresAt, upstreamStatus, clientStatus, upstreamCalls) => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    messageStatus = upstreamStatus;
    const account = await upsertProviderAccount(db, {
      provider: "claude",
      accountId: null,
      label: "Fake Claude",
      accessToken: "fake-legacy-access",
      refreshToken: "fake-legacy-refresh",
      expiresAt,
      metadata: null,
      now: Date.now(),
    });
    try {
      const response = await sendMessage();

      expect(response.status).toBe(clientStatus);
      expect(messageTokens).toHaveLength(upstreamCalls);
      expect(tokenRequests).toEqual([]);
      const [stored] = await db
        .select()
        .from(providerAccounts)
        .where(eq(providerAccounts.id, account.id));
      expect(stored).toMatchObject({
        accessToken: "fake-legacy-access",
        lastRefreshStatus: "reauthorize",
      });
    } finally {
      warn.mockRestore();
    }
  }
);

test("a Claude token imports without a refresh token", async () => {
  const expiresAt = Date.now() + YEAR_SECONDS * 1000;
  const response = await postJson("/admin/accounts/claude/import", {
    accessToken: "fake-setup-token",
    expiresAt,
    metadata: { scope: "user:inference" },
  });

  expect(response.status).toBe(200);
  const [account] = await storedAccounts();
  expect(account).toMatchObject({
    provider: "claude",
    accessToken: "fake-setup-token",
    refreshToken: null,
    expiresAt,
  });
  expect((await sendMessage()).status).toBe(200);
  expect(messageTokens).toEqual(["Bearer fake-setup-token"]);
});

test("a failed reauthorization flag keeps the token out of the limits", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const error = spyOn(console, "error").mockImplementation(() => undefined);
  await db.run(sql`CREATE TRIGGER reject_reauthorization_flag
    BEFORE UPDATE ON provider_accounts
    WHEN NEW.last_refresh_status = 'reauthorize'
    BEGIN SELECT RAISE(ABORT, 'flag write blocked'); END`);
  const account = await upsertProviderAccount(db, {
    provider: "claude",
    accountId: null,
    label: "Fake Claude",
    accessToken: "fake-secret-access",
    refreshToken: null,
    expiresAt: Date.now() - 1000,
    metadata: null,
    now: Date.now(),
  });
  try {
    const response = await app.request("/admin/accounts/quotas");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(
      (JSON.parse(body) as { quotas: Record<string, { error: string }> })
        .quotas[account.id]?.error
    ).toContain("flag write blocked");
    const logs = [...warn.mock.calls, ...error.mock.calls].join("\n");
    expect(`${body}\n${logs}`).not.toContain("fake-secret-access");
  } finally {
    await db.run(sql`DROP TRIGGER reject_reauthorization_flag`);
    warn.mockRestore();
    error.mockRestore();
  }
});
