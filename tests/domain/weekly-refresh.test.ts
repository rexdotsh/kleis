import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { Database } from "../../src/db";
import { findProviderAccountById } from "../../src/db/repositories/provider-accounts";
import { providerAccounts } from "../../src/db/schema";
import * as schema from "../../src/db/schema";
import { refreshStaleProviderAccounts } from "../../src/domain/providers/weekly-refresh";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("weekly provider account refresh", () => {
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

  test("refreshes accounts untouched for a week and leaves the rest alone", async () => {
    const now = Date.now();
    const account = (
      id: string,
      lastRefreshAt: number | null,
      lastRefreshStatus: string | null,
      createdAt = now - 30 * DAY_MS
    ) => ({
      id,
      provider: "codex" as const,
      accountId: `acct-${id}`,
      label: id,
      isPrimary: false,
      accessToken: `${id}-access`,
      refreshToken: `${id}-refresh`,
      expiresAt: now + 3 * DAY_MS,
      lastRefreshAt,
      lastRefreshStatus,
      createdAt,
      updatedAt: createdAt,
    });
    await database
      .insert(providerAccounts)
      .values([
        account("idle", now - 8 * DAY_MS, "success"),
        account("never-refreshed", null, null, now - 8 * DAY_MS),
        account("recent", now - DAY_MS, "success"),
        account("needs-login", now - 8 * DAY_MS, "reauthorize"),
      ]);
    const refreshedTokens: string[] = [];
    globalThis.fetch = ((url, init) => {
      expect(url).toBe("https://auth.openai.com/oauth/token");
      const refreshToken =
        new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
      refreshedTokens.push(refreshToken);
      return Promise.resolve(
        Response.json({
          access_token: `${refreshToken}-new-access`,
          refresh_token: `${refreshToken}-rotated`,
          expires_in: 864_000,
        })
      );
    }) as typeof fetch;

    const result = await refreshStaleProviderAccounts(database, now);

    expect(result).toEqual({ due: 2, refreshed: 2, failed: 0 });
    expect(refreshedTokens.sort()).toEqual([
      "idle-refresh",
      "never-refreshed-refresh",
    ]);
    expect(await findProviderAccountById(database, "idle")).toMatchObject({
      refreshToken: "idle-refresh-rotated",
      lastRefreshStatus: "success",
    });
    expect(await findProviderAccountById(database, "recent")).toMatchObject({
      refreshToken: "recent-refresh",
    });
  });
});
