import { beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";

// Run through owners.test.ts, which starts this file in its own process
// with a throwaway database.
if (
  !process.env.TURSO_CONNECTION_URL?.startsWith("file:") ||
  process.env.TURSO_AUTH_TOKEN
) {
  throw new Error("owner scenarios need a throwaway database");
}
const { db } = await import("../../src/db");
const { createApiKey, listApiKeys } =
  await import("../../src/db/repositories/api-keys");
const { findOAuthState } =
  await import("../../src/db/repositories/oauth-states");
const { listProviderAccounts, upsertProviderAccount } =
  await import("../../src/db/repositories/provider-accounts");
const { providerAccounts } = await import("../../src/db/schema");
const { refreshProviderAccount, startProviderOAuth } =
  await import("../../src/domain/providers/provider-service");
const { claudeAdapter } = await import("../../src/providers/claude");
const { requireDelegateApiKey } =
  await import("../../src/http/middleware/api-key-auth");
const { createLinkRoutes } = await import("../../src/http/routes/link");
const { createOwnerRoutes } = await import("../../src/http/routes/owners");
const { requireProxyApiKey } =
  await import("../../src/http/middleware/api-key-auth");
const { proxyRoutes, flushProxyUsage } =
  await import("../../src/http/routes/proxy");
const { modelsRoutes } = await import("../../src/http/routes/models");
const { grants } = await import("../../src/db/schema");
const { getDashboardUsage } =
  await import("../../src/db/repositories/dashboard-usage");

const app = new Hono();
app.use("/api/links", requireDelegateApiKey);
app.use("/api/owners/*", requireDelegateApiKey);
app.use("/api/grants", requireDelegateApiKey);
app.use("/api/grants/*", requireDelegateApiKey);
app.route("/api", createOwnerRoutes(db));
app.route("/", createLinkRoutes(db));
app.use("/anthropic/v1/*", requireProxyApiKey);
app.route("/", proxyRoutes);
app.route("/", modelsRoutes);

let delegateKey: string;
let otherDelegateKey: string;
let claudeOnlyKey: string;
let plainKey: string;
beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
  delegateKey = (await createApiKey(db, { delegate: true }, Date.now())).key;
  otherDelegateKey = (await createApiKey(db, { delegate: true }, Date.now()))
    .key;
  claudeOnlyKey = (
    await createApiKey(
      db,
      { delegate: true, providerScopes: ["claude"] },
      Date.now()
    )
  ).key;
  plainKey = (await createApiKey(db, {}, Date.now())).key;
  await upsertProviderAccount(db, {
    provider: "claude",
    accountId: "shared-claude",
    accessToken: "shared-access",
    refreshToken: "shared-refresh",
    expiresAt: Date.now() + 3_600_000,
    metadata: null,
    now: Date.now(),
  });
});

const call = (
  method: string,
  path: string,
  body?: unknown,
  key = delegateKey
) =>
  app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const createLink = async (owner: string, provider = "claude") => {
  const response = await call("POST", "/api/links", {
    owner,
    label: `${owner} label`,
    provider,
  });
  expect(response.status).toBe(201);
  const { url } = (await response.json()) as { url: string };
  return new URL(url).pathname;
};

const start = (linkPath: string) =>
  app.request(`${linkPath}/start`, { method: "POST" });

const jwt = (claims: unknown) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

const claudeIdentity = (account: string) => ({
  account: { uuid: account },
  organization: { uuid: "fake-org" },
});

const codexToken = (workspace: string, user: string) =>
  jwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: workspace,
      chatgpt_user_id: user,
    },
  });

// Signs in through a link with a mocked provider token response.
const link = async (
  linkPath: string,
  accessToken: string,
  identity: Record<string, unknown> = {}
) => {
  const started = await start(linkPath);
  expect(started.status).toBe(200);
  const { provider, state } = (await started.json()) as {
    provider: string;
    state: string;
  };
  const upstream = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      access_token: accessToken,
      refresh_token: `refresh-${accessToken}`,
      expires_in: 3600,
      ...identity,
    })
  );
  try {
    return await app.request("/link/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, state, code: "fake-code" }),
    });
  } finally {
    upstream.mockRestore();
  }
};

