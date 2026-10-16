import { createClient } from "@libsql/client";
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";

if (
  process.env.TURSO_CONNECTION_URL !== "file::memory:?cache=shared" ||
  process.env.TURSO_AUTH_TOKEN ||
  process.env.ADMIN_TOKEN !== "fake-owner-token"
) {
  throw new Error(
    "Admin scenarios require an isolated in-memory database and fake admin token"
  );
}
const anchor = createClient({ url: "file::memory:?cache=shared" });
const { db } = await import("../../src/db");
const { adminAccountsRoutes } =
  await import("../../src/http/routes/admin-accounts");
const { adminKeysRoutes } = await import("../../src/http/routes/admin-keys");
const { requireAdminAuth } =
  await import("../../src/http/middleware/bearer-env-auth");
const { installErrorHandler } = await import("../../src/http/error-handler");
const { createApiKey, findApiKeyById, listApiKeys } =
  await import("../../src/db/repositories/api-keys");
const { upsertProviderAccount } =
  await import("../../src/db/repositories/provider-accounts");
const { saveCodexResetCreditRedemption } =
  await import("../../src/db/repositories/codex-reset-redemptions");

const app = new Hono();
installErrorHandler(app);
app.use("/admin/*", requireAdminAuth);
app.route("/admin/keys", adminKeysRoutes);
app.route("/admin/accounts", adminAccountsRoutes);

const originalFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = (() => {
    throw new Error("Unexpected upstream request");
  }) as typeof fetch;
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
});
afterEach(() => {
  globalThis.fetch = (() => {
    throw new Error("Unexpected upstream request");
  }) as typeof fetch;
});
afterAll(() => {
  db.$client.close();
  anchor.close();
  globalThis.fetch = originalFetch;
});

const request = (
  path: string,
  method = "GET",
  body?: unknown,
  token = "fake-owner-token"
) =>
  app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

test("admin secrets require the static owner bearer and sensitive responses cannot be cached", async () => {
  const key = await createApiKey(db, { label: "fake-device" }, Date.now());
  for (const token of ["", "wrong-token", key.key]) {
    for (const path of ["/admin/keys", "/admin/accounts"]) {
      const response = await request(path, "GET", undefined, token);
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain(key.key);
    }
  }
  const response = await request("/admin/keys");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(
    body.keys.find((item: { id: string }) => item.id === key.id)?.key
  ).toBe(key.key);
});

test("account import, list and update never return OAuth credentials or unrecognized metadata", async () => {
  const accessToken = "fake-sensitive-access-token";
  const refreshToken = "fake-sensitive-refresh-token";
  const imported = await request("/admin/accounts/codex/import", "POST", {
    accountId: "fake-import-identity",
    accessToken,
    refreshToken,
    expiresAt: Date.now() + 3_600_000,
    metadata: { accessToken, refreshToken },
  });
  expect(imported.status).toBe(200);
  const importedBody = await imported.json();
  const updated = await request(
    `/admin/accounts/${importedBody.account.id}`,
    "PATCH",
    {
      label: "fake-label",
      metadata: { accessToken, refreshToken },
    }
  );
  expect(updated.status).toBe(200);
  for (const body of [
    JSON.stringify(importedBody),
    await updated.text(),
    await (await request("/admin/accounts")).text(),
  ]) {
    expect(body).not.toContain(accessToken);
    expect(body).not.toContain(refreshToken);
    expect(body).not.toContain('"accessToken"');
    expect(body).not.toContain('"refreshToken"');
  }
});

test("rotation is single-successor over HTTP and refuses a revoked source", async () => {
  const source = await createApiKey(db, {}, Date.now());
  const rotate = () =>
    request(`/admin/keys/${source.id}/rotate`, "POST", { revokeOld: true });
  const responses = await Promise.all([rotate(), rotate()]);
  expect(
    responses.map((response) => response.status).sort((a, b) => a - b)
  ).toEqual([201, 409]);
  const success = responses.find((response) => response.status === 201);
  if (!success) throw new Error("Expected a successful rotation");
  const replacement = (await success.json()).key;
  expect((await findApiKeyById(db, source.id))?.revokedAt).not.toBeNull();
  expect((await findApiKeyById(db, replacement.id))?.revokedAt).toBeNull();
  const revoked = await createApiKey(db, {}, Date.now());
  await request(`/admin/keys/${revoked.id}/revoke`, "POST");
  const before = (await listApiKeys(db)).length;
  expect(
    (
      await request(`/admin/keys/${revoked.id}/rotate`, "POST", {
        revokeOld: true,
      })
    ).status
  ).toBe(409);
  expect(await listApiKeys(db)).toHaveLength(before);
});

test("a competing Codex redemption returns the original ID and an actionable conflict without spending", async () => {
  const now = Date.now();
  const account = await upsertProviderAccount(db, {
    provider: "codex",
    accountId: "fake-reset-identity",
    accessToken: "fake-access",
    refreshToken: "fake-refresh",
    expiresAt: now + 3_600_000,
    metadata: null,
    now,
  });
  await saveCodexResetCreditRedemption(db, {
    providerAccountId: account.id,
    redeemRequestId: "original-request",
    creditId: null,
    status: "retryable",
    createdAt: now,
    updatedAt: now,
  });
  const response = await request(
    `/admin/accounts/${account.id}/tracking/codex/reset-credits/consume`,
    "POST",
    {
      redeemRequestId: "competing-request",
    }
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: "conflict",
    redeemRequestId: "original-request",
    message: expect.stringContaining("Retry only that original request"),
  });
});

