import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { Database } from "../../src/db";
import { findProviderAccountById } from "../../src/db/repositories/provider-accounts";
import { providerAccounts } from "../../src/db/schema";
import * as schema from "../../src/db/schema";
import { refreshProviderAccount } from "../../src/domain/providers/provider-service";

const jwt = (claims: Record<string, unknown>): string =>
  [
    "e30",
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "sig",
  ].join(".");

describe("account identity from token responses", () => {
  const originalFetch = globalThis.fetch;
  const claudeId = "6c1b0e47-0b7a-4c43-9a1e-3f0f4a6b2d10";
  const codexId = "0d3f6a0e-5c1e-4bb0-9f55-6a7e0e5c2b11";
  let client: ReturnType<typeof createClient>;
  let database: Database;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    const now = Date.now();
    await database.insert(providerAccounts).values([
      {
        id: claudeId,
        provider: "claude",
        isPrimary: true,
        accessToken: "claude-access",
        refreshToken: "claude-refresh",
        expiresAt: now - 1000,
        metadataJson: JSON.stringify({
          provider: "claude",
          oauthMode: "max",
          oauthHost: "claude.ai",
        }),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: codexId,
        provider: "codex",
        accountId: "acct-fake-1",
        isPrimary: true,
        accessToken: "codex-access",
        refreshToken: "codex-refresh",
        expiresAt: now - 1000,
        metadataJson: JSON.stringify({
          provider: "codex",
          chatgptAccountId: "acct-fake-1",
          email: "dev@example.com",
        }),
        createdAt: now,
        updatedAt: now,
      },
    ]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    client.close();
  });

  test("Claude refreshes store the identity and never erase a known field", async () => {
    let response: Record<string, unknown> = {
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
      refresh_token_expires_in: 30 * 86_400,
      account: { uuid: "user-uuid", email_address: "dev@example.com" },
      organization: { uuid: "org-uuid", name: "Example Org" },
      workspace: { id: "wrkspc_fake", name: "Default" },
    };
    globalThis.fetch = (() =>
      Promise.resolve(Response.json(response))) as unknown as typeof fetch;

    const before = Date.now();
    const first = await refreshProviderAccount(database, claudeId, Date.now(), {
      force: true,
    });
    expect(first?.metadata).toMatchObject({
      accountUuid: "user-uuid",
      email: "dev@example.com",
      organizationUuid: "org-uuid",
      organizationName: "Example Org",
      workspaceId: "wrkspc_fake",
      workspaceName: "Default",
    });
    const expiresAt =
      first?.metadata?.provider === "claude"
        ? first.metadata.refreshTokenExpiresAt
        : null;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * 86_400_000);

    response = {
      access_token: "access-2",
      refresh_token: "refresh-2",
      expires_in: 3600,
      organization: { uuid: "org-uuid", name: "Renamed Org" },
    };
    const second = await refreshProviderAccount(
      database,
      claudeId,
      Date.now(),
      { force: true }
    );
    expect(second?.metadata).toMatchObject({
      accountUuid: "user-uuid",
      email: "dev@example.com",
      organizationName: "Renamed Org",
      workspaceName: "Default",
      refreshTokenExpiresAt: expiresAt,
    });
  });

  test("a held Claude account is reported as on hold and refreshes pause", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(
        Response.json(
          {
            error: "invalid_grant",
            error_description: "Account is on hold",
            error_uri: "https://claude.ai/restricted?reason=account_on_hold",
          },
          { status: 403 }
        )
      );
    }) as unknown as typeof fetch;
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        refreshProviderAccount(database, claudeId, Date.now(), { force: true })
      ).rejects.toThrow(
        "Claude OAuth request failed (HTTP 403, account_on_hold)"
      );
      expect(await findProviderAccountById(database, claudeId)).toMatchObject({
        lastRefreshStatus: "account_on_hold",
      });

      await expect(
        refreshProviderAccount(database, claudeId, Date.now(), { force: true })
      ).rejects.toThrow("Claude account is on hold (account_on_hold)");
      expect(calls).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("Codex refreshes store subscription and user claims", async () => {
    let claims: Record<string, unknown> = {
      email: "dev@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-fake-1",
        chatgpt_user_id: "user-fake",
        chatgpt_plan_type: "plus",
        chatgpt_subscription_active_start: "2026-09-01T00:00:00Z",
        chatgpt_subscription_active_until: 1_793_491_200,
        chatgpt_subscription_last_checked: "2026-10-01T12:00:00Z",
        chatgpt_account_is_fedramp: false,
      },
    };
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          access_token: "codex-access-2",
          refresh_token: "codex-refresh-2",
          id_token: jwt(claims),
          expires_in: 3600,
        })
      )) as unknown as typeof fetch;

    const first = await refreshProviderAccount(database, codexId, Date.now(), {
      force: true,
    });
    expect(first?.metadata).toEqual({
      provider: "codex",
      scope: null,
      chatgptAccountId: "acct-fake-1",
      email: "dev@example.com",
      chatgptUserId: "user-fake",
      planTypeClaim: "plus",
      subscriptionActiveStart: Date.parse("2026-09-01T00:00:00Z"),
      subscriptionActiveUntil: 1_793_491_200_000,
      subscriptionLastChecked: Date.parse("2026-10-01T12:00:00Z"),
      isFedramp: false,
    });

    claims = {
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-fake-1",
        chatgpt_plan_type: "pro",
      },
    };
    const second = await refreshProviderAccount(database, codexId, Date.now(), {
      force: true,
    });
    expect(second?.metadata).toMatchObject({
      email: "dev@example.com",
      chatgptUserId: "user-fake",
      planTypeClaim: "pro",
      subscriptionActiveUntil: 1_793_491_200_000,
    });
  });
});
