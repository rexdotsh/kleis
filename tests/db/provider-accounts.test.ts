import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { unlink } from "node:fs/promises";

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
  let client: ReturnType<typeof createClient>;
  let database: Database;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = `/tmp/opencode/kleis-provider-accounts-${crypto.randomUUID()}.db`;
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
    client.close();
    await unlink(databasePath).catch(() => undefined);
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
