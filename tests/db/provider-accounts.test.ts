import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { Database } from "../../src/db";
import {
  findPrimaryProviderAccount,
  listConfiguredProviders,
  listProviderAccounts,
  listProviderStatuses,
  setPrimaryProviderAccount,
  setProviderAccountsEnabled,
  upsertProviderAccount,
} from "../../src/db/repositories/provider-accounts";
import { providerAccounts } from "../../src/db/schema";
import * as schema from "../../src/db/schema";
import {
  getRoutableProviderAccount,
  refreshProviderAccount,
  refreshProviderAccountAfterAuthFailure,
} from "../../src/domain/providers/provider-service";
import { sendWithAuthReplay } from "../../src/http/auth-replay";
import { codexAdapter } from "../../src/providers/codex";

describe("provider account enablement", () => {
  const originalCodexRefreshAccount = codexAdapter.refreshAccount;
  const originalFetch = globalThis.fetch;
  let client: ReturnType<typeof createClient> | undefined;
  let anchor: ReturnType<typeof createClient>;
  let database: Database;

  beforeEach(async () => {
    // libSQL transactions open new connections. Keep shared memory alive
    // until every connection in this fixture has finished.
    anchor = createClient({ url: "file::memory:?cache=shared" });
    client = createClient({ url: "file::memory:?cache=shared" });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    await client.execute("DROP TRIGGER IF EXISTS reject_codex_refresh");
    await database.delete(providerAccounts);

    const now = Date.now();
    await database.insert(providerAccounts).values([
      {
        id: "claude-primary",
        provider: "claude",
        isPrimary: true,
        accessToken: "access-primary",
        refreshToken: "refresh-primary",
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "claude-secondary",
        provider: "claude",
        isPrimary: false,
        accessToken: "access-secondary",
        refreshToken: "refresh-secondary",
        expiresAt: now + 60_000,
        createdAt: now - 1,
        updatedAt: now,
      },
      {
        id: "codex-primary",
        provider: "codex",
        isPrimary: true,
        accessToken: "access-codex",
        refreshToken: "refresh-codex",
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      },
    ]);
  });

  afterEach(() => {
    codexAdapter.refreshAccount = originalCodexRefreshAccount;
    globalThis.fetch = originalFetch;
    client?.close();
    anchor.close();
  });

  test("hides Codex tokens in errors when the credential update fails", async () => {
    await client?.execute(`CREATE TRIGGER reject_codex_refresh
      BEFORE UPDATE ON provider_accounts
      WHEN NEW.access_token = 'new-access-secret'
      BEGIN SELECT RAISE(ABORT, 'credential write blocked'); END`);
    codexAdapter.refreshAccount = async (_account, refreshedAt) => ({
      accessToken: "new-access-secret",
      refreshToken: "new-refresh-secret",
      expiresAt: refreshedAt + 60_000,
      accountId: null,
      metadata: null,
    });

    let failure: unknown;
    try {
      await refreshProviderAccount(database, "codex-primary", Date.now(), {
        force: true,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected a Codex credential update failure");
    }
    expect(failure.message).toBe(
      "SQLITE_CONSTRAINT_TRIGGER: credential write blocked"
    );
    expect(failure.message).not.toContain("new-access-secret");
    expect(failure.message).not.toContain("new-refresh-secret");
    const current = await database.query.providerAccounts.findFirst({
      where: eq(providerAccounts.id, "codex-primary"),
    });
    expect(current?.refreshToken).toBe("refresh-codex");
    expect(current?.lastRefreshStatus).toBe("failed");
  });

  test("waits for a slow in-flight auth refresh instead of returning the rejected token", async () => {
    let refreshCount = 0;
    let startedRefresh: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      startedRefresh = resolve;
    });
    codexAdapter.refreshAccount = async (account, now) => {
      refreshCount++;
      startedRefresh?.();
      await new Promise((resolve) => setTimeout(resolve, 3400));
      return {
        accessToken: "access-after-slow-refresh",
        refreshToken: account.refreshToken,
        expiresAt: now + 60_000,
        accountId: account.accountId,
        metadata: account.metadata,
      };
    };

    const first = refreshProviderAccountAfterAuthFailure(
      database,
      "codex-primary",
      "access-codex"
    );
    await refreshStarted;
    const second = refreshProviderAccountAfterAuthFailure(
      database,
      "codex-primary",
      "access-codex"
    );
    const [firstAccount, secondAccount] = await Promise.all([first, second]);

    expect(refreshCount).toBe(1);
    expect(firstAccount?.accessToken).toBe("access-after-slow-refresh");
    expect(secondAccount?.accessToken).toBe("access-after-slow-refresh");
  });

  test("stops waiting for another refresh when the request disconnects", async () => {
    let startedRefresh: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      startedRefresh = resolve;
    });
    let releaseRefresh: (() => void) | undefined;
    const refreshReleased = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    codexAdapter.refreshAccount = async (account, now) => {
      startedRefresh?.();
      await refreshReleased;
      return {
        accessToken: "access-after-disconnect",
        refreshToken: account.refreshToken,
        expiresAt: now + 60_000,
        accountId: account.accountId,
        metadata: account.metadata,
      };
    };

    const first = refreshProviderAccountAfterAuthFailure(
      database,
      "codex-primary",
      "access-codex"
    );
    await refreshStarted;
    const controller = new AbortController();
    const waiting = refreshProviderAccountAfterAuthFailure(
      database,
      "codex-primary",
      "access-codex",
      controller.signal
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort(new Error("client disconnected"));

    try {
      await expect(waiting).rejects.toThrow("client disconnected");
    } finally {
      releaseRefresh?.();
      await first;
    }
  });

  test("an already disconnected request starts no refresh", async () => {
    let refreshCount = 0;
    codexAdapter.refreshAccount = () => {
      refreshCount++;
      return Promise.reject(new Error("refresh should not start"));
    };

    await expect(
      refreshProviderAccountAfterAuthFailure(
        database,
        "codex-primary",
        "access-codex",
        AbortSignal.abort(new Error("client disconnected"))
      )
    ).rejects.toThrow("client disconnected");
    expect(refreshCount).toBe(0);
  });

  test("refreshes a rejected token issued more than a minute ago", async () => {
    await database
      .update(providerAccounts)
      .set({ lastRefreshAt: Date.now() - 61_000, lastRefreshStatus: "success" })
      .where(eq(providerAccounts.id, "codex-primary"));

    let refreshCount = 0;
    codexAdapter.refreshAccount = (account, now) => {
      refreshCount++;
      return Promise.resolve({
        accessToken: "access-after-401",
        refreshToken: account.refreshToken,
        expiresAt: now + 60_000,
        accountId: account.accountId,
        metadata: account.metadata,
      });
    };

    const refreshed = await refreshProviderAccountAfterAuthFailure(
      database,
      "codex-primary",
      "access-codex"
    );

    expect(refreshCount).toBe(1);
    expect(refreshed?.accessToken).toBe("access-after-401");
  });

  test("a token rejected again right after its refresh is not rotated on every request", async () => {
    await database
      .update(providerAccounts)
      .set({ lastRefreshAt: Date.now() - 61_000, lastRefreshStatus: "success" })
      .where(eq(providerAccounts.id, "codex-primary"));
    let refreshCount = 0;
    codexAdapter.refreshAccount = (account, now) => {
      refreshCount++;
      return Promise.resolve({
        accessToken: `access-after-401-${refreshCount}`,
        refreshToken: account.refreshToken,
        expiresAt: now + 3_600_000,
        accountId: account.accountId,
        metadata: account.metadata,
      });
    };
    const sendRequest = async () => {
      const account = await findPrimaryProviderAccount(database, "codex");
      if (!account) throw new Error("Missing test account");
      return sendWithAuthReplay({
        account,
        send: () =>
          Promise.resolve({ response: new Response(null, { status: 401 }) }),
        refresh: (accountId, token) =>
          refreshProviderAccountAfterAuthFailure(database, accountId, token),
      });
    };

    const first = await sendRequest();
    const second = await sendRequest();

    expect(refreshCount).toBe(1);
    expect(first.replayed).toBe(true);
    expect(second).toMatchObject({ replayed: false, refreshFailed: true });
    expect(second.attempt.response.status).toBe(401);
    expect(second.account.accessToken).toBe("access-after-401-1");

    await database
      .update(providerAccounts)
      .set({ expiresAt: Date.now() - 1000 })
      .where(eq(providerAccounts.id, "codex-primary"));
    expect(
      await refreshProviderAccountAfterAuthFailure(
        database,
        "codex-primary",
        "access-after-401-1"
      )
    ).toMatchObject({ accessToken: "access-after-401-2" });
  });

  test("same-account refreshes in one process share one failing attempt", async () => {
    let refreshCount = 0;
    codexAdapter.refreshAccount = async () => {
      refreshCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error("Codex token refresh failed (HTTP 503)");
    };

    const results = await Promise.allSettled([
      refreshProviderAccount(database, "codex-primary", Date.now(), {
        force: true,
      }),
      refreshProviderAccount(database, "codex-primary", Date.now(), {
        force: true,
      }),
      refreshProviderAccountAfterAuthFailure(
        database,
        "codex-primary",
        "access-codex"
      ),
    ]);

    expect(refreshCount).toBe(1);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
    ]);
  });

  test("Codex adopts only a newer unexpired credential after losing its lock", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      codexAdapter.refreshAccount = async (account, now) => {
        await database
          .update(providerAccounts)
          .set({ refreshLockToken: "another-owner" })
          .where(eq(providerAccounts.id, "codex-primary"));
        await new Promise((resolve) => setTimeout(resolve, 5200));
        return {
          accessToken: "access-without-lock",
          refreshToken: "refresh-without-lock",
          expiresAt: now + 60_000,
          accountId: account.accountId,
          metadata: account.metadata,
        };
      };

      await expect(
        refreshProviderAccount(database, "codex-primary", Date.now(), {
          force: true,
        })
      ).rejects.toThrow("Codex refresh lost its credential lock");
      expect(
        warn.mock.calls.map(
          (call) => JSON.parse(String(call[0])) as { event: string }
        )
      ).toContainEqual(
        expect.objectContaining({
          event: "provider_refresh_lock_lost",
          providerAccountId: "codex-primary",
          provider: "codex",
        })
      );
      expect(await findPrimaryProviderAccount(database, "codex")).toMatchObject(
        { accessToken: "access-codex", refreshToken: "refresh-codex" }
      );

      codexAdapter.refreshAccount = async (account, now) => {
        await database
          .update(providerAccounts)
          .set({
            refreshLockToken: "another-owner",
            accessToken: "access-from-other-owner",
            refreshToken: "refresh-from-other-owner",
            expiresAt: now + 60_000,
          })
          .where(eq(providerAccounts.id, "codex-primary"));
        return {
          accessToken: "access-without-lock",
          refreshToken: "refresh-without-lock",
          expiresAt: now + 60_000,
          accountId: account.accountId,
          metadata: account.metadata,
        };
      };
      await database
        .update(providerAccounts)
        .set({ refreshLockToken: null, refreshLockExpiresAt: null })
        .where(eq(providerAccounts.id, "codex-primary"));

      expect(
        await refreshProviderAccount(database, "codex-primary", Date.now(), {
          force: true,
        })
      ).toMatchObject({ accessToken: "access-from-other-owner" });
    } finally {
      warn.mockRestore();
    }
  }, 10_000);

  test("Codex OAuth errors keep only the status and an allowlisted code", async () => {
    const account = await findPrimaryProviderAccount(database, "codex");
    if (!account) throw new Error("Missing test account");
    const bodies = [
      {
        error: {
          message: "refresh-codex was already used",
          type: "invalid_request_error",
          code: "refresh_token_reused",
        },
      },
      { error: "refresh-codex is unknown", detail: "refresh-codex" },
    ];
    const messages: string[] = [];
    for (const body of bodies) {
      globalThis.fetch = (() =>
        Promise.resolve(Response.json(body, { status: 400 }))) as typeof fetch;
      try {
        await codexAdapter.refreshAccount(account, Date.now());
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }

    expect(messages).toEqual([
      "Codex token refresh failed (HTTP 400, refresh_token_reused)",
      "Codex token refresh failed (HTTP 400)",
    ]);
  });

  test("adopts a token already refreshed by another request", async () => {
    await database
      .update(providerAccounts)
      .set({ accessToken: "access-codex-new" })
      .where(eq(providerAccounts.id, "codex-primary"));
    codexAdapter.refreshAccount = () =>
      Promise.reject(new Error("unexpected duplicate refresh"));

    const account = await refreshProviderAccountAfterAuthFailure(
      database,
      "codex-primary",
      "access-codex"
    );

    expect(account?.accessToken).toBe("access-codex-new");
  });

  test("a reconnect clears a previous reauthorization-required refresh status", async () => {
    await database
      .update(providerAccounts)
      .set({
        accountId: "reconnected-account",
        lastRefreshAt: Date.now(),
        lastRefreshStatus: "reauthorize",
      })
      .where(eq(providerAccounts.id, "codex-primary"));
    const renewed = await upsertProviderAccount(database, {
      provider: "codex",
      accountId: "reconnected-account",
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: Date.now() + 3_600_000,
      metadata: null,
      now: Date.now(),
    });
    expect(renewed).toMatchObject({
      id: "codex-primary",
      lastRefreshStatus: "success",
      accessToken: "new-access",
    });
  });

  test("disables every account and excludes the provider from discovery and routing", async () => {
    const now = Date.now();
    const status = await setProviderAccountsEnabled(
      database,
      "claude",
      false,
      now
    );

    expect(status).toEqual({
      provider: "claude",
      enabled: false,
      accountCount: 2,
      enabledAccountCount: 0,
    });
    expect(
      (await listProviderAccounts(database))
        .filter((account) => account.provider === "claude")
        .every((account) => !account.enabled)
    ).toBe(true);
    expect(await listConfiguredProviders(database)).toEqual(["codex"]);
    expect(await findPrimaryProviderAccount(database, "claude")).toBeNull();
    expect(
      await getRoutableProviderAccount(database, "claude", now)
    ).toBeNull();
    expect(
      await getRoutableProviderAccount(database, "claude", now, {
        allowedAccountIds: ["claude-secondary"],
      })
    ).toBeNull();
  });

  test("new accounts inherit disabled state and re-enabling restores routing", async () => {
    const now = Date.now();
    await setProviderAccountsEnabled(database, "claude", false, now);

    const created = await upsertProviderAccount(database, {
      provider: "claude",
      accountId: "new-account",
      accessToken: "access-new",
      refreshToken: "refresh-new",
      expiresAt: now + 60_000,
      metadata: null,
      now,
    });
    expect(created.enabled).toBe(false);

    const status = await setProviderAccountsEnabled(
      database,
      "claude",
      true,
      now + 1
    );
    expect(status.enabledAccountCount).toBe(3);
    expect(await listConfiguredProviders(database)).toContain("claude");
    expect(
      (await getRoutableProviderAccount(database, "claude", now + 1))?.id
    ).toBe("claude-primary");
    expect(await listProviderStatuses(database)).toContainEqual(status);
  });

  test("applies account pins per provider and uses the primary elsewhere", async () => {
    const now = Date.now();
    const codexPinned = { allowedAccountIds: ["codex-primary"] };
    expect(
      (await getRoutableProviderAccount(database, "claude", now, codexPinned))
        ?.id
    ).toBe("claude-primary");
    expect(
      (await getRoutableProviderAccount(database, "codex", now, codexPinned))
        ?.id
    ).toBe("codex-primary");

    await setPrimaryProviderAccount(database, "claude-secondary", now);
    expect(
      (await getRoutableProviderAccount(database, "claude", now, codexPinned))
        ?.id
    ).toBe("claude-secondary");

    const claudePinned = { allowedAccountIds: ["claude-primary"] };
    expect(
      (await getRoutableProviderAccount(database, "claude", now, claudePinned))
        ?.id
    ).toBe("claude-primary");
    expect(
      (await getRoutableProviderAccount(database, "codex", now, claudePinned))
        ?.id
    ).toBe("codex-primary");
  });

  test("does not fall back to the primary when the pinned account is disabled", async () => {
    const now = Date.now();
    await database
      .update(providerAccounts)
      .set({ enabled: false })
      .where(eq(providerAccounts.id, "claude-secondary"));

    expect(
      await getRoutableProviderAccount(database, "claude", now, {
        allowedAccountIds: ["claude-secondary"],
      })
    ).toBeNull();
  });

  test("waits for a slow ordinary Codex refresh instead of returning 502", async () => {
    await database
      .update(providerAccounts)
      .set({ expiresAt: Date.now() - 1000 })
      .where(eq(providerAccounts.id, "codex-primary"));
    let refreshCount = 0;
    let startedRefresh: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      startedRefresh = resolve;
    });
    codexAdapter.refreshAccount = async (account, now) => {
      refreshCount++;
      startedRefresh?.();
      await new Promise((resolve) => setTimeout(resolve, 3400));
      return {
        accessToken: "access-after-slow-refresh",
        refreshToken: account.refreshToken,
        expiresAt: now + 60_000,
        accountId: account.accountId,
        metadata: account.metadata,
      };
    };

    const first = refreshProviderAccount(database, "codex-primary", Date.now());
    await refreshStarted;
    const second = refreshProviderAccount(
      database,
      "codex-primary",
      Date.now()
    );
    const [firstAccount, secondAccount] = await Promise.all([first, second]);

    expect(refreshCount).toBe(1);
    expect(firstAccount?.accessToken).toBe("access-after-slow-refresh");
    expect(secondAccount?.accessToken).toBe("access-after-slow-refresh");
  });
});
