import { createClient } from "@libsql/client";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import {
  createApiKey,
  findActiveApiKeyByValue,
  listApiKeys,
  rotateApiKey,
} from "../../src/db/repositories/api-keys";
import * as schema from "../../src/db/schema";

test("a rotation that fails midway keeps the old key active and adds no key", async () => {
  const client = createClient({ url: ":memory:" });
  const database = drizzle(client, { schema });
  try {
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    const now = Date.now();
    const old = await createApiKey(database, { label: "fake key" }, now);
    expect(
      await findActiveApiKeyByValue(database, old.key, now)
    ).not.toBeNull();
    await client.execute(
      "CREATE TRIGGER fail_insert BEFORE INSERT ON api_keys BEGIN SELECT RAISE(ABORT, 'insert failed'); END"
    );

    await expect(rotateApiKey(database, old, true, now + 1)).rejects.toThrow();

    expect(await listApiKeys(database)).toMatchObject([
      { id: old.id, revokedAt: null },
    ]);
    expect(
      await findActiveApiKeyByValue(database, old.key, now + 2)
    ).not.toBeNull();
  } finally {
    client.close();
  }
});
