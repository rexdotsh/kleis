import { beforeAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";

// Run through owners.test.ts, which starts this file in its own process
// with an in-memory database.
if (
  process.env.TURSO_CONNECTION_URL !== ":memory:" ||
  process.env.TURSO_AUTH_TOKEN
) {
  throw new Error("owner scenarios need an in-memory database");
}
const { db } = await import("../../src/db");
const { createApiKey } = await import("../../src/db/repositories/api-keys");
const { findOAuthState } =
  await import("../../src/db/repositories/oauth-states");
const { listProviderAccounts } =
  await import("../../src/db/repositories/provider-accounts");
const { getRoutableProviderAccount, startProviderOAuth } =
  await import("../../src/domain/providers/provider-service");
const { requireDelegateApiKey } =
  await import("../../src/http/middleware/api-key-auth");
const { createLinkRoutes } = await import("../../src/http/routes/link");
const { createOwnerRoutes } = await import("../../src/http/routes/owners");

const app = new Hono();
app.use("/api/links", requireDelegateApiKey);
app.use("/api/owners/*", requireDelegateApiKey);
app.route("/api", createOwnerRoutes(db));
app.route("/", createLinkRoutes(db));

let delegateKey: string;
let plainKey: string;
beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
  delegateKey = (await createApiKey(db, { delegate: true }, Date.now())).key;
  plainKey = (await createApiKey(db, {}, Date.now())).key;
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

// Signs in through a link with a mocked provider token response.
const link = async (linkPath: string, accessToken: string) => {
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
  ] as const) {
    const body =
      method === "POST"
        ? { owner: "alice", label: "Alice", provider: "claude" }
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

  const codexToken = jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "shared-workspace" },
  });
  expect(
    (await link(await createLink("carol", "codex"), codexToken)).status
  ).toBe(200);
  const rebind = await link(await createLink("dave", "codex"), codexToken);
  expect(rebind.status).toBe(409);
  expect(
    (await listProviderAccounts(db))
      .filter((account) => account.provider === "codex")
      .map((account) => account.ownerId)
  ).toEqual(["carol"]);
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
    (await listProviderAccounts(db)).some(
      (row) =>
        row.accessToken === "erin-access" ||
        row.refreshToken === "refresh-erin-access"
    )
  ).toBe(false);
  expect(
    await getRoutableProviderAccount(db, "claude", Date.now(), {
      ownerId: "erin",
    })
  ).toBeNull();
});
