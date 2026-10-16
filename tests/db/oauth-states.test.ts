import { createClient } from "@libsql/client";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { Database } from "../../src/db";
import {
  consumeOAuthState,
  createOAuthState,
} from "../../src/db/repositories/oauth-states";
import * as schema from "../../src/db/schema";

let client: ReturnType<typeof createClient>;
let database: Database;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => client.close());

test("an OAuth state can be consumed only once, including concurrent completion", async () => {
  const now = Date.now();
  await createOAuthState(database, {
    state: "pending",
    provider: "codex",
    pkceVerifier: "verifier",
    metadataJson: null,
    expiresAt: now + 60_000,
  });
  expect(
    await consumeOAuthState(database, "pending", "claude", now)
  ).toBeNull();
  const results = await Promise.all([
    consumeOAuthState(database, "pending", "codex", now),
    consumeOAuthState(database, "pending", "codex", now),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await consumeOAuthState(database, "pending", "codex", now)).toBeNull();
});

test("an expired OAuth state cannot authorize a connection", async () => {
  const now = Date.now();
  await createOAuthState(database, {
    state: "expired",
    provider: "claude",
    pkceVerifier: "verifier",
    metadataJson: null,
    expiresAt: now,
  });
  expect(
    await consumeOAuthState(database, "expired", "claude", now)
  ).toBeNull();
});
