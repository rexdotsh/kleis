import { createClient } from "@libsql/client";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { Database } from "../../src/db";
import {
  createApiKey,
  findActiveApiKeyByValue,
  findApiKeyById,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from "../../src/db/repositories/api-keys";
import * as schema from "../../src/db/schema";

let client: ReturnType<typeof createClient>;
let otherClient: ReturnType<typeof createClient>;
let database: Database;
let otherDatabase: Database;

beforeEach(async () => {
  client = createClient({ url: "file::memory:?cache=shared" });
  otherClient = createClient({ url: "file::memory:?cache=shared" });
  database = drizzle(client, { schema });
  otherDatabase = drizzle(otherClient, { schema });
  await migrate(database, { migrationsFolder: "./drizzle/migrations" });
  await database.delete(schema.apiKeys);
});

afterEach(() => {
  client.close();
  otherClient.close();
});

test("rotation preserves current scopes and expiry and invalidates a primed auth cache", async () => {
  const now = Date.now();
  const source = await createApiKey(
    database,
    {
      label: "fake-device",
      providerScopes: ["codex"],
      modelScopes: ["openai/fake-model"],
      accountScopes: ["fake-account"],
      expiresAt: now + 100_000,
    },
    now
  );
  await findActiveApiKeyByValue(database, source.key, now);
  const replacement = await rotateApiKey(database, source.id, now + 1);
  if (!replacement) throw new Error("Expected replacement key");
  expect(replacement).toMatchObject({
    label: source.label,
    providerScopes: source.providerScopes,
    modelScopes: source.modelScopes,
    accountScopes: source.accountScopes,
    expiresAt: source.expiresAt,
    revokedAt: null,
  });
  expect(replacement?.key).not.toBe(source.key);
  expect(replacement?.modelsDiscoveryToken).not.toBe(
    source.modelsDiscoveryToken
  );
  expect(
    await findActiveApiKeyByValue(database, source.key, now + 2)
  ).toBeNull();
  expect(
    await findActiveApiKeyByValue(database, replacement.key, now + 2)
  ).not.toBeNull();
});

test("a failed replacement insert rolls back both revocation and the single-successor guard", async () => {
  const now = Date.now();
  const source = await createApiKey(database, {}, now);
  await database.run(sql`CREATE TRIGGER fail_rotation BEFORE INSERT ON api_keys
    BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END`);
  try {
    await expect(rotateApiKey(database, source.id, now + 1)).rejects.toThrow();
    expect(await findApiKeyById(database, source.id)).toMatchObject({
      revokedAt: null,
    });
    expect(await listApiKeys(database)).toHaveLength(1);
  } finally {
    await database.run(sql`DROP TRIGGER fail_rotation`);
  }
  expect(await rotateApiKey(database, source.id, now + 2)).not.toBeNull();
});

test("concurrent rotations have one successor even when keeping the original key", async () => {
  for (const revokeOld of [true, false]) {
    const now = Date.now();
    const source = await createApiKey(database, {}, now);
    const results = await Promise.all([
      rotateApiKey(database, source.id, now + 1, revokeOld),
      rotateApiKey(otherDatabase, source.id, now + 1, revokeOld),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await findApiKeyById(database, source.id))?.revokedAt).toBe(
      revokeOld ? now + 1 : null
    );
  }
});

test("a concurrent revoke cannot create an extra successor or revoke the replacement", async () => {
  const now = Date.now();
  const source = await createApiKey(database, {}, now);
  const [replacement] = await Promise.all([
    rotateApiKey(database, source.id, now + 1),
    revokeApiKey(otherDatabase, source.id, now + 1),
  ]);
  expect(
    await findActiveApiKeyByValue(database, source.key, now + 2)
  ).toBeNull();
  if (replacement) {
    expect(
      await findActiveApiKeyByValue(database, replacement.key, now + 2)
    ).not.toBeNull();
  }
  expect(await listApiKeys(database)).toHaveLength(replacement ? 2 : 1);
  expect(await rotateApiKey(database, source.id, now + 2)).toBeNull();
});
