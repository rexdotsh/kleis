import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "../../src/db";
import { listProviderAccountDailyTokens } from "../../src/db/repositories/account-daily-tokens";
import { providerAccounts, requestUsageBuckets } from "../../src/db/schema";
import * as schema from "../../src/db/schema";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 15, 30);
const TODAY = Date.UTC(2026, 9, 14);

type BucketInput = {
  bucketStart: number;
  providerAccountId?: string;
  provider?: "claude" | "codex";
  apiKeyId?: string;
  model?: string;
  requestCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTotalTokens?: number | null;
  totalTokens?: number | null;
};

describe("account daily tokens", () => {
  let client: ReturnType<typeof createClient> | undefined;
  let database: Database;
  let databaseDirectory: string;

  const insertBucket = (input: BucketInput) =>
    database.insert(requestUsageBuckets).values({
      bucketStart: input.bucketStart,
      apiKeyId: input.apiKeyId ?? "key",
      providerAccountId: input.providerAccountId ?? "claude-a",
      provider: input.provider ?? "claude",
      endpoint: "messages",
      model: input.model ?? "claude-opus",
      requestCount: input.requestCount ?? 1,
      successCount: input.requestCount ?? 1,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      inputTotalTokens: input.inputTotalTokens ?? null,
      totalTokens: input.totalTokens ?? null,
      lastRequestAt: input.bucketStart,
    });

  beforeEach(async () => {
    databaseDirectory = await mkdtemp(join(tmpdir(), "kleis-daily-tokens-"));
    client = createClient({
      url: `file:${join(databaseDirectory, "test.db")}`,
    });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    const account = (id: string, provider: "claude" | "codex", at: number) => ({
      id,
      provider,
      accessToken: `access-${id}`,
      refreshToken: `refresh-${id}`,
      expiresAt: NOW + DAY_MS,
      createdAt: at,
      updatedAt: at,
    });
    await database
      .insert(providerAccounts)
      .values([
        account("claude-a", "claude", 1),
        account("claude-b", "claude", 2),
        account("codex-a", "codex", 3),
      ]);
  });

  afterEach(async () => {
    client?.close();
    await rm(databaseDirectory, { recursive: true, force: true }).catch(
      () => undefined
    );
  });

  test("groups by UTC day and fills days without traffic", async () => {
    await insertBucket({
      bucketStart: TODAY - 60_000,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    await insertBucket({
      bucketStart: TODAY,
      inputTokens: 20,
      outputTokens: 2,
      cacheReadTokens: 100,
      totalTokens: 122,
    });
    await insertBucket({
      bucketStart: TODAY + 15 * 60_000,
      apiKeyId: "other-key",
      model: "claude-sonnet",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    });

    const [account] = await listProviderAccountDailyTokens(database, {
      days: 30,
      now: NOW,
      accountIds: ["claude-a"],
    });

    expect(account?.daily).toHaveLength(30);
    expect(account?.daily[0]?.date).toBe("2026-09-15");
    expect(account?.daily[0]?.dayStart).toBe(TODAY - 29 * DAY_MS);
    expect(account?.daily.at(-1)).toMatchObject({
      date: "2026-10-14",
      dayStart: TODAY,
      requestCount: 2,
      inputTokens: 21,
      outputTokens: 3,
      cacheReadTokens: 100,
      totalTokens: 124,
    });
    expect(account?.daily.at(-2)).toMatchObject({
      date: "2026-10-13",
      requestCount: 1,
      totalTokens: 15,
    });
    expect(account?.daily.at(-3)).toMatchObject({
      date: "2026-10-12",
      requestCount: 0,
      totalTokens: 0,
    });
    expect(account?.totals).toMatchObject({
      requestCount: 3,
      totalTokens: 139,
      cacheReadTokens: 100,
    });
  });

  test("keeps only the requested window", async () => {
    const firstDay = TODAY - 29 * DAY_MS;
    await insertBucket({ bucketStart: firstDay - 60_000, totalTokens: 1000 });
    await insertBucket({ bucketStart: firstDay, totalTokens: 7 });
    await insertBucket({ bucketStart: TODAY + DAY_MS, totalTokens: 5000 });

    const [thirty] = await listProviderAccountDailyTokens(database, {
      days: 30,
      now: NOW,
      accountIds: ["claude-a"],
    });
    expect(thirty?.daily[0]?.totalTokens).toBe(7);
    expect(thirty?.totals.totalTokens).toBe(7);

    const [one] = await listProviderAccountDailyTokens(database, {
      days: 1,
      now: NOW,
      accountIds: ["claude-a"],
    });
    expect(one?.daily).toHaveLength(1);
    expect(one?.totals.totalTokens).toBe(0);
  });

  test("derives totals for historical rows without stored totals", async () => {
    await insertBucket({
      bucketStart: TODAY + 60_000,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
    });

    const [account] = await listProviderAccountDailyTokens(database, {
      days: 30,
      now: NOW,
      accountIds: ["claude-a"],
    });

    expect(account?.daily.at(-1)).toMatchObject({
      inputTokens: 10,
      inputTotalTokens: 15,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      totalTokens: 19,
    });
  });

  test("returns several accounts in one call and filters by provider", async () => {
    await insertBucket({ bucketStart: TODAY, totalTokens: 10 });
    await insertBucket({
      bucketStart: TODAY,
      providerAccountId: "claude-b",
      totalTokens: 20,
    });
    await insertBucket({
      bucketStart: TODAY,
      providerAccountId: "codex-a",
      provider: "codex",
      totalTokens: 30,
    });

    const all = await listProviderAccountDailyTokens(database, {
      days: 7,
      now: NOW,
    });
    expect(
      all.map((account) => [
        account.providerAccountId,
        account.totals.totalTokens,
      ])
    ).toEqual([
      ["claude-a", 10],
      ["claude-b", 20],
      ["codex-a", 30],
    ]);

    const claude = await listProviderAccountDailyTokens(database, {
      days: 7,
      now: NOW,
      provider: "claude",
    });
    expect(claude.map((account) => account.providerAccountId)).toEqual([
      "claude-a",
      "claude-b",
    ]);

    const picked = await listProviderAccountDailyTokens(database, {
      days: 7,
      now: NOW,
      accountIds: ["claude-b", "missing"],
    });
    expect(picked.map((account) => account.providerAccountId)).toEqual([
      "claude-b",
    ]);
    expect(picked[0]?.daily).toHaveLength(7);
  });
});
