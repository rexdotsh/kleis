import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { Database } from "../../src/db";
import {
  findCodexResetCreditRedemption,
  saveCodexResetCreditRedemption,
} from "../../src/db/repositories/codex-reset-redemptions";
import { providerAccounts } from "../../src/db/schema";
import * as schema from "../../src/db/schema";
import { redeemCodexResetCredit } from "../../src/domain/providers/provider-account-tracking";

describe("Codex reset-credit redemptions", () => {
  let client: ReturnType<typeof createClient>;
  let database: Database;

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    const now = Date.now();
    await database.insert(providerAccounts).values(
      ["codex-account", "other-account"].map((id) => ({
        id,
        provider: "codex",
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: now + 3_600_000,
        createdAt: now,
        updatedAt: now,
      }))
    );
  });

  afterEach(() => {
    client.close();
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

  test("a completed redemption is replayed only for its original account, without another spend", async () => {
    const now = Date.now();
    await saveCodexResetCreditRedemption(database, {
      redeemRequestId: "completed-request",
      providerAccountId: "codex-account",
      creditId: "credit-1",
      status: "completed",
      resultCode: "reset",
      windowsReset: 2,
      createdAt: now,
      updatedAt: now,
    });
    const original = globalThis.fetch;
    let upstreamCalls = 0;
    globalThis.fetch = (() => {
      upstreamCalls++;
      throw new Error("A completed redemption must not reach upstream");
    }) as typeof fetch;
    try {
      const input = { redeemRequestId: "completed-request" };
      expect(
        await redeemCodexResetCredit(database, "codex-account", input)
      ).toEqual({
        redeemRequestId: "completed-request",
        code: "reset",
        windowsReset: 2,
      });
      await expect(
        redeemCodexResetCredit(database, "other-account", input)
      ).rejects.toThrow("another account");
      expect(upstreamCalls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