test("only delegate keys can create links or read and unlink owners", async () => {
  for (const [method, path] of [
    ["POST", "/api/links"],
    ["GET", "/api/owners/alice"],
    ["GET", "/api/owners/alice/limits"],
    ["DELETE", "/api/owners/alice/accounts/any"],
    ["POST", "/api/grants"],
    ["GET", "/api/grants"],
    ["DELETE", `/api/grants/${crypto.randomUUID()}`],
  ] as const) {
    const body =
      method === "POST"
        ? path === "/api/links"
          ? { owner: "alice", label: "Alice", provider: "claude" }
          : { owner: "alice", ttl: 60 }
        : undefined;
    expect((await call(method, path, body, plainKey)).status).toBe(403);
  }
});

test("a link starts one sign-in and expires", async () => {
  const used = await createLink("alice");
  expect((await start(used)).status).toBe(200);
  expect((await start(used)).status).toBe(404);

  const expired = await createLink("alice");
  setSystemTime(Date.now() + 16 * 60_000);
  try {
    expect((await start(expired)).status).toBe(404);
  } finally {
    setSystemTime();
  }
});

test("a completed link creates an account for its owner only", async () => {
  const response = await link(await createLink("carol"), "carol-access");
  expect(await response.json()).toEqual({ linked: true });

  const accounts = await listProviderAccounts(db);
  const carol = accounts.find((account) => account.ownerId === "carol");
  expect(carol).toMatchObject({
    accessToken: "carol-access",
    ownerLabel: "carol label",
    isPrimary: false,
  });
});

const ownerIds = async (provider: string) =>
  (await listProviderAccounts(db))
    .flatMap((account) =>
      account.provider === provider && account.ownerId ? [account.ownerId] : []
    )
    .sort((left, right) => left.localeCompare(right));

test("a Claude subscription belongs to one owner, and relinking replaces its credentials", async () => {
  const subscription = claudeIdentity("claude-user-1");
  for (const [owner, token, status] of [
    ["gus", "gus-access", 200],
    ["gus", "gus-access-2", 200],
    ["hank", "hank-access", 409],
  ] as const) {
    expect(
      (await link(await createLink(owner), token, subscription)).status
    ).toBe(status);
  }
  const gus = (await listProviderAccounts(db)).filter(
    (account) => account.ownerId === "gus"
  );
  expect(gus.map((account) => account.accessToken)).toEqual(["gus-access-2"]);
  expect(await ownerIds("claude")).not.toContain("hank");

  await upsertProviderAccount(db, {
    provider: "claude",
    accountId: null,
    accessToken: "shared-claude-access",
    refreshToken: "shared-claude-refresh",
    expiresAt: Date.now() + 3_600_000,
    metadata: {
      provider: "claude",
      scope: null,
      oauthMode: "max",
      oauthHost: "claude.ai",
      accountUuid: "claude-shared",
      organizationUuid: "fake-org",
    },
    now: Date.now(),
  });
  expect(
    (
      await link(
        await createLink("ivy"),
        "ivy-access",
        claudeIdentity("claude-shared")
      )
    ).status
  ).toBe(409);
});

test("members of one Codex workspace each link their own credential", async () => {
  for (const [owner, user, status] of [
    ["jack", "user-1", 200],
    ["kate", "user-2", 200],
    ["liam", "user-1", 409],
  ] as const) {
    expect(
      (
        await link(
          await createLink(owner, "codex"),
          codexToken("team-workspace", user)
        )
      ).status
    ).toBe(status);
  }
  expect(await ownerIds("codex")).toEqual(
    expect.arrayContaining(["jack", "kate"])
  );
  expect(await ownerIds("codex")).not.toContain("liam");
});

