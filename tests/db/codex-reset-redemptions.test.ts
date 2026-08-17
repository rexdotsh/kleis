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
  findCodexResetCreditRedemption,
  saveCodexResetCreditRedemption,
} from "../../src/db/repositories/codex-reset-redemptions";
import { providerAccounts } from "../../src/db/schema";
import * as schema from "../../src/db/schema";

describe("Codex reset-credit redemptions", () => {
  let client: ReturnType<typeof createClient>;
  let database: Database;
  let databaseDirectory: string;

  beforeEach(async () => {
    databaseDirectory = await mkdtemp(join(tmpdir(), "kleis-redemptions-"));
    client = createClient({
      url: `file:${join(databaseDirectory, "test.db")}`,
    });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    const now = Date.now();
    await database.insert(providerAccounts).values({
      id: "codex-account",
      provider: "codex",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: now + 60_000,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    client.close();
    await rm(databaseDirectory, { recursive: true, force: true });
  });

  test("updates retries and cascades with the provider account", async () => {
    const now = Date.now();
    const pending = {
      redeemRequestId: "request-1",
      providerAccountId: "codex-account",
      creditId: "credit-1",
      status: "pending",
      resultCode: null,
      windowsReset: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await saveCodexResetCreditRedemption(database, pending);
    await saveCodexResetCreditRedemption(database, {
      ...pending,
      status: "completed",
      resultCode: "reset",
      windowsReset: 2,
      updatedAt: now + 1,
    });
    expect(
      await findCodexResetCreditRedemption(database, "request-1")
    ).toMatchObject({
      status: "completed",
      resultCode: "reset",
      windowsReset: 2,
    });

    await database
      .delete(providerAccounts)
      .where(eq(providerAccounts.id, "codex-account"));
    expect(
      await findCodexResetCreditRedemption(database, "request-1")
    ).toBeUndefined();
  });
});
