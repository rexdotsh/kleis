import { createClient } from "@libsql/client";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { Database } from "../../src/db";
import {
  findProviderAccountById,
  replaceProviderAccountCredentials,
  tryAcquireProviderAccountRefreshLock,
  updateProviderAccountTokens,
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

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
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

  afterEach(() => {
    globalThis.fetch = originalFetch;
    client.close();
  });

  test.each([
    ["another lock owner", "other-lock", "old-refresh", 60_000],
    ["a changed refresh token", "held-lock", "stale-refresh", 60_000],
    ["an expired lease", "held-lock", "old-refresh", -1],
  ] as const)(
    "rejects credential writes with %s",
    async (_name, token, expected, leaseMs) => {
      const now = Date.now();
      await tryAcquireProviderAccountRefreshLock(database, id, {
        token: "held-lock",
        now,
        expiresAt: now + leaseMs,
      });
      expect(
        await updateProviderAccountTokens(database, id, {
          accessToken: "stale-access",
          refreshToken: "stale-refresh",
          expiresAt: now + 3_600_000,
          refreshLockToken: token,
          expectedRefreshToken: expected,
          lastRefreshStatus: "success",
          now,
        })
      ).toBeNull();
      expect(await findProviderAccountById(database, id)).toMatchObject({
        accessToken: "old-access",
        refreshToken: "old-refresh",
      });
    }
  );

  test("refreshes via Platform and atomically persists the rotated token", async () => {
    await database.update(providerAccounts).set({
      metadataJson: JSON.stringify({
        provider: "claude",
        oauthMode: "console",
        oauthHost: "platform.claude.com",
        systemIdentity: "stale identity",
        toolPrefix: "mcp_",
        userAgent: "stale-cli",
        betaHeaders: ["old-beta"],
      }),
    });
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
    const [stored] = await database.select().from(providerAccounts);
    expect(JSON.parse(stored?.metadataJson ?? "null")).toEqual({
      provider: "claude",
      scope: null,
      oauthMode: "console",
      oauthHost: "platform.claude.com",
      accountUuid: "same-claude-account",
    });
  });

  const setGrantedScope = (scope: string | null) =>
    database.update(providerAccounts).set({
      metadataJson: JSON.stringify({
        provider: "claude",
        scope,
        oauthMode: "max",
        oauthHost: "claude.ai",
      }),
    });
  const claudeCodeScope =
    "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

  test.each([
    [
      "a grant covering Claude Code's scopes",
      `org:create_api_key ${claudeCodeScope}`,
      [claudeCodeScope],
    ],
    ["an incomplete grant", "user:inference user:profile", [undefined]],
    [
      "an over-claimed grant",
      `${claudeCodeScope} user:plugins`,
      [`${claudeCodeScope} user:plugins`, undefined],
    ],
  ] as const)(
    "refreshes %s without leaving the real grant",
    async (_name, granted, expectedScopes) => {
      await setGrantedScope(granted);
      const sent: { refresh_token: string; scope?: string }[] = [];
      globalThis.fetch = ((_url, init) => {
        const body = JSON.parse(String(init?.body)) as (typeof sent)[number];
        sent.push(body);
        if (body.scope?.includes("user:plugins")) {
          return Promise.resolve(
            Response.json({ error: "invalid_scope" }, { status: 400 })
          );
        }
        return Promise.resolve(
          Response.json({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
            scope: claudeCodeScope,
          })
        );
      }) as typeof fetch;

      const refreshed = await refreshProviderAccount(database, id, Date.now());

      expect(sent.map((body) => body.scope)).toEqual([...expectedScopes]);
      expect(sent.every((body) => body.refresh_token === "old-refresh")).toBe(
        true
      );
      expect(refreshed).toMatchObject({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        lastRefreshStatus: "success",
      });
      expect(refreshed?.metadata).toMatchObject({ scope: claudeCodeScope });
    }
  );

  test("does not retry a scoped refresh that timed out", async () => {
    await setGrantedScope(claudeCodeScope);
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.reject(
        new DOMException("The operation timed out.", "TimeoutError")
      );
    }) as typeof fetch;

    await expect(
      refreshProviderAccount(database, id, Date.now())
    ).rejects.toThrow("timed out");
    expect(calls).toBe(1);
    expect(await findProviderAccountById(database, id)).toMatchObject({
      refreshToken: "old-refresh",
      lastRefreshStatus: "indeterminate",
    });
  });

  test("stores tokens from a compress-encoded response", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          deflateSync(
            JSON.stringify({
              access_token: "new-access",
              refresh_token: "new-refresh",
              expires_in: 3600,
            })
          ),
          { headers: { "Content-Encoding": "compress" } }
        )
      )) as typeof fetch;

    expect(
      await refreshProviderAccount(database, id, Date.now())
    ).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      lastRefreshStatus: "success",
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

  // Claude Code 2.1.299 reads `refresh_token: G = e` from the refresh response,
  // keeping the token it sent when the response omits one.
  test("keeps the current refresh token when the response omits a replacement", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ access_token: "new-access", expires_in: 3600 })
      )) as typeof fetch;

    expect(
      await refreshProviderAccount(database, id, Date.now())
    ).toMatchObject({
      accessToken: "new-access",
      refreshToken: "old-refresh",
      lastRefreshStatus: "success",
    });
  });

  test("keeps a rotated refresh token when the expiry field is unusable", async () => {
    for (const [index, expiresIn] of [undefined, "soon", 0, 30].entries()) {
      await database.update(providerAccounts).set({
        expiresAt: Date.now() - 1000,
        lastRefreshStatus: null,
      });
      globalThis.fetch = (() =>
        Promise.resolve(
          Response.json({
            access_token: `new-access-${index}`,
            refresh_token: `new-refresh-${index}`,
            expires_in: expiresIn,
          })
        )) as typeof fetch;

      const refreshed = await refreshProviderAccount(database, id, Date.now());
      expect(refreshed).toMatchObject({
        refreshToken: `new-refresh-${index}`,
        lastRefreshStatus: "success",
      });
      expect(refreshed?.expiresAt).toBeGreaterThan(Date.now());
      expect(refreshed?.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    }
  });

  test("a token request that fails after it was sent is indeterminate", async () => {
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      return Promise.reject(
        new DOMException("The operation timed out.", "TimeoutError")
      );
    }) as typeof fetch;

    await expect(
      refreshProviderAccount(database, id, Date.now())
    ).rejects.toThrow("timed out");
    expect(await findProviderAccountById(database, id)).toMatchObject({
      refreshToken: "old-refresh",
      lastRefreshStatus: "indeterminate",
      refreshLockToken: null,
    });
    await expect(
      refreshProviderAccount(database, id, Date.now())
    ).rejects.toThrow("temporarily unavailable");
    expect(calls).toBe(1);
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
