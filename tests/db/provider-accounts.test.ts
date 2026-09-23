import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "../../src/db";
import {
  findPrimaryProviderAccount,
  listConfiguredProviders,
  listProviderAccounts,
  listProviderStatuses,
  setProviderAccountsEnabled,
  upsertProviderAccount,
} from "../../src/db/repositories/provider-accounts";
import { providerAccounts } from "../../src/db/schema";
import * as schema from "../../src/db/schema";
import {
  getRoutableProviderAccount,
  refreshProviderAccountAfterAuthFailure,
} from "../../src/domain/providers/provider-service";
import { codexAdapter } from "../../src/providers/codex";

describe("provider account enablement", () => {
  const originalCodexRefreshAccount = codexAdapter.refreshAccount;
  let client: ReturnType<typeof createClient> | undefined;
  let database: Database;
  let databaseDirectory: string;

  beforeEach(async () => {
    databaseDirectory = await mkdtemp(
      join(tmpdir(), "kleis-provider-accounts-")
    );
    const databasePath = join(databaseDirectory, "test.db");
    client = createClient({ url: `file:${databasePath}` });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });

    const now = Date.now();
    await database.insert(providerAccounts).values([
      {
        id: "copilot-primary",
        provider: "copilot",
        isPrimary: true,
        accessToken: "access-primary",
        refreshToken: "refresh-primary",
        expiresAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "copilot-secondary",
        provider: "copilot",
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

  afterEach(async () => {
    codexAdapter.refreshAccount = originalCodexRefreshAccount;
    client?.close();
    await rm(databaseDirectory, { recursive: true, force: true }).catch(
      () => undefined
    );
  });

  test("coalesces concurrent refreshes after a rejected Codex token", async () => {
    let refreshCount = 0;
    codexAdapter.refreshAccount = async (account, now) => {
      refreshCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        accessToken: "access-codex-refreshed",
        refreshToken: account.refreshToken,
        expiresAt: now + 60_000,
        accountId: account.accountId,
        metadata: account.metadata,
      };
    };

    const [left, right] = await Promise.all([
      refreshProviderAccountAfterAuthFailure(
        database,
        "codex-primary",
        "access-codex"
      ),
      refreshProviderAccountAfterAuthFailure(
        database,
        "codex-primary",
        "access-codex"
      ),
    ]);

    expect(refreshCount).toBe(1);
    expect(left?.accessToken).toBe("access-codex-refreshed");
    expect(right?.accessToken).toBe("access-codex-refreshed");
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

  test("refreshes a rejected token even after a recent ordinary refresh", async () => {
    await database
      .update(providerAccounts)
      .set({ lastRefreshAt: Date.now(), lastRefreshStatus: "success" })
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
      "copilot",
      false,
      now
    );

    expect(status).toEqual({
      provider: "copilot",
      enabled: false,
      accountCount: 2,
      enabledAccountCount: 0,
    });
    expect(
      (await listProviderAccounts(database))
        .filter((account) => account.provider === "copilot")
        .every((account) => !account.enabled)
    ).toBe(true);
    expect(await listConfiguredProviders(database)).toEqual(["codex"]);
    expect(await findPrimaryProviderAccount(database, "copilot")).toBeNull();
    expect(
      await getRoutableProviderAccount(database, "copilot", now)
    ).toBeNull();
    expect(
      await getRoutableProviderAccount(database, "copilot", now, {
        allowedAccountIds: ["copilot-secondary"],
      })
    ).toBeNull();
  });

  test("new accounts inherit disabled state and re-enabling restores routing", async () => {
    const now = Date.now();
    await setProviderAccountsEnabled(database, "copilot", false, now);

    const created = await upsertProviderAccount(database, {
      provider: "copilot",
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
      "copilot",
      true,
      now + 1
    );
    expect(status.enabledAccountCount).toBe(3);
    expect(await listConfiguredProviders(database)).toContain("copilot");
    expect(
      (await getRoutableProviderAccount(database, "copilot", now + 1))?.id
    ).toBe("copilot-primary");
    expect(await listProviderStatuses(database)).toContainEqual(status);
  });
});