test("a delegate key reads, links and unlinks only its providers' accounts", async () => {
  expect(
    (
      await link(
        await createLink("mona", "codex"),
        codexToken("mona-workspace", "mona")
      )
    ).status
  ).toBe(200);
  const [codex] = (await listProviderAccounts(db)).filter(
    (account) => account.ownerId === "mona"
  );
  for (const path of ["/api/owners/mona", "/api/owners/mona/limits"]) {
    const body = (await (
      await call("GET", path, undefined, claudeOnlyKey)
    ).json()) as { accounts: unknown[] };
    expect(body.accounts).toEqual([]);
  }
  expect(
    (
      await call(
        "POST",
        "/api/links",
        { owner: "mona", label: "Mona", provider: "codex" },
        claudeOnlyKey
      )
    ).status
  ).toBe(403);
  expect(
    (
      await call(
        "DELETE",
        `/api/owners/mona/accounts/${codex?.id}`,
        undefined,
        claudeOnlyKey
      )
    ).status
  ).toBe(404);
  expect(await ownerIds("codex")).toContain("mona");
});

test("the public completion step never finishes an admin's sign-in", async () => {
  const admin = await startProviderOAuth(
    db,
    "claude",
    { options: { mode: "max" } },
    Date.now()
  );
  const upstream = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected upstream request")
  );
  const response = await app.request("/link/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: "claude",
      state: admin.state,
      code: "fake-code",
    }),
  });
  upstream.mockRestore();
  expect(response.status).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
  expect(
    await findOAuthState(db, admin.state, "claude", Date.now())
  ).not.toBeNull();
});

test("unlinking removes the owner's tokens and only the owner's account", async () => {
  expect((await link(await createLink("erin"), "erin-access")).status).toBe(
    200
  );
  const owned = await call("GET", "/api/owners/erin");
  const body = await owned.text();
  expect(body).not.toContain("erin-access");
  const [account] = (JSON.parse(body) as { accounts: { id: string }[] })
    .accounts;
  if (!account) throw new Error("Linked account missing");

  expect(
    (await call("DELETE", `/api/owners/frank/accounts/${account.id}`)).status
  ).toBe(404);
  expect(
    (await call("DELETE", `/api/owners/erin/accounts/${account.id}`)).status
  ).toBe(200);
  expect(
    (await db.select().from(providerAccounts)).some(
      (row) =>
        row.accessToken === "erin-access" ||
        row.refreshToken === "refresh-erin-access"
    )
  ).toBe(false);
});

test("a refresh racing an unlink can't write the credentials back", async () => {
  expect((await link(await createLink("nora"), "nora-access")).status).toBe(
    200
  );
  const [account] = (await listProviderAccounts(db)).filter(
    (row) => row.ownerId === "nora"
  );
  if (!account) throw new Error("Linked account missing");
  const original = claudeAdapter.refreshAccount;
  const { promise: unlinked, resolve: unlinkDone } =
    Promise.withResolvers<undefined>();
  const { promise: refreshing, resolve: refreshStarted } =
    Promise.withResolvers<undefined>();
  claudeAdapter.refreshAccount = async () => {
    refreshStarted(undefined);
    await unlinked;
    return {
      accessToken: "nora-refreshed",
      refreshToken: "nora-refreshed-refresh",
      expiresAt: Date.now() + 3_600_000,
      accountId: null,
      metadata: null,
    };
  };
  try {
    const refresh = refreshProviderAccount(db, account.id, Date.now(), {
      force: true,
    });
    await refreshing;
    expect(
      (await call("DELETE", `/api/owners/nora/accounts/${account.id}`)).status
    ).toBe(200);
    unlinkDone(undefined);
    expect(await refresh.catch(() => null)).toBeNull();
  } finally {
    claudeAdapter.refreshAccount = original;
  }
  const rows = await db.select().from(providerAccounts);
  expect(rows.some((row) => row.accessToken.startsWith("nora-refreshed"))).toBe(
    false
  );
  expect(await ownerIds("claude")).not.toContain("nora");
});
const liveGrantIds = async (key = delegateKey) =>
  (
    (await (await call("GET", "/api/grants", undefined, key)).json()) as {
      grants: { id: string }[];
    }
  ).grants.map((grant) => grant.id);

const grant = async (owner: string, ttl: number, key = delegateKey) =>
  call("POST", "/api/grants", { owner, ttl, purpose: "review" }, key);

