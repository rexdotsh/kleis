import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";

if (
  process.env.TURSO_CONNECTION_URL !== ":memory:" ||
  process.env.TURSO_AUTH_TOKEN !== ""
) {
  throw new Error(
    "Reauthorize link scenarios require TURSO_CONNECTION_URL=:memory: and an empty TURSO_AUTH_TOKEN"
  );
}

const { db } = await import("../../src/db");
const {
  apiKeys,
  oauthStates,
  providerAccounts,
  reauthLinks,
  requestUsageBuckets,
} = await import("../../src/db/schema");
const { createApiKey, findApiKeyById } =
  await import("../../src/db/repositories/api-keys");
const { installErrorHandler } = await import("../../src/http/error-handler");
const { adminAccountsRoutes } =
  await import("../../src/http/routes/admin-accounts");
const { reauthRoutes } = await import("../../src/http/routes/reauth");
await migrate(db, { migrationsFolder: "./drizzle/migrations" });

const app = new Hono();
installErrorHandler(app);
app.route("/", reauthRoutes);
app.route("/admin/accounts", adminAccountsRoutes);

const ACCOUNT_ID = "2c8d0f5e-7d43-4b8e-9f0a-3a4b5c6d7e8f";
const YEAR_SECONDS = 365 * 86_400;
const originalFetch = globalThis.fetch;

const claudeTokens = (
  user: string,
  org: string,
  expiresIn = YEAR_SECONDS,
  accessToken = "fake-new-access"
) => ({
  access_token: accessToken,
  refresh_token: "fake-new-refresh",
  expires_in: expiresIn,
  account: { uuid: user, email_address: "fake-owner@example.com" },
  organization: { uuid: org },
});

let exchanged = false;

const mockTokenResponse = (body: Record<string, unknown>, status = 200) => {
  globalThis.fetch = (async () => {
    exchanged = true;
    return Response.json(body, { status });
  }) as unknown as typeof fetch;
};

// Fault injection: runs `inject` before the nth provider_accounts read that
// follows the token exchange.
let interceptAccountRead: (() => Promise<void>) | null = null;
const client = db.$client;
const originalExecute = client.execute.bind(client);
client.execute = (async (statement: Parameters<typeof client.execute>[0]) => {
  const text = typeof statement === "string" ? statement : statement.sql;
  if (interceptAccountRead && text.includes('from "provider_accounts"')) {
    await interceptAccountRead();
  }
  return originalExecute(statement);
}) as typeof client.execute;

const beforeAccountReadAfterExchange = (
  nth: number,
  inject: () => Promise<void>
) => {
  let reads = 0;
  interceptAccountRead = async () => {
    if (!exchanged || ++reads < nth) return;
    interceptAccountRead = null;
    await inject();
  };
};

beforeEach(async () => {
  exchanged = false;
  interceptAccountRead = null;
  await db.delete(oauthStates);
  await db.delete(reauthLinks);
  await db.delete(providerAccounts);
  await db.delete(apiKeys);
  await db.delete(requestUsageBuckets);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const insertAccount = async (label = "Fake Team Seat") => {
  const now = Date.now();
  await db.insert(providerAccounts).values({
    id: ACCOUNT_ID,
    provider: "claude",
    label,
    accountId: null,
    isPrimary: true,
    accessToken: "fake-old-access",
    refreshToken: null,
    expiresAt: now + 60_000,
    metadataJson: JSON.stringify({
      provider: "claude",
      scope: null,
      accountUuid: "fake-user-uuid",
      email: "fake-owner@example.com",
      organizationUuid: "fake-org-uuid",
    }),
    lastRefreshStatus: "reauthorize",
    createdAt: now,
    updatedAt: now,
  });
  const key = await createApiKey(
    db,
    { label: "fake key", accountScopes: [ACCOUNT_ID] },
    now
  );
  await db.insert(requestUsageBuckets).values({
    bucketStart: 0,
    apiKeyId: key.id,
    providerAccountId: ACCOUNT_ID,
    provider: "claude",
    endpoint: "fake-endpoint",
    requestCount: 3,
    lastRequestAt: 0,
  });
  return key;
};

const storedAccount = async () =>
  (
    await db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, ACCOUNT_ID))
  )[0];

const shareLink = async (): Promise<string> => {
  const response = await app.request(
    `/admin/accounts/${ACCOUNT_ID}/reauth-link`,
    { method: "POST" }
  );
  expect(response.status).toBe(200);
  const { reauthLink } = (await response.json()) as {
    reauthLink: { url: string };
  };
  const token = reauthLink.url.split("/reauth/")[1];
  if (!token) throw new Error("Reauthorize link URL has no token");
  return token;
};

