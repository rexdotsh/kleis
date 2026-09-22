import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Database } from "../../src/db";
import {
  listApiKeyUsageSummaries,
  recordRequestUsage,
} from "../../src/db/repositories/request-usage";
import { requestUsageBuckets } from "../../src/db/schema";
import * as schema from "../../src/db/schema";

describe("request usage token accounting", () => {
  let client: ReturnType<typeof createClient> | undefined;
  let database: Database;
  let databaseDirectory: string;

  beforeEach(async () => {
    databaseDirectory = await mkdtemp("/tmp/opencode/kleis-request-usage-");
    client = createClient({
      url: `file:${join(databaseDirectory, "test.db")}`,
    });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
  });

  afterEach(async () => {
    client?.close();
    await rm(databaseDirectory, { recursive: true, force: true }).catch(
      () => undefined
    );
  });

  test("stores rich usage and derives totals for historical rows", async () => {
    const now = Date.now();
    await recordRequestUsage(database, {
      apiKeyId: "rich-key",
      providerAccountId: "codex-account",
      provider: "codex",
      endpoint: "responses",
      model: "gpt-5.6-sol",
      source: "upstream",
      statusCode: 200,
      durationMs: 25,
      occurredAt: now,
      tokenUsage: {
        inputTokens: 70,
        outputTokens: 20,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        reasoningTokens: 8,
        totalTokens: 120,
      },
    });
    await database.insert(requestUsageBuckets).values({
      bucketStart: now - (now % 60_000),
      apiKeyId: "legacy-key",
      providerAccountId: "codex-account",
      provider: "codex",
      endpoint: "responses",
      model: "gpt-5-codex",
      requestCount: 1,
      successCount: 1,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      lastRequestAt: now,
    });

    const summaries = await listApiKeyUsageSummaries(database, now - 60_000);
    const rich = summaries.find((summary) => summary.apiKeyId === "rich-key");
    const legacy = summaries.find(
      (summary) => summary.apiKeyId === "legacy-key"
    );

    expect(rich).toMatchObject({
      inputTokens: 70,
      inputTotalTokens: 100,
      outputTokens: 20,
      reasoningTokens: 8,
      totalTokens: 120,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
    });
    expect(legacy).toMatchObject({
      inputTokens: 10,
      inputTotalTokens: 15,
      outputTokens: 4,
      reasoningTokens: 0,
      totalTokens: 19,
    });
  });
});