test("a grant is live only from creation until it expires or is revoked", async () => {
  expect((await grant("nobody", 60)).status).toBe(404);
  expect((await grant("grace", 8 * 60 * 60 + 1)).status).toBe(400);
  expect((await link(await createLink("grace"), "grace-access")).status).toBe(
    200
  );

  const created = await grant("grace", 60);
  expect(created.status).toBe(201);
  const { grant: live } = (await created.json()) as { grant: { id: string } };
  const expiring = (
    (await (await grant("grace", 60)).json()) as { grant: { id: string } }
  ).grant;
  expect(await liveGrantIds()).toEqual(
    expect.arrayContaining([live.id, expiring.id])
  );

  expect((await call("DELETE", `/api/grants/${live.id}`)).status).toBe(200);
  expect(await liveGrantIds()).not.toContain(live.id);
  setSystemTime(Date.now() + 61_000);
  try {
    expect(await liveGrantIds()).not.toContain(expiring.id);
  } finally {
    setSystemTime();
  }
});

test("a key can't read or revoke another key's grants", async () => {
  expect((await link(await createLink("heidi"), "heidi-access")).status).toBe(
    200
  );
  const { grant: theirs } = (await (
    await grant("heidi", 600, otherDelegateKey)
  ).json()) as { grant: { id: string } };

  expect(await liveGrantIds()).not.toContain(theirs.id);
  expect((await call("DELETE", `/api/grants/${theirs.id}`)).status).toBe(404);
  expect(await liveGrantIds(otherDelegateKey)).toContain(theirs.id);
});

// Sends a Claude request and returns its status, error type and the access
// token the upstream saw, if it was called at all.
const proxy = async (model: string, key = delegateKey) => {
  const seen: { authorization: string | null; model: unknown }[] = [];
  const upstream = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: unknown,
    init?: RequestInit
  ) => {
    seen.push({
      authorization: new Headers(init?.headers).get("authorization"),
      model: (JSON.parse(String(init?.body)) as { model: unknown }).model,
    });
    return Response.json({
      type: "message",
      content: [],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }) as typeof fetch);
  try {
    const response = await call(
      "POST",
      "/anthropic/v1/messages",
      { model, max_tokens: 1, messages: [] },
      key
    );
    const body = (await response.json()) as {
      error?: string | { type: string };
    };
    return {
      status: response.status,
      error: typeof body.error === "object" ? body.error.type : body.error,
      upstream: seen,
    };
  } finally {
    upstream.mockRestore();
    await flushProxyUsage();
  }
};

test("plain model names keep routing to the shared account for every key", async () => {
  expect((await link(await createLink("ivy"), "ivy-access")).status).toBe(200);
  for (const key of [delegateKey, plainKey]) {
    expect((await proxy("claude-fake", key)).upstream).toEqual([
      { authorization: "Bearer shared-access", model: "claude-fake" },
    ]);
  }
  expect((await proxy("claude-fake@ivy", plainKey)).upstream).toEqual([
    { authorization: "Bearer shared-access", model: "claude-fake@ivy" },
  ]);
});

test("a per-owner model name reaches only that owner's account and only under a grant", async () => {
  expect((await link(await createLink("ivan"), "ivan-access")).status).toBe(
    200
  );
  expect(await proxy("claude-fake@ivan")).toMatchObject({
    status: 403,
    error: "grant_missing",
    upstream: [],
  });

  const { grant: live } = (await (await grant("ivan", 600)).json()) as {
    grant: { id: string };
  };
  expect(await proxy("anthropic/claude-fake@ivan")).toMatchObject({
    status: 200,
    upstream: [{ authorization: "Bearer ivan-access", model: "claude-fake" }],
  });
  expect(await proxy("claude-fake@ivan", otherDelegateKey)).toMatchObject({
    status: 403,
    error: "grant_missing",
    upstream: [],
  });

  const [account] = (
    (await (await call("GET", "/api/owners/ivan")).json()) as {
      accounts: { id: string }[];
    }
  ).accounts;
  await call("DELETE", `/api/owners/ivan/accounts/${account?.id}`);
  expect(await proxy("claude-fake@ivan")).toMatchObject({
    status: 400,
    upstream: [],
  });

  await call("DELETE", `/api/grants/${live.id}`);
  expect(await proxy("claude-fake@ivan")).toMatchObject({
    status: 403,
    error: "grant_missing",
    upstream: [],
  });
});