const postForm = (path: string, fields: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

// Returns the sign-in flow's state, read from the Claude authorize URL.
const startLink = async (token: string): Promise<string> => {
  const response = await postForm(`/reauth/${token}/start`);
  expect(response.status).toBe(200);
  const state = /[?&;]state=([\w-]+)/u.exec(await response.text())?.[1];
  if (!state) throw new Error("Sign-in page has no authorize URL");
  return state;
};

const completeLink = (token: string, state: string) =>
  postForm(`/reauth/${token}/complete`, { code: `fake-code#${state}` });

test("a link renews its account in place with a one-year sign-in", async () => {
  const key = await insertAccount();
  const token = await shareLink();
  mockTokenResponse(claudeTokens("fake-user-uuid", "fake-org-uuid"));

  const response = await completeLink(token, await startLink(token));

  expect(response.status).toBe(200);
  expect(await db.select().from(providerAccounts)).toHaveLength(1);
  const account = await storedAccount();
  expect(account).toMatchObject({
    label: "Fake Team Seat",
    isPrimary: true,
    accessToken: "fake-new-access",
    refreshToken: null,
    lastRefreshStatus: "success",
  });
  expect(account?.expiresAt).toBeGreaterThan(Date.now() + 300 * 86_400_000);
  expect((await findApiKeyById(db, key.id))?.accountScopes).toEqual([
    ACCOUNT_ID,
  ]);
  expect(
    await db
      .select()
      .from(requestUsageBuckets)
      .where(eq(requestUsageBuckets.providerAccountId, ACCOUNT_ID))
  ).toMatchObject([{ requestCount: 3 }]);
  expect((await app.request(`/reauth/${token}`)).status).toBe(404);
});

test("two racing completions of one link save only one sign-in", async () => {
  await insertAccount();
  const token = await shareLink();
  const { promise: gate, resolve: openGate } =
    Promise.withResolvers<undefined>();
  const arrivals: (() => void)[] = [];
  const arrived = () =>
    new Promise<void>((resolve) => {
      arrivals.push(resolve);
    });
  let exchanges = 0;
  globalThis.fetch = (async () => {
    exchanges += 1;
    const accessToken = `fake-access-${exchanges}`;
    arrivals.shift()?.();
    await gate;
    return Response.json(
      claudeTokens("fake-user-uuid", "fake-org-uuid", YEAR_SECONDS, accessToken)
    );
  }) as unknown as typeof fetch;

  // Each completion holds its own valid sign-in flow when the link is claimed.
  const firstArrived = arrived();
  const first = completeLink(token, await startLink(token));
  await firstArrived;
  const secondArrived = arrived();
  const second = completeLink(token, await startLink(token));
  await secondArrived;
  openGate(undefined);
  const responses = await Promise.all([first, second]);

  const statuses = responses.map((response) => response.status);
  expect(statuses.toSorted((left, right) => left - right)).toEqual([200, 410]);
  const winner = statuses[0] === 200 ? 1 : 2;
  expect((await storedAccount())?.accessToken).toBe(`fake-access-${winner}`);
  expect((await app.request(`/reauth/${token}`)).status).toBe(404);
});

test.each([
  [
    "expired",
    async () => {
      await db.update(reauthLinks).set({ expiresAt: Date.now() - 1 });
    },
  ],
  [
    "revoked",
    async () => {
      const response = await app.request(
        `/admin/accounts/${ACCOUNT_ID}/reauth-link`,
        { method: "DELETE" }
      );
      expect(await response.json()).toEqual({ revoked: true });
    },
  ],
  [
    "replaced",
    async () => {
      await shareLink();
    },
  ],
] as const)("a %s link is rejected", async (_name, invalidate) => {
  await insertAccount();
  const token = await shareLink();
  const state = await startLink(token);
  await invalidate();
  mockTokenResponse(claudeTokens("fake-user-uuid", "fake-org-uuid"));

  expect((await app.request(`/reauth/${token}`)).status).toBe(404);
  expect((await postForm(`/reauth/${token}/start`)).status).toBe(404);
  expect((await completeLink(token, state)).status).toBe(404);
  expect(await storedAccount()).toMatchObject({
    accessToken: "fake-old-access",
    lastRefreshStatus: "reauthorize",
  });
});

test.each([
  [
    "a different Claude user",
    claudeTokens("fake-other-user", "fake-org-uuid"),
    200,
    "different Claude account",
  ],
  [
    "a different organization",
    claudeTokens("fake-user-uuid", "fake-other-org"),
    200,
    "different Claude account",
  ],
  ["a rejected code", { error: "invalid_grant" }, 400, "invalid_grant"],
  [
    "a short sign-in",
    claudeTokens("fake-user-uuid", "fake-org-uuid", 8 * 3600),
    200,
    "instead of one year",
  ],
] as const)(
  "a failed completion from %s keeps the account and the link usable",
  async (_name, tokenResponse, upstreamStatus, message) => {
    await insertAccount();
    const token = await shareLink();
    mockTokenResponse(tokenResponse, upstreamStatus);

    const failed = await completeLink(token, await startLink(token));

    expect(failed.status).toBe(400);
    expect(await failed.text()).toContain(message);
    expect(await storedAccount()).toMatchObject({
      accessToken: "fake-old-access",
      lastRefreshStatus: "reauthorize",
    });

    mockTokenResponse(claudeTokens("fake-user-uuid", "fake-org-uuid"));
    const retried = await completeLink(token, await startLink(token));

    expect(retried.status).toBe(200);
    expect((await storedAccount())?.accessToken).toBe("fake-new-access");
  }
);

test("ten failed completions revoke the link", async () => {
  await insertAccount();
  const token = await shareLink();
  const state = await startLink(token);
  mockTokenResponse({ error: "invalid_grant" }, 400);

  const statuses: number[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    statuses.push((await completeLink(token, state)).status);
  }

  expect(statuses).toEqual([...Array.from({ length: 9 }, () => 400), 410]);
  expect((await app.request(`/reauth/${token}`)).status).toBe(404);
});

test("a link only completes its own sign-in flow", async () => {
  await insertAccount();
  const token = await shareLink();
  await startLink(token);
  const adminStart = await app.request("/admin/accounts/claude/oauth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ options: {} }),
  });
  const { state: adminState } = (await adminStart.json()) as {
    state: string;
  };
  mockTokenResponse(claudeTokens("fake-stranger", "fake-stranger-org"));

  const response = await postForm(`/reauth/${token}/complete`, {
    code: `fake-code#${adminState}`,
    state: adminState,
  });

  expect(response.status).toBe(400);
  expect(await db.select().from(providerAccounts)).toHaveLength(1);
  expect((await storedAccount())?.accessToken).toBe("fake-old-access");
  const adminComplete = await app.request(
    "/admin/accounts/claude/oauth/complete",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: adminState, code: "fake-code" }),
    }
  );
  expect(adminComplete.status).toBe(200);
});