test("Codex offers require confirmation and an owner can check a lost C1 result after only C2 remains", async () => {
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const account = await upsertProviderAccount(db, {
      provider: "codex",
      accountId: "fake-confirmed-credit-identity",
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: now + 3_600_000,
      metadata: null,
      now,
    });
    const path = `/admin/accounts/${account.id}/tracking/codex/reset-credits/consume`;
    const consumes: unknown[] = [];
    globalThis.fetch = (async (_url, init) => {
      if (!init?.body)
        return Response.json({
          available_count: consumes.length ? 1 : 2,
          credits: (consumes.length ? ["C2"] : ["C1", "C2"]).map((id) => ({
            id,
            status: "available",
          })),
        });
      consumes.push(JSON.parse(String(init.body)));
      if (consumes.length === 1)
        throw new Error("Lost response after C1 was spent");
      return Response.json({ code: "already_redeemed" });
    }) as typeof fetch;
    const unconfirmed = await request(path, "POST", {
      redeemRequestId: "unconfirmed",
    });
    expect(unconfirmed.status).toBe(409);
    expect(await unconfirmed.json()).toMatchObject({
      redeemRequestId: null,
      retryable: false,
    });
    const initial = (await (await request("/admin/accounts/quotas")).json())
      .quotas[account.id].data.resetCreditAction;
    expect(initial.kind).toBe("offer");
    const lost = await request(path, "POST", {
      creditId: initial.creditId,
      offerKey: initial.offerKey,
      redeemRequestId: "R1",
    });
    expect(lost.status).toBe(502);
    const pending = (await (await request("/admin/accounts/quotas")).json())
      .quotas[account.id].data;
    expect(
      pending.resetCredits.credits.map((credit: { id: string }) => credit.id)
    ).toEqual(["C2"]);
    expect(pending.resetCreditAction).toMatchObject({
      kind: "pending",
      redeemRequestId: "R1",
      creditId: "C1",
    });
    clock.mockReturnValue(now + 120_001);
    await request(path, "POST", { redeemRequestId: "R1" });
    await request("/admin/accounts/quotas");
    const replay = await request(path, "POST", {
      redeemRequestId: "R1",
      creditId: "C2",
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      result: { redeemRequestId: "R1", code: "already_redeemed" },
    });
    expect(consumes).toEqual([{ redeem_request_id: "R1", credit_id: "C1" }]);
  } finally {
    clock.mockRestore();
  }
});

test("the HTTP API exposes fresh recovery warnings and blocks unverified legacy identity deletion with an owner-facing conflict", async () => {
  const now = Date.now();
  const account = await upsertProviderAccount(db, {
    provider: "codex",
    accountId: "fake-round-three-identity",
    accessToken: "fake-access",
    refreshToken: "fake-refresh",
    expiresAt: now + 3_600_000,
    metadata: null,
    now,
  });
  let percent = 100;
  let posts = 0;
  globalThis.fetch = (async (url, init) => {
    if (init?.body) {
      posts++;
      return posts === 1
        ? Response.json({}, { status: 503 })
        : Response.json({ code: "reset" });
    }
    if (String(url).endsWith("/usage"))
      return Response.json({
        rate_limit: {
          primary_window: {
            used_percent: percent,
            limit_window_seconds: 18000,
          },
        },
      });
    return Response.json({
      available_count: 1,
      credits: [{ id: "C1", status: "available" }],
    });
  }) as typeof fetch;
  const path = `/admin/accounts/${account.id}/tracking/codex/reset-credits/consume`;
  const action = (await (await request("/admin/accounts/quotas")).json())
    .quotas[account.id].data.resetCreditAction;
  expect(
    (
      await request(path, "POST", {
        redeemRequestId: "round-three-R1",
        creditId: action.creditId,
        offerKey: action.offerKey,
      })
    ).status
  ).toBe(502);
  percent = 10;
  const current = (await (await request("/admin/accounts/quotas")).json())
    .quotas[account.id].data.resetCreditAction;
  const refused = await request(path, "POST", {
    redeemRequestId: "round-three-R1",
  });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    redeemRequestId: "round-three-R1",
    retryable: true,
  });
  expect(posts).toBe(1);
  expect(current.recovery).toMatchObject({
    mode: "spend",
    earlyUse: { percentUsed: 10 },
  });
  expect(
    (
      await request(path, "POST", {
        redeemRequestId: "round-three-R1",
        offerKey: current.recovery.offerKey,
      })
    ).status
  ).toBe(200);
  expect(posts).toBe(2);
  const legacy = await upsertProviderAccount(db, {
    provider: "codex",
    accountId: null,
    accessToken: "fake-access",
    refreshToken: "fake-refresh",
    expiresAt: now + 3_600_000,
    metadata: null,
    now,
  });
  await saveCodexResetCreditRedemption(db, {
    redeemRequestId: "unverified-HTTP-R1",
    providerAccountId: legacy.id,
    creditId: null,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  try {
    const deletion = await request(`/admin/accounts/${legacy.id}`, "DELETE");
    expect(deletion.status).toBe(409);
    expect(await deletion.json()).toMatchObject({
      error: "conflict",
      message: expect.stringContaining("Reauthorize this same account"),
    });
  } finally {
    const { codexResetCreditRedemptions } = await import("../../src/db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .delete(codexResetCreditRedemptions)
      .where(
        eq(codexResetCreditRedemptions.redeemRequestId, "unverified-HTTP-R1")
      );
  }
});