test("only delegate keys discover per-owner model names", async () => {
  expect((await link(await createLink("judy"), "judy-access")).status).toBe(
    200
  );
  const discover = async (key: string) => {
    const [apiKey] = (await listApiKeys(db)).filter((row) => row.key === key);
    const upstream = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        anthropic: { models: { "claude-fake": { name: "Claude Fake" } } },
      })
    );
    try {
      const response = await app.request(
        `/api/${apiKey?.modelsDiscoveryToken}/api.json`
      );
      const registry = (await response.json()) as {
        kleis: { models: Record<string, { name: string }> };
      };
      return Object.keys(registry.kleis.models).sort();
    } finally {
      upstream.mockRestore();
    }
  };
  expect(await discover(plainKey)).toEqual(["anthropic/claude-fake"]);
  const delegated = await discover(delegateKey);
  expect(delegated).toEqual(
    expect.arrayContaining([
      "anthropic/claude-fake",
      "anthropic/claude-fake@judy",
    ])
  );
});

const ownedAccountId = async (owner: string) => {
  const [account] = (await listProviderAccounts(db)).filter(
    (row) => row.ownerId === owner
  );
  if (!account) throw new Error("Linked account missing");
  return account.id;
};

test("a revoke or an unlink made by another process applies to the next owner request", async () => {
  expect((await link(await createLink("omar"), "omar-access")).status).toBe(
    200
  );
  expect((await grant("omar", 600)).status).toBe(201);
  expect((await proxy("claude-fake@omar")).status).toBe(200);

  // Writes from another process don't clear this process's lookups.
  await db.update(grants).set({ revokedAt: Date.now() });
  expect(await proxy("claude-fake@omar")).toMatchObject({
    status: 403,
    error: "grant_missing",
    upstream: [],
  });

  expect((await grant("omar", 600)).status).toBe(201);
  expect((await proxy("claude-fake@omar")).status).toBe(200);
  await db
    .update(providerAccounts)
    .set({ accessToken: "", enabled: false, unlinkedAt: Date.now() })
    .where(eq(providerAccounts.id, await ownedAccountId("omar")));
  expect(await proxy("claude-fake@omar")).toMatchObject({
    status: 400,
    upstream: [],
  });
});

test("an owner request checks its grant again right before it goes upstream", async () => {
  expect((await link(await createLink("pia"), "pia-access")).status).toBe(200);
  expect((await grant("pia", 600)).status).toBe(201);
  await db
    .update(providerAccounts)
    .set({ expiresAt: Date.now() - 1000 })
    .where(eq(providerAccounts.id, await ownedAccountId("pia")));
  const original = claudeAdapter.refreshAccount;
  claudeAdapter.refreshAccount = async () => {
    await db.update(grants).set({ revokedAt: Date.now() });
    return {
      accessToken: "pia-refreshed",
      refreshToken: "pia-refreshed-refresh",
      expiresAt: Date.now() + 3_600_000,
      accountId: null,
      metadata: null,
    };
  };
  try {
    expect(await proxy("claude-fake@pia")).toMatchObject({
      status: 403,
      upstream: [],
    });
  } finally {
    claudeAdapter.refreshAccount = original;
  }
});

test("usage stays attributed to an owner after they unlink", async () => {
  expect((await link(await createLink("quinn"), "quinn-access")).status).toBe(
    200
  );
  expect((await grant("quinn", 600)).status).toBe(201);
  expect((await proxy("claude-fake@quinn")).status).toBe(200);
  const accountId = await ownedAccountId("quinn");
  expect(
    (await call("DELETE", `/api/owners/quinn/accounts/${accountId}`)).status
  ).toBe(200);
  const usage = await getDashboardUsage(
    db,
    Date.now() - 3_600_000,
    3_600_000,
    "quinn"
  );
  expect(usage.totals.requestCount).toBe(1);
});