test.each([["Fake Team Seat"], ["fake-owner@example.com"]])(
  "the public pages for an account labelled %s reveal no account details",
  async (label) => {
    await insertAccount(label);
    const token = await shareLink();

    const pages = [
      await (await app.request(`/reauth/${token}`)).text(),
      await (await postForm(`/reauth/${token}/start`)).text(),
    ];

    for (const page of pages) {
      for (const secret of [
        "fake-owner@example.com",
        "fake-user-uuid",
        "fake-org-uuid",
        "fake-old-access",
        ACCOUNT_ID,
      ]) {
        expect(page).not.toContain(secret);
      }
    }
    if (label === "Fake Team Seat") {
      expect(pages[0]).toContain(label);
    }
  }
);

test("a link can't be shared or completed without the account's Claude user and organization", async () => {
  await insertAccount();
  const token = await shareLink();
  const state = await startLink(token);
  await db
    .update(providerAccounts)
    .set({ metadataJson: JSON.stringify({ provider: "claude", scope: null }) });
  mockTokenResponse(claudeTokens("fake-stranger", "fake-stranger-org"));

  await completeLink(token, state);

  expect((await storedAccount())?.accessToken).toBe("fake-old-access");
  const share = await app.request(`/admin/accounts/${ACCOUNT_ID}/reauth-link`, {
    method: "POST",
  });
  expect(share.status).toBe(400);
});

test("a saved sign-in uses up its link even when reading the account back fails", async () => {
  await insertAccount();
  const token = await shareLink();
  const state = await startLink(token);
  mockTokenResponse(claudeTokens("fake-user-uuid", "fake-org-uuid"));
  beforeAccountReadAfterExchange(2, () =>
    Promise.reject(new Error("fake read failure"))
  );

  await completeLink(token, state);

  expect((await storedAccount())?.accessToken).toBe("fake-new-access");
  expect((await app.request(`/reauth/${token}`)).status).toBe(404);
});

test("a link superseded during a failed completion stays revoked", async () => {
  await insertAccount();
  const token = await shareLink();
  const state = await startLink(token);
  mockTokenResponse(claudeTokens("fake-other-user", "fake-org-uuid"));
  beforeAccountReadAfterExchange(1, async () => {
    await shareLink();
    await app.request(`/admin/accounts/${ACCOUNT_ID}/reauth-link`, {
      method: "DELETE",
    });
  });

  await completeLink(token, state);

  expect((await app.request(`/reauth/${token}`)).status).toBe(404);
});

test("concurrent starts leave one sign-in flow and no expired ones", async () => {
  await insertAccount();
  const token = await shareLink();
  await db.insert(oauthStates).values({
    state: "fake-expired-state",
    provider: "claude",
    expiresAt: Date.now() - 1,
  });

  await Promise.all(
    Array.from({ length: 20 }, async () => postForm(`/reauth/${token}/start`))
  );

  const [link] = await db.select().from(reauthLinks);
  const states = await db.select().from(oauthStates);
  expect(states.map((row) => row.state)).toEqual([link?.oauthState]);
});
