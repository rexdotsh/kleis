import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { getRoutableProviderAccount } from "../../src/domain/providers/provider-service";

describe("provider account enablement", () => {
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

  afterEach(async () => {
    client?.close();
    await rm(databaseDirectory, { recursive: true, force: true }).catch(
      () => undefined
    );
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
});
