import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "../../src/db";
import {
  createLookupCache,
  invalidateLookupCaches,
} from "../../src/db/lookup-cache";
import {
  createApiKey,
  findActiveApiKeyByValue,
  revokeApiKey,
} from "../../src/db/repositories/api-keys";
import {
  setPrimaryProviderAccount,
  setProviderAccountsEnabled,
  upsertProviderAccount,
} from "../../src/db/repositories/provider-accounts";
import * as schema from "../../src/db/schema";
import { getRoutableProviderAccount } from "../../src/domain/providers/provider-service";

describe("proxy lookup caches", () => {
  let client: ReturnType<typeof createClient> | undefined;
  let database: Database;
  let directory: string;
  let queries = 0;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kleis-lookup-cache-"));
    client = createClient({ url: `file:${join(directory, "test.db")}` });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    queries = 0;
    const execute = client.execute.bind(client);
    client.execute = ((...args: Parameters<typeof execute>) => {
      queries++;
      return execute(...args);
    }) as typeof client.execute;
  });

  afterEach(async () => {
    client?.close();
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined
    );
  });

  const addAccount = (accountId: string, now: number) =>
    upsertProviderAccount(database, {
      provider: "codex",
      accountId,
      label: accountId,
      accessToken: `token-${accountId}`,
      refreshToken: "refresh",
      expiresAt: now + 3_600_000,
      metadata: {
        provider: "codex",
        chatgptAccountId: accountId,
        email: `${accountId}@example.com`,
      },
      now,
    });

  test("serves repeat API key lookups from memory until a key write", async () => {
    const now = Date.now();
    const key = await createApiKey(database, { label: "laptop" }, now);

    expect((await findActiveApiKeyByValue(database, key.key, now))?.id).toBe(
      key.id
    );
    const afterFirstLookup = queries;
    expect((await findActiveApiKeyByValue(database, key.key, now))?.id).toBe(
      key.id
    );
    expect(queries).toBe(afterFirstLookup);

    await revokeApiKey(database, key.id, now);
    expect(await findActiveApiKeyByValue(database, key.key, now)).toBeNull();
  });

  test("rejects a cached key once it expires", async () => {
    const now = Date.now();
    const key = await createApiKey(
      database,
      { label: "short", expiresAt: now + 1000 },
      now
    );

    expect(
      await findActiveApiKeyByValue(database, key.key, now)
    ).not.toBeNull();
    expect(
      await findActiveApiKeyByValue(database, key.key, now + 2000)
    ).toBeNull();
  });

  test("routes to the new primary account right after it changes", async () => {
    const now = Date.now();
    const first = await addAccount("first", now);
    const second = await addAccount("second", now);
    await setPrimaryProviderAccount(database, first.id);

    expect((await getRoutableProviderAccount(database, "codex", now))?.id).toBe(
      first.id
    );
    const afterFirstLookup = queries;
    expect((await getRoutableProviderAccount(database, "codex", now))?.id).toBe(
      first.id
    );
    expect(queries).toBe(afterFirstLookup);

    await setPrimaryProviderAccount(database, second.id);
    expect((await getRoutableProviderAccount(database, "codex", now))?.id).toBe(
      second.id
    );

    await setProviderAccountsEnabled(database, "codex", false, now);
    expect(await getRoutableProviderAccount(database, "codex", now)).toBeNull();
  });

  test("does not cache a lookup that finished after a write", async () => {
    const cache = createLookupCache<number>(60_000);
    const owner = {};
    let release: (() => void) | undefined;
    const slow = cache.get(
      owner,
      "key",
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(1);
        })
    );
    invalidateLookupCaches();
    release?.();
    expect(await slow).toBe(1);

    expect(await cache.get(owner, "key", () => Promise.resolve(2))).toBe(2);
  });
});
