import { createClient } from "@libsql/client";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import { upsertProviderAccount } from "../../src/db/repositories/provider-accounts";
import * as schema from "../../src/db/schema";
import {
  CodexResetCreditConsumeError,
  redeemCodexResetCredit,
  listProviderAccountQuotas,
  setAccountSnapshotStore,
} from "../../src/domain/providers/provider-account-tracking";

test("a Codex redemption whose response was lost can be retried and replayed without spending twice", async () => {
  const anchor = createClient({ url: "file::memory:?cache=shared" });
  const client = createClient({ url: "file::memory:?cache=shared" });
  const database = drizzle(client, { schema });
  const originalFetch = globalThis.fetch;
  const spent = new Set<string>();
  try {
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    setAccountSnapshotStore(null);
    const now = Date.now();
    const account = await upsertProviderAccount(database, {
      provider: "codex",
      accountId: crypto.randomUUID(),
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: now + 3_600_000,
      metadata: null,
      now,
    });
    const alias = await upsertProviderAccount(database, {
      provider: "codex",
      accountId: null,
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: now + 3_600_000,
      metadata: {
        provider: "codex",
        chatgptAccountId: account.accountId,
        email: null,
      },
      now,
    });
    const requests: { redeem_request_id: string; credit_id: string }[] = [];
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/rate-limit-reset-credits/consume")) {
        const body = JSON.parse(String(init?.body)) as {
          redeem_request_id: string;
          credit_id: string;
        };
        requests.push(body);
        if (spent.has(body.redeem_request_id)) {
          return Response.json({ code: "already_redeemed", windows_reset: 1 });
        }
        spent.add(body.redeem_request_id);
        throw new Error("Response lost after consuming the credit");
      }
      if (path.endsWith("/rate-limit-reset-credits"))
        return Response.json({
          available_count: spent.size ? 1 : 2,
          credits: (spent.size ? ["C2"] : ["C1", "C2"]).map((id) => ({
            id,
            status: "available",
          })),
        });
      if (!init?.method || init.method === "GET") return Response.json({});
      throw new Error("Unexpected upstream mutation");
    }) as typeof fetch;
    const quota = (await listProviderAccountQuotas(database, [account])).get(
      account.id
    );
    const action =
      quota?.data.provider === "codex" ? quota.data.resetCreditAction : null;
    if (action?.kind !== "offer") throw new Error("Expected a confirmed offer");
    const lost = await redeemCodexResetCredit(database, account.id, {
      creditId: action.creditId,
      offerKey: action.offerKey,
    }).catch((error: unknown) => error);
    if (
      !(lost instanceof CodexResetCreditConsumeError) ||
      !lost.redeemRequestId
    )
      throw new Error("Expected an unconfirmed redemption");
    const retry = { redeemRequestId: lost.redeemRequestId };
    await listProviderAccountQuotas(database, [account]);
    await expect(
      redeemCodexResetCredit(database, account.id, {
        redeemRequestId: "fresh-id",
        creditId: "C2",
      })
    ).rejects.toMatchObject({
      status: 409,
      redeemRequestId: retry.redeemRequestId,
    });
    const recovered = await redeemCodexResetCredit(database, alias.id, {
      ...retry,
      creditId: "C2",
    });
    expect(recovered?.code).toBe("already_redeemed");
    globalThis.fetch = (() => {
      throw new Error("A settled replay must not contact the upstream");
    }) as typeof fetch;
    expect(await redeemCodexResetCredit(database, account.id, retry)).toEqual(
      recovered
    );
    expect(spent.size).toBe(1);
    expect(requests).toEqual([
      { redeem_request_id: retry.redeemRequestId, credit_id: "C1" },
      { redeem_request_id: retry.redeemRequestId, credit_id: "C1" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    client.close();
    anchor.close();
  }
});
