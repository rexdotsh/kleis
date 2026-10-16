import { createClient } from "@libsql/client";
import { afterEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { Database } from "../../src/db";
import {
  buildRequestUsageRow,
  buildTokenUsageRow,
  recordRequestUsage,
  recordTokenUsage,
} from "../../src/db/repositories/request-usage";
import * as schema from "../../src/db/schema";
import { requestUsageBuckets } from "../../src/db/schema";
import { createUsageBuffer } from "../../src/usage/usage-buffer";

const anchor = Date.parse("2026-10-01T12:00:30Z");
const base = {
  apiKeyId: "key",
  providerAccountId: "account",
  provider: "claude" as const,
  endpoint: "messages" as const,
  model: "claude-opus-5-5",
};
const okRequest = {
  ...base,
  source: "upstream" as const,
  statusCode: 200,
  durationMs: 900,
  occurredAt: anchor,
};
const rateLimitedRequest = {
  ...base,
  source: "upstream" as const,
  statusCode: 429,
  durationMs: 120,
  occurredAt: anchor + 5000,
};
const failedRequest = {
  ...base,
  source: "proxy" as const,
  statusCode: 502,
  durationMs: 40,
  occurredAt: anchor + 70_000,
};
const requests = [okRequest, rateLimitedRequest, failedRequest];
const tokens = [
  {
    ...base,
    occurredAt: anchor,
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheWriteTokens: 5,
    },
  },
  {
    ...base,
    occurredAt: anchor + 6000,
    tokenUsage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      reasoningTokens: 7,
    },
  },
];

describe("usage buffer", () => {
  const clients: ReturnType<typeof createClient>[] = [];

  const openDatabase = async (): Promise<Database> => {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    return database;
  };

  const readBuckets = (database: Database) =>
    database
      .select()
      .from(requestUsageBuckets)
      .orderBy(requestUsageBuckets.bucketStart);

  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
  });

  test("writes the same buckets as recording each request directly", async () => {
    const direct = await openDatabase();
    for (const input of requests) await recordRequestUsage(direct, input);
    for (const input of tokens) await recordTokenUsage(direct, input);

    const buffered = await openDatabase();
    const buffer = createUsageBuffer(buffered, { flushIntervalMs: 60_000 });
    for (const input of requests) buffer.add(buildRequestUsageRow(input));
    for (const input of tokens) buffer.add(buildTokenUsageRow(input));
    expect(buffer.pendingRows()).toBe(2);
    await buffer.flush();

    expect(buffer.pendingRows()).toBe(0);
    expect(await readBuckets(buffered)).toEqual(await readBuckets(direct));
    expect((await readBuckets(buffered))[0]).toMatchObject({
      requestCount: 2,
      successCount: 1,
      rateLimitCount: 1,
      totalLatencyMs: 1020,
      maxLatencyMs: 900,
      inputTotalTokens: 323,
      reasoningTokens: 7,
    });
  });

  test("adds to buckets already in the database", async () => {
    const database = await openDatabase();
    await recordRequestUsage(database, okRequest);
    const buffer = createUsageBuffer(database, { flushIntervalMs: 60_000 });
    buffer.add(buildRequestUsageRow(rateLimitedRequest));
    await buffer.flush();

    expect((await readBuckets(database))[0]).toMatchObject({
      requestCount: 2,
      maxLatencyMs: 900,
      lastRequestAt: anchor + 5000,
    });
  });

  test("keeps rows from a failed flush for the next one", async () => {
    const database = await openDatabase();
    let failNextInsert = true;
    const flaky = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "insert" && failNextInsert) {
          failNextInsert = false;
          return () => {
            throw new Error("turso unavailable");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const buffer = createUsageBuffer(flaky, { flushIntervalMs: 60_000 });
    buffer.add(buildRequestUsageRow(okRequest));

    await buffer.flush();
    expect(buffer.pendingRows()).toBe(1);
    expect(await readBuckets(database)).toHaveLength(0);

    await buffer.flush();
    expect(buffer.pendingRows()).toBe(0);
    expect((await readBuckets(database))[0]?.requestCount).toBe(1);
  });
});
