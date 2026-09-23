import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "../../src/db";
import {
  findProviderAccountById,
  replaceProviderAccountCredentials,
} from "../../src/db/repositories/provider-accounts";
import { providerAccounts } from "../../src/db/schema";
import * as schema from "../../src/db/schema";
import {
  refreshProviderAccount,
  refreshProviderAccountAfterAuthFailure,
} from "../../src/domain/providers/provider-service";
import { sendWithAuthReplay } from "../../src/http/auth-replay";

describe("Claude refresh lifecycle", () => {
  const originalFetch = globalThis.fetch;
  const id = "23ab7a29-6338-4382-83ba-f8508ed59a56";
  let client: ReturnType<typeof createClient>;
  let database: Database;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kleis-claude-refresh-"));
    client = createClient({ url: `file:${join(directory, "test.db")}` });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    const now = Date.now();
    await database.insert(providerAccounts).values({
      id,
      provider: "claude",
      accountId: "same-claude-account",
      isPrimary: true,
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: now - 1000,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    client.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("refreshes via Platform and atomically persists the rotated token", async () => {
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = ((url, init) => {
      expect(url).toBe("https://platform.claude.com/v1/oauth/token");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(
        Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          account: { uuid: "same-claude-account" },
        })
      );
    }) as typeof fetch;

    const refreshed = await refreshProviderAccount(database, id, Date.now());
    expect(requestBody).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
    });
    expect(refreshed).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      accountId: "same-claude-account",
      lastRefreshStatus: "success",
    });
    expect(refreshed?.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await findProviderAccountById(database, id)).toMatchObject({
      refreshToken: "new-refresh",
      refreshLockToken: null,
    });
  });

  test("shares a rotated result with concurrent refresh waiters", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: (() => void) | undefined;
    const invoked = new Promise<void>((resolve) => {
      started = resolve;
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      started?.();
      await pending;
      return Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      });
    }) as typeof fetch;

    const first = refreshProviderAccount(database, id, Date.now());
    await invoked;
    const second = refreshProviderAccount(database, id, Date.now());
    release?.();
    const results = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(results.map((result) => result?.refreshToken)).toEqual([
      "rotated-refresh",
      "rotated-refresh",
    ]);
  });

  test("separate legacy rows for one Claude user can both persist rotated tokens", async () => {
    const secondId = "46ab7a29-6338-4382-83ba-f8508ed59a56";
    const now = Date.now();
    await database.insert(providerAccounts).values({
      id: secondId,
      provider: "claude",
      accessToken: "other-access",
      refreshToken: "other-refresh",
      expiresAt: now - 1000,
      createdAt: now,
      updatedAt: now,
    });
    const sent: string[] = [];
    globalThis.fetch = ((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { refresh_token: string };
      sent.push(body.refresh_token);
      return Promise.resolve(
        Response.json({
          access_token: `new-access-${sent.length}`,
          refresh_token: `new-refresh-${sent.length}`,
          expires_in: 3600,
          account: { uuid: "shared-user" },
        })
      );
    }) as typeof fetch;

    await refreshProviderAccount(database, id, Date.now());
    await refreshProviderAccount(database, secondId, Date.now());

    expect(sent).toEqual(["old-refresh", "other-refresh"]);
    expect(await findProviderAccountById(database, id)).toMatchObject({
      accountId: "same-claude-account",
      refreshToken: "new-refresh-1",
    });
    expect(await findProviderAccountById(database, secondId)).toMatchObject({
      accountId: null,
      refreshToken: "new-refresh-2",
      lastRefreshStatus: "success",
    });
  });

  test("does not re-use an invalid_grant refresh token and allows reauthorization", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(
        Response.json({ error: "invalid_grant" }, { status: 400 })
      );
    }) as typeof fetch;

    await expect(
      refreshProviderAccount(database, id, Date.now())
    ).rejects.toThrow("invalid_grant");
    expect(await findProviderAccountById(database, id)).toMatchObject({
      refreshToken: "old-refresh",
      lastRefreshStatus: "reauthorize",
      refreshLockToken: null,
    });
    await expect(
      refreshProviderAccount(database, id, Date.now())
    ).rejects.toThrow("needs reauthorization");
    expect(calls).toBe(1);

    await replaceProviderAccountCredentials(database, id, {
      provider: "claude",
      accountId: "same-claude-account",
      accessToken: "reauthorized-access",
      refreshToken: "reauthorized-refresh",
      expiresAt: Date.now() + 3_600_000,
      metadata: null,
      now: Date.now(),
    });
    expect(
      await refreshProviderAccountAfterAuthFailure(database, id, "old-access")
    ).toMatchObject({ accessToken: "reauthorized-access" });
  });

  test("backs off transient errors without discarding credentials", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(
        Response.json({ error: "temporarily_unavailable" }, { status: 503 })
      );
    }) as typeof fetch;

    await expect(
      refreshProviderAccount(database, id, Date.now())
    ).rejects.toThrow("temporarily_unavailable");
    expect(await findProviderAccountById(database, id)).toMatchObject({
      refreshToken: "old-refresh",
      lastRefreshStatus: "transient",
    });
    await expect(
      refreshProviderAccount(database, id, Date.now())
    ).rejects.toThrow("temporarily unavailable");
    expect(calls).toBe(1);
  });

  test("does not accept a refresh response without a rotated refresh token", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ access_token: "new-access", expires_in: 3600 })
      )) as typeof fetch;

    await expect(
      refreshProviderAccount(database, id, Date.now())
    ).rejects.toThrow("missing refresh_token");
    expect(await findProviderAccountById(database, id)).toMatchObject({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      lastRefreshStatus: "transient",
    });
  });

  test("classifies token endpoint rate limiting separately from credential failure", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ error: "rate_limit_error" }, { status: 429 })
      )) as typeof fetch;

    await expect(
      refreshProviderAccount(database, id, Date.now())
    ).rejects.toThrow("rate_limit_error");
    expect(await findProviderAccountById(database, id)).toMatchObject({
      refreshToken: "old-refresh",
      lastRefreshStatus: "rate_limited",
    });
  });

  test("does not overwrite credentials reauthorized during a refresh", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: (() => void) | undefined;
    const invoked = new Promise<void>((resolve) => {
      started = resolve;
    });
    globalThis.fetch = (async () => {
      started?.();
      await pending;
      return Response.json({
        access_token: "stale-access",
        refresh_token: "stale-refresh",
        expires_in: 3600,
      });
    }) as typeof fetch;

    const refreshing = refreshProviderAccount(database, id, Date.now());
    await invoked;
    await replaceProviderAccountCredentials(database, id, {
      provider: "claude",
      accountId: "same-claude-account",
      accessToken: "reauthorized-access",
      refreshToken: "reauthorized-refresh",
      expiresAt: Date.now() + 3_600_000,
      metadata: null,
      now: Date.now(),
    });
    release?.();

    expect(await refreshing).toMatchObject({
      accessToken: "reauthorized-access",
      refreshToken: "reauthorized-refresh",
    });
    expect(await findProviderAccountById(database, id)).toMatchObject({
      refreshToken: "reauthorized-refresh",
      lastRefreshStatus: "success",
    });
  });

  test("replays one pre-output 401 using the refreshed Claude token", async () => {
    const sent: string[] = [];
    globalThis.fetch = (async () =>
      Response.json({
        access_token: "after-401",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      })) as typeof fetch;
    const account = await findProviderAccountById(database, id);
    if (!account) throw new Error("Missing test account");

    const result = await sendWithAuthReplay({
      account,
      send: (current) => {
        sent.push(current.accessToken);
        return Promise.resolve({
          response: new Response(null, {
            status: sent.length === 1 ? 401 : 200,
          }),
        });
      },
      refresh: (accountId, token) =>
        refreshProviderAccountAfterAuthFailure(database, accountId, token),
    });

    expect(sent).toEqual(["old-access", "after-401"]);
    expect(result.replayed).toBe(true);
    expect(result.attempt.response.status).toBe(200);
  });
});
