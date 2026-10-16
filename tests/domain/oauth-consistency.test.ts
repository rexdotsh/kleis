import { createClient } from "@libsql/client";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { Database } from "../../src/db";
import { findProviderAccountById } from "../../src/db/repositories/provider-accounts";
import * as schema from "../../src/db/schema";
import {
  completeProviderOAuth,
  refreshProviderAccount,
  refreshProviderAccountAfterAuthFailure,
  startProviderOAuth,
} from "../../src/domain/providers/provider-service";

const originalFetch = globalThis.fetch;
let client: ReturnType<typeof createClient>;
let database: Database;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  client.close();
});

test("Claude reauthorization rejects a different or unverified known user/organization", async () => {
  const id = crypto.randomUUID();
  const metadata = {
    provider: "claude",
    oauthMode: "max",
    oauthHost: "claude.ai",
    accountUuid: "user-a",
    organizationUuid: "org-a",
  };
  const now = Date.now();
  await database.insert(schema.providerAccounts).values({
    id,
    provider: "claude",
    label: "Selected account",
    isPrimary: true,
    enabled: false,
    accessToken: "selected-access",
    refreshToken: "selected-refresh",
    expiresAt: now + 3_600_000,
    metadataJson: JSON.stringify(metadata),
    createdAt: now,
    updatedAt: now,
  });
  await database.insert(schema.apiKeys).values({
    id: "pinned-key",
    key: "kleis_fake_pinned_key",
    accountScopeJson: JSON.stringify([id]),
    createdAt: now,
  });

  for (const variant of [
    { account: { uuid: "user-b" }, organization: { uuid: "org-a" } },
    { account: { uuid: "user-a" }, organization: { uuid: "org-b" } },
    { account: { uuid: "user-a" } },
    {},
    { legacy: true, account: { uuid: "user-b" } },
  ]) {
    await database
      .update(schema.providerAccounts)
      .set({
        accountId: variant.legacy ? "user-a" : null,
        metadataJson: variant.legacy ? null : JSON.stringify(metadata),
      })
      .where(eq(schema.providerAccounts.id, id));
    const before = await findProviderAccountById(database, id);
    const started = await startProviderOAuth(
      database,
      "claude",
      { options: { replaceAccountId: id } },
      Date.now()
    );
    globalThis.fetch = (async () =>
      Response.json({
        access_token: "different-access",
        refresh_token: "different-refresh",
        expires_in: 3600,
        ...variant,
      })) as typeof fetch;

    await expect(
      completeProviderOAuth(
        database,
        "claude",
        { state: started.state, code: "auth-code" },
        Date.now()
      )
    ).rejects.toThrow("identity does not match the selected account");
    expect(await findProviderAccountById(database, id)).toEqual(before);
    expect((await database.query.apiKeys.findFirst())?.accountScopeJson).toBe(
      JSON.stringify([id])
    );
  }

  await database
    .update(schema.providerAccounts)
    .set({ accountId: null, metadataJson: JSON.stringify(metadata) })
    .where(eq(schema.providerAccounts.id, id));
  const started = await startProviderOAuth(
    database,
    "claude",
    { options: { replaceAccountId: id } },
    Date.now()
  );
  globalThis.fetch = (async () =>
    Response.json({
      access_token: "same-identity-access",
      refresh_token: "same-identity-refresh",
      expires_in: 3600,
      account: { uuid: "user-a" },
      organization: { uuid: "org-a" },
    })) as typeof fetch;
  expect(
    await completeProviderOAuth(
      database,
      "claude",
      { state: started.state, code: "auth-code" },
      Date.now()
    )
  ).toMatchObject({
    id,
    accountId: null,
    label: "Selected account",
    isPrimary: true,
    enabled: false,
    refreshToken: "same-identity-refresh",
  });
});

test("Codex persists rotated credentials with a short usable expiry when expires_in is unusable", async () => {
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.insert(schema.providerAccounts).values({
    id,
    provider: "codex",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: now - 1,
    createdAt: now,
    updatedAt: now,
  });

  for (const expiresIn of [0, -1, "soon", 1e308]) {
    const rotated = crypto.randomUUID();
    globalThis.fetch = (async () =>
      Response.json({
        access_token: "rotated-access",
        refresh_token: rotated,
        expires_in: expiresIn,
      })) as typeof fetch;

    const before = Date.now();
    await refreshProviderAccount(database, id, before, { force: true });
    const persisted = await findProviderAccountById(database, id);
    expect(persisted).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: rotated,
      lastRefreshStatus: "success",
      refreshLockToken: null,
    });
    expect(persisted?.expiresAt).toBeGreaterThan(before);
    expect(persisted?.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  }
});

test("permanent Codex OAuth failures retain sanitized diagnostics and block subsequent refreshes", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (const [code, error] of [
      ["invalid_grant", "invalid_grant"],
      ["refresh_token_expired", { code: "refresh_token_expired" }],
      ["refresh_token_reused", { code: "refresh_token_reused" }],
      ["refresh_token_invalidated", { code: "refresh_token_invalidated" }],
    ] as const) {
      const id = crypto.randomUUID();
      const now = Date.now();
      await database.insert(schema.providerAccounts).values({
        id,
        provider: "codex",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: now - 1,
        createdAt: now,
        updatedAt: now,
      });
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return Response.json(
          { error, error_description: "private-refresh-token" },
          { status: 400 }
        );
      }) as typeof fetch;

      await expect(
        refreshProviderAccount(database, id, Date.now())
      ).rejects.toThrow(code);
      expect(await findProviderAccountById(database, id)).toMatchObject({
        refreshToken: "old-refresh",
        lastRefreshStatus: "reauthorize",
        refreshLockToken: null,
      });
      await expect(
        refreshProviderAccount(database, id, Date.now(), { force: true })
      ).rejects.toThrow("needs reauthorization");
      await expect(
        refreshProviderAccountAfterAuthFailure(database, id, "old-access")
      ).rejects.toThrow("needs reauthorization");
      expect(calls).toBe(1);
      const line = String(warn.mock.calls.at(-1)?.[0]);
      expect(JSON.parse(line)).toMatchObject({
        event: "provider_oauth_refresh_failed",
        status: 400,
        errorCode: code,
        classification: "reauthorize",
      });
      expect(line).not.toContain("private-refresh-token");
    }
  } finally {
    warn.mockRestore();
  }
});

test("a mismatched callback leaves either provider's OAuth flow usable exactly once", async () => {
  for (const provider of ["claude", "codex"] as const) {
    const started = await startProviderOAuth(
      database,
      provider,
      {},
      Date.now()
    );
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });
    }) as typeof fetch;

    await expect(
      completeProviderOAuth(
        database,
        provider,
        {
          state: started.state,
          code: "https://example.com/?code=code&state=wrong",
        },
        Date.now()
      )
    ).rejects.toThrow("callback state mismatch");
    expect(calls).toBe(0);
    const input = { state: started.state, code: `code#${started.state}` };
    expect(
      await completeProviderOAuth(database, provider, input, Date.now())
    ).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    await expect(
      completeProviderOAuth(database, provider, input, Date.now())
    ).rejects.toThrow("missing or expired");
    expect(calls).toBe(1);
  }
});
