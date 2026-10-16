import { createClient } from "@libsql/client";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as schema from "../../src/db/schema";
import {
  finishCodexResetCredit,
  readCodexResetCreditState,
  reserveCodexResetCredit,
  saveCodexResetCreditRedemption,
  settleCodexResetCredit,
} from "../../src/db/repositories/codex-reset-redemptions";

if (
  process.env.TURSO_CONNECTION_URL !== ":memory:" ||
  process.env.TURSO_AUTH_TOKEN
) {
  throw new Error(
    "Migration scenarios require an unauthenticated in-memory database"
  );
}

test("the generated upgrade preserves populated ledgers and safely reconciles duplicate legacy pending rows", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "kleis-ledger-upgrade-"));
  const anchor = createClient({ url: "file::memory:?cache=shared" });
  const client = createClient({ url: "file::memory:?cache=shared" });
  const database = drizzle(client, { schema });
  try {
    const journal = (await Bun.file(
      "./drizzle/migrations/meta/_journal.json"
    ).json()) as { entries: { idx: number; tag: string }[] };
    const entries = journal.entries.slice(
      0,
      journal.entries.findIndex((entry) =>
        entry.tag.endsWith("_server_side_guards")
      )
    );
    await mkdir(join(fixture, "meta"));
    await Bun.write(
      join(fixture, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries })
    );
    for (const entry of entries)
      await copyFile(
        `./drizzle/migrations/${entry.tag}.sql`,
        join(fixture, `${entry.tag}.sql`)
      );
    await migrate(database, { migrationsFolder: fixture });
    const now = Date.now();
    await client.execute({
      sql: "INSERT INTO provider_accounts (id, provider, account_id, access_token, refresh_token, expires_at, created_at, updated_at) VALUES (?, 'codex', ?, ?, ?, ?, ?, ?)",
      args: [
        "local-account",
        "canonical-identity",
        "fake-access",
        "fake-refresh",
        now + 3_600_000,
        now,
        now,
      ],
    });
    const legacyRows = [
      ["pending-1", "pending", null],
      ["pending-2", "pending", null],
      ["settled", "completed", "reset"],
    ] as const;
    for (const [id, status, result] of legacyRows) {
      await client.execute({
        sql: "INSERT INTO codex_reset_credit_redemptions (redeem_request_id, provider_account_id, credit_id, status, result_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [id, "local-account", id, status, result, now, now],
      });
    }
    await client.execute({
      sql: "INSERT INTO api_keys (id, key, created_at) VALUES (?, ?, ?)",
      args: ["legacy-key", "kleis_fake_migration_key", now],
    });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    const rows = await database
      .select()
      .from(schema.codexResetCreditRedemptions);
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (row) => row.accountIdentity === null && row.executionToken === null
      )
    ).toBe(true);
    expect(
      rows.find((row) => row.redeemRequestId === "settled")?.resultCode
    ).toBe("reset");
    expect((await database.select().from(schema.apiKeys))[0]).toMatchObject({
      key: "kleis_fake_migration_key",
      rotatedToId: null,
    });
    const input = {
      accountIdentity: "canonical-identity",
      providerAccountId: "local-account",
      creditId: "replacement-credit",
      offerGeneration: 0,
      now,
    };
    await expect(
      reserveCodexResetCredit(database, {
        ...input,
        redeemRequestId: "fresh-id",
      })
    ).rejects.toMatchObject({ redeemRequestId: "pending-1" });
    for (const id of ["pending-1", "pending-2"]) {
      const reserved = await reserveCodexResetCredit(database, {
        ...input,
        offerGeneration: (
          await readCodexResetCreditState(database, input.accountIdentity)
        ).generation,
        recovery: "spend",
        redeemRequestId: id,
      });
      if (!reserved.reservation)
        throw new Error(
          "Expected an original legacy request to be recoverable"
        );
      expect(reserved.reservation.creditId).toBe(id);
      await expect(
        saveCodexResetCreditRedemption(database, {
          ...reserved.reservation,
          redeemRequestId: "competing-id",
        })
      ).rejects.toThrow();
      await settleCodexResetCredit(
        database,
        reserved.reservation,
        {
          status: "completed",
          resultCode: "already_redeemed",
          windowsReset: 2,
          lastError: null,
        },
        now + 1
      );
      expect(
        (await readCodexResetCreditState(database, input.accountIdentity))
          .pending?.redeemRequestId
      ).toBe(id);
      await finishCodexResetCredit(database, reserved.reservation);
    }
    const state = await readCodexResetCreditState(
      database,
      input.accountIdentity
    );
    expect(state.pending).toBeNull();
    expect(
      await reserveCodexResetCredit(database, {
        ...input,
        offerGeneration: state.generation,
        redeemRequestId: "deliberate-new",
      })
    ).toHaveProperty("reservation");
  } finally {
    client.close();
    anchor.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
