import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { Database } from "../../src/db";
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

  test("a Codex refresh that names another user is not saved", async () => {
    await database.update(providerAccounts).set({
      metadataJson: JSON.stringify({
        provider: "codex",
        chatgptAccountId: "acct-fake-1",
        email: null,
        chatgptUserId: "user-fake",
      }),
    });
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({
          access_token: "codex-access-other",
          refresh_token: "codex-refresh-other",
          id_token: jwt({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct-fake-1",
              chatgpt_user_id: "user-fake-other",
            },
          }),
          expires_in: 3600,
        })
      )) as unknown as typeof fetch;
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        refreshProviderAccount(database, codexId, Date.now(), { force: true })
      ).rejects.toThrow("different user");
    } finally {
      warn.mockRestore();
    }

    const [stored] = await database.select().from(providerAccounts);
    expect(stored).toMatchObject({
      accessToken: "codex-access",
      refreshToken: "codex-refresh",
      lastRefreshStatus: "reauthorize",
    });
    expect(JSON.parse(stored?.metadataJson ?? "{}")).toMatchObject({
      chatgptUserId: "user-fake",
    });
  });
});
