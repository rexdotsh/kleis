import { createClient } from "@libsql/client";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import { upsertProviderAccount } from "../../src/db/repositories/provider-accounts";
import * as schema from "../../src/db/schema";
import {
  CodexResetCreditConsumeError,
  redeemCodexResetCredit,
  setAccountSnapshotStore,
} from "../../src/domain/providers/provider-account-tracking";

test("a Codex redemption whose response was lost can be retried and replayed without spending twice", async () => {
  const client = createClient({ url: ":memory:" });
  const database = drizzle(client, { schema });
  const originalFetch = globalThis.fetch;
  const spent = new Set<string>();
  try {
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    setAccountSnapshotStore(null);
    const now = Date.now();
    const account = await upsertProviderAccount(database, {
      provider: "codex",
      accountId: "preview-codex",
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: now + 3_600_000,
      metadata: null,
      now,
    });
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/rate-limit-reset-credits/consume")) {
        const body = JSON.parse(String(init?.body)) as {
          redeem_request_id: string;
        };
        if (spent.has(body.redeem_request_id)) {
          return Response.json({ code: "already_redeemed", windows_reset: 1 });
        }
        spent.add(body.redeem_request_id);
        throw new Error("Response lost after consuming the credit");
      }
      if (!init?.method || init.method === "GET") return Response.json({});
      throw new Error("Unexpected upstream mutation");
    }) as typeof fetch;
    const lost = await redeemCodexResetCredit(database, account.id, {
      creditId: "preview-credit",
    }).catch((error: unknown) => error);
    if (!(lost instanceof CodexResetCreditConsumeError))
      throw new Error("Expected an unconfirmed redemption");
    const retry = { redeemRequestId: lost.redeemRequestId };
    const recovered = await redeemCodexResetCredit(database, account.id, retry);
    expect(recovered?.code).toBe("already_redeemed");
    globalThis.fetch = (() => {
      throw new Error("A settled replay must not contact the upstream");
    }) as typeof fetch;
    expect(await redeemCodexResetCredit(database, account.id, retry)).toEqual(
      recovered
    );
    expect(spent.size).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    client.close();
  }
});
