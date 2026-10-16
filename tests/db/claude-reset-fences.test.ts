import { createClient } from "@libsql/client";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "../../src/db";
import {
  ClaudeResetReservationConflict,
  readClaudeResetClaimLedger,
  reserveClaudeResetClaim,
  settleClaudeResetClaim,
} from "../../src/db/repositories/claude-reset-claims";
import * as schema from "../../src/db/schema";
import { claudeResetClaims } from "../../src/db/schema";

let directory: string;
let clients: ReturnType<typeof createClient>[] = [];
let database: Database;
let other: Database;
const identity = {
  accountIdentity: "aaaaaaaa-0000-4000-8000-000000000001",
  organizationUuid: "cccccccc-0000-4000-8000-000000000001",
};
const claim = (requestId: string, at = 10) => ({
  ...identity,
  requestId,
  grantId: "preview_grant",
  createdAt: at,
  updatedAt: at,
});
const read = (db = database) => readClaudeResetClaimLedger(db, identity, 0);
const statuses = async () =>
  (await database.select().from(claudeResetClaims)).map(
    (row) => `${row.requestId}:${row.status}`
  );

// Two connections to one file stand in for two Kleis processes.
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kleis-claude-fence-db-"));
  const url = `file:${join(directory, "claims.db")}`;
  clients = [createClient({ url }), createClient({ url })];
  [database, other] = clients.map((client) => drizzle(client, { schema })) as [
    Database,
    Database,
  ];
  await migrate(database, { migrationsFolder: "./drizzle/migrations" });
});
afterEach(async () => {
  for (const client of clients) client.close();
  await rm(directory, { recursive: true, force: true });
});

test("a connection cannot reserve with a version another connection already used", async () => {
  const validated = await read(other);
  await reserveClaudeResetClaim(database, claim("a"), validated.version, null);
  await settleClaudeResetClaim(database, "a", "completed");
  await expect(
    reserveClaudeResetClaim(other, claim("b"), validated.version, null)
  ).rejects.toBeInstanceOf(ClaudeResetReservationConflict);
  expect((await read(other)).version).toBe(1);
  expect(await statuses()).toEqual(["a:completed"]);
});

test("a second open claim is refused and rolls back the version", async () => {
  await read();
  await reserveClaudeResetClaim(database, claim("a"), 0, null);
  await expect(
    reserveClaudeResetClaim(other, claim("b"), 1, null)
  ).rejects.toThrow();
  expect((await read()).version).toBe(1);
});

test("reopening or closing an open claim needs its exact record and the version", async () => {
  await read();
  await reserveClaudeResetClaim(database, claim("a"), 0, null);
  await settleClaudeResetClaim(database, "a", "ambiguous");
  const [row] = (await read()).claims;
  if (!row) throw new Error("claim missing");
  const stale = { requestId: "a", updatedAt: row.updatedAt - 1 };
  for (const next of [claim("a", 30), claim("b", 30)]) {
    await expect(
      reserveClaudeResetClaim(other, next, 1, stale)
    ).rejects.toBeInstanceOf(ClaudeResetReservationConflict);
    await expect(
      reserveClaudeResetClaim(other, next, 0, row)
    ).rejects.toBeInstanceOf(ClaudeResetReservationConflict);
  }
  expect((await read()).version).toBe(1);

  await reserveClaudeResetClaim(other, claim("a", 30), 1, row);
  expect(await statuses()).toEqual(["a:pending"]);
  await settleClaudeResetClaim(other, "a", "ambiguous");
  const [reopened] = (await read()).claims;
  if (!reopened) throw new Error("claim missing");
  await reserveClaudeResetClaim(database, claim("b", 50), 2, reopened);
  expect((await statuses()).sort()).toEqual(["a:reconciled", "b:pending"]);
});

test.each(["user", "organization"])(
  "a different canonical %s has an independent fence",
  async (different) => {
    await read();
    await reserveClaudeResetClaim(database, claim("a"), 0, null);
    const distinct = {
      ...identity,
      ...(different === "user"
        ? { accountIdentity: "bbbbbbbb-0000-4000-8000-000000000002" }
        : { organizationUuid: "dddddddd-0000-4000-8000-000000000002" }),
    };
    const ledger = await readClaudeResetClaimLedger(other, distinct, 0);
    await reserveClaudeResetClaim(
      other,
      { ...claim("b"), ...distinct },
      ledger.version,
      null
    );
    expect((await read()).version).toBe(1);
    expect(
      (await readClaudeResetClaimLedger(database, distinct, 0)).version
    ).toBe(1);
  }
);
