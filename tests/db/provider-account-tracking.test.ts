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
  findClaudeRateLimitSnapshot,
  findProviderAccountTracking,
  saveClaudeRateLimitSnapshot,
  saveProviderAccountTracking,
  upsertCodexThreadUsage,
} from "../../src/db/repositories/provider-account-tracking";
import { codexThreadUsage, providerAccounts } from "../../src/db/schema";
import * as schema from "../../src/db/schema";

describe("provider account tracking repository", () => {
  let client: ReturnType<typeof createClient> | undefined;
  let database: Database;
  let databaseDirectory: string;

  beforeEach(async () => {
    databaseDirectory = await mkdtemp(join(tmpdir(), "kleis-tracking-"));
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
    client?.close();
    await rm(databaseDirectory, { recursive: true, force: true }).catch(
      () => undefined
    );
  });

  test("upserts normalized snapshots and Claude response headers", async () => {
    const now = Date.now();
    await saveProviderAccountTracking(database, {
      providerAccountId: "codex-account",
      provider: "codex",
      attemptedAt: now,
      fetchedAt: now,
      nextFetchAt: now + 60_000,
      failureCount: 0,
      lastHttpStatus: null,
      lastError: null,
      data: {
        provider: "codex",
        status: {
          planType: "plus",
          allowed: true,
          limitReached: false,
          primaryWindow: null,
          secondaryWindow: null,
          credits: null,
          spendControl: null,
          additionalRateLimits: [],
          rateLimitReachedType: null,
          resetCreditsAvailable: 1,
        },
      },
    });
    const snapshot = await findProviderAccountTracking(
      database,
      "codex-account"
    );
    expect(snapshot?.data?.provider).toBe("codex");
    expect(snapshot?.failureCount).toBe(0);

    await saveClaudeRateLimitSnapshot(database, {
      providerAccountId: "codex-account",
      fetchedAt: now,
      sourceEndpoint: "messages",
      workspaceId: "workspace-1",
      data: { unified: { fiveHour: { utilization: 43 } } },
    });
    expect(
      (await findClaudeRateLimitSnapshot(database, "codex-account"))
        ?.workspaceId
    ).toBe("workspace-1");
  });

  test("updates authoritative thread usage and cascades account deletion", async () => {
    const now = Date.now();
    const entry = {
      threadId: "thread-1",
      estimatedUsageCreditsMicros: 100,
      estimatedUsageUsdMicros: 20,
      groups: [],
    };
    await upsertCodexThreadUsage(database, "codex-account", [entry], now);
    await upsertCodexThreadUsage(
      database,
      "codex-account",
      [{ ...entry, estimatedUsageCreditsMicros: 200 }],
      now + 1
    );
    const row = await database.query.codexThreadUsage.findFirst({
      where: eq(codexThreadUsage.threadId, "thread-1"),
    });
    expect(row?.estimatedUsageCreditsMicros).toBe(200);

    await database
      .delete(providerAccounts)
      .where(eq(providerAccounts.id, "codex-account"));
    expect(await database.select().from(codexThreadUsage)).toHaveLength(0);
  });
});
