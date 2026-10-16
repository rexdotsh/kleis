import { createClient } from "@libsql/client";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Database } from "../../src/db";
import {
  ClaudeResetReservationConflict,
  insertClaudeResetClaim,
  readClaudeResetClaimLedger,
  reopenClaudeResetClaim,
  settleClaudeResetClaim,
} from "../../src/db/repositories/claude-reset-claims";
import * as schema from "../../src/db/schema";
import { claudeResetClaims, providerAccounts } from "../../src/db/schema";

let directory: string;
let clients: ReturnType<typeof createClient>[];
let database: Database;
let other: Database;
const originalFetch = globalThis.fetch;
const identity = {
  accountIdentity: "aaaaaaaa-0000-4000-8000-000000000001",
  organizationUuid: "cccccccc-0000-4000-8000-000000000001",
};
const claim = (requestId: string) => ({
  ...identity,
  requestId,
  providerAccountId: "preview-account",
  program: "cedar_ember",
  grantId: "preview_grant",
  offerKey: "preview-confirmed-offer",
  status: "pending" as const,
  createdAt: 10,
  updatedAt: 10,
});
const read = (db = database) => readClaudeResetClaimLedger(db, identity, 0);

beforeEach(async () => {
  globalThis.fetch = (() => {
    throw new Error("Network access is forbidden in fence tests");
  }) as typeof fetch;
  directory = await mkdtemp("/tmp/opencode/claude-fence-db-");
  clients = [0, 1].map(() =>
    createClient({ url: `file:${join(directory, "claims.db")}` })
  );
  const first = clients[0];
  const second = clients[1];
  if (!first || !second) throw new Error("Test clients missing");
  database = drizzle(first, { schema });
  other = drizzle(second, { schema });
  await migrate(database, { migrationsFolder: "./drizzle/migrations" });
  await database.insert(providerAccounts).values({
    id: "preview-account",
    provider: "claude",
    accessToken: "fake-access",
    refreshToken: "fake-refresh",
    expiresAt: 100,
    createdAt: 1,
    updatedAt: 1,
  });
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const client of clients) client.close();
  await rm(directory, { recursive: true, force: true });
});

test("a second database connection cannot reserve the version already completed by the first", async () => {
  const validated = await read(other);
  await insertClaudeResetClaim(
    database,
    claim("request-a"),
    null,
    validated.version
  );
  await settleClaudeResetClaim(database, "request-a", {
    status: "completed",
    result: "reset",
    updatedAt: 20,
  });
  await expect(
    insertClaudeResetClaim(other, claim("request-b"), null, validated.version)
  ).rejects.toBeInstanceOf(ClaudeResetReservationConflict);
  expect((await read(other)).version).toBe(1);
  expect((await other.select().from(claudeResetClaims)).length).toBe(1);
});

test("an active-index failure rolls back the fence increment", async () => {
  await read();
  await insertClaudeResetClaim(database, claim("request-a"), null, 0);
  await expect(
    insertClaudeResetClaim(other, claim("request-b"), null, 1)
  ).rejects.toThrow();
  expect((await read()).version).toBe(1);
});

test("closing and reopening require both the canonical version and the exact ledger record", async () => {
  await read();
  await insertClaudeResetClaim(database, claim("request-a"), null, 0);
  await settleClaudeResetClaim(database, "request-a", {
    status: "ambiguous",
    updatedAt: 20,
  });
  const reopen = {
    ...identity,
    requestId: "request-a",
    offerKey: "reconfirmed",
    updatedAt: 19,
  };
  await expect(
    reopenClaudeResetClaim(other, reopen, 30, 1)
  ).rejects.toBeInstanceOf(ClaudeResetReservationConflict);
  expect((await read()).version).toBe(1);
  await expect(
    insertClaudeResetClaim(
      other,
      claim("request-b"),
      { requestId: "request-a", updatedAt: 19 },
      1
    )
  ).rejects.toBeInstanceOf(ClaudeResetReservationConflict);
  expect((await read()).version).toBe(1);
  await reopenClaudeResetClaim(other, { ...reopen, updatedAt: 20 }, 30, 1);
  await settleClaudeResetClaim(other, "request-a", {
    status: "completed",
    result: "already_used",
    updatedAt: 40,
  });
  await expect(
    reopenClaudeResetClaim(database, { ...reopen, updatedAt: 20 }, 50, 1)
  ).rejects.toBeInstanceOf(ClaudeResetReservationConflict);
  expect((await read()).version).toBe(2);
  expect(
    (await database.select().from(claudeResetClaims)).map(
      (row) => row.requestId
    )
  ).toEqual(["request-a"]);
});

test("deleting a local row retains the canonical claim and fence", async () => {
  await read();
  await insertClaudeResetClaim(database, claim("request-a"), null, 0);
  await database
    .delete(providerAccounts)
    .where(eq(providerAccounts.id, "preview-account"));
  const ledger = await read(other);
  expect(ledger.version).toBe(1);
  expect(ledger.claims).toMatchObject([
    { providerAccountId: null, status: "pending" },
  ]);
});

test.each(["user", "organization"])(
  "a different canonical %s has an independent fence",
  async (different) => {
    await read();
    await insertClaudeResetClaim(database, claim("request-a"), null, 0);
    const distinct = {
      ...identity,
      ...(different === "user"
        ? { accountIdentity: "bbbbbbbb-0000-4000-8000-000000000002" }
        : { organizationUuid: "dddddddd-0000-4000-8000-000000000002" }),
    };
    const ledger = await readClaudeResetClaimLedger(other, distinct, 0);
    await insertClaudeResetClaim(
      other,
      { ...claim("request-b"), ...distinct },
      null,
      ledger.version
    );
    expect((await read()).version).toBe(1);
    expect(
      (await readClaudeResetClaimLedger(database, distinct, 0)).version
    ).toBe(1);
  }
);
