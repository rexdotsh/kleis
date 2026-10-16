import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import type { Database } from "../../src/db";
import {
  findCodexResetCreditRedemption,
  reserveCodexResetCredit,
  saveCodexResetCreditRedemption,
  settleCodexResetCredit,
  finishCodexResetCredit,
  readCodexResetCreditState,
} from "../../src/db/repositories/codex-reset-redemptions";
import {
  deleteProviderAccount,
  findProviderAccountById,
  updateProviderAccountProfile,
  updateProviderAccountTokens,
  upsertProviderAccount,
} from "../../src/db/repositories/provider-accounts";
import { providerAccounts } from "../../src/db/schema";
import * as schema from "../../src/db/schema";
import {
  listProviderAccountQuotas,
  recordProviderAccountLiveLimits,
  redeemCodexResetCredit,
} from "../../src/domain/providers/provider-account-tracking";
import { readCodexLiveLimits } from "../../src/providers/account-tracking/live-limits";

describe("Codex reset-credit redemptions", () => {
  let client: ReturnType<typeof createClient>;
  let otherClient: ReturnType<typeof createClient>;
  let database: Database;
  let otherDatabase: Database;
  let accountIdentity: string;

  const quotaResponse = (ids = ["credit-1", "credit-2"]) =>
    Response.json({
      available_count: ids.length,
      credits: ids.map((id) => ({ id, status: "available", title: id })),
    });
  const offer = async (id = "codex-account") => {
    const account = await findProviderAccountById(database, id);
    if (!account) throw new Error("Expected fixture account");
    const quota = (await listProviderAccountQuotas(database, [account])).get(
      account.id
    );
    const action =
      quota?.data.provider === "codex" ? quota.data.resetCreditAction : null;
    if (action?.kind !== "offer")
      throw new Error("Expected a confirmed credit offer");
    return { creditId: action.creditId, offerKey: action.offerKey };
  };

  beforeEach(async () => {
    client = createClient({ url: "file::memory:?cache=shared" });
    otherClient = createClient({ url: "file::memory:?cache=shared" });
    database = drizzle(client, { schema });
    otherDatabase = drizzle(otherClient, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    await database.delete(schema.codexResetCreditRedemptions);
    await database.delete(schema.codexResetCreditFences);
    await database.delete(providerAccounts);
    const now = Date.now();
    accountIdentity = crypto.randomUUID();
    await database.insert(providerAccounts).values(
      ["codex-account", "other-account", "different-account"].map((id) => ({
        id,
        provider: "codex",
        accountId:
          id === "codex-account"
            ? accountIdentity
            : id === "different-account"
              ? "different-identity"
              : null,
        metadataJson: JSON.stringify({
          provider: "codex",
          chatgptAccountId:
            id === "different-account" ? "different-identity" : accountIdentity,
          email: null,
        }),
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: now + 3_600_000,
        createdAt: now,
        updatedAt: now,
      }))
    );
  });

  afterEach(async () => {
    await database.delete(schema.codexResetCreditRedemptions);
    await database.delete(schema.codexResetCreditFences);
    client.close();
    otherClient.close();
  });

  test("keeps a redemption result when its local provider account is deleted", async () => {
    const now = Date.now();
    const pending = {
      redeemRequestId: "request-1",
      providerAccountId: "codex-account",
      creditId: "credit-1",
      status: "pending",
      resultCode: null,
      windowsReset: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await saveCodexResetCreditRedemption(database, pending);
    await saveCodexResetCreditRedemption(database, {
      ...pending,
      status: "completed",
      resultCode: "reset",
      windowsReset: 2,
      updatedAt: now + 1,
    });
    expect(
      await findCodexResetCreditRedemption(database, "request-1")
    ).toMatchObject({
      status: "completed",
      resultCode: "reset",
      windowsReset: 2,
    });

    await database
      .delete(providerAccounts)
      .where(eq(providerAccounts.id, "codex-account"));
    expect(
      await findCodexResetCreditRedemption(database, "request-1")
    ).toMatchObject({ status: "completed", resultCode: "reset" });
  });

  test("a completed redemption is replayed only for its original Codex identity, without another spend", async () => {
    const now = Date.now();
    await saveCodexResetCreditRedemption(database, {
      redeemRequestId: "completed-request",
      providerAccountId: "codex-account",
      creditId: "credit-1",
      status: "completed",
      resultCode: "reset",
      windowsReset: 2,
      createdAt: now,
      updatedAt: now,
    });
    const original = globalThis.fetch;
    let upstreamCalls = 0;
    globalThis.fetch = (() => {
      upstreamCalls++;
      throw new Error("A completed redemption must not reach upstream");
    }) as typeof fetch;
    try {
      const input = { redeemRequestId: "completed-request" };
      expect(
        await redeemCodexResetCredit(database, "codex-account", input)
      ).toEqual({
        redeemRequestId: "completed-request",
        code: "reset",
        windowsReset: 2,
      });
      await expect(
        redeemCodexResetCredit(database, "different-account", input)
      ).rejects.toThrow("another account");
      expect(upstreamCalls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("one open redemption fences distinct requests and duplicate local identities across connections", async () => {
    const original = globalThis.fetch;
    let finish!: () => void;
    let started!: () => void;
    const sent = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let spends = 0;
    globalThis.fetch = (async (url) => {
      if (!String(url).endsWith("/consume")) return quotaResponse();
      spends++;
      started();
      if (spends === 1) await held;
      return Response.json({ code: "nothing_to_reset" });
    }) as typeof fetch;
    let first: ReturnType<typeof redeemCodexResetCredit> | undefined;
    try {
      const confirmed = await offer();
      first = redeemCodexResetCredit(database, "codex-account", {
        redeemRequestId: "first",
        ...confirmed,
      });
      await sent;
      for (const accountId of ["codex-account", "other-account"]) {
        await expect(
          redeemCodexResetCredit(otherDatabase, accountId, {
            redeemRequestId: "second",
          })
        ).rejects.toMatchObject({ status: 409, redeemRequestId: "first" });
      }
      await expect(
        redeemCodexResetCredit(otherDatabase, "codex-account", {
          redeemRequestId: "first",
        })
      ).rejects.toMatchObject({ status: 409, redeemRequestId: "first" });
      expect(spends).toBe(1);
      finish();
      await first;
    } finally {
      finish();
      await first;
      globalThis.fetch = original;
    }
  });

  test("an original-ID retry that could spend an available credit requires the current early-use confirmation", async () => {
    const original = globalThis.fetch;
    let percent = 100;
    const requests: unknown[] = [];
    globalThis.fetch = (async (url, init) => {
      if (init?.body) {
        requests.push(JSON.parse(String(init.body)));
        return requests.length === 1
          ? Response.json({}, { status: 503 })
          : Response.json({ code: "reset" });
      }
      if (String(url).endsWith("/usage"))
        return Response.json({
          rate_limit: {
            primary_window: {
              used_percent: percent,
              limit_window_seconds: 18000,
            },
          },
        });
      return quotaResponse();
    }) as typeof fetch;
    try {
      const confirmed = await offer();
      await expect(
        redeemCodexResetCredit(database, "codex-account", {
          ...confirmed,
          redeemRequestId: "R1",
        })
      ).rejects.toMatchObject({ redeemRequestId: "R1" });
      percent = 10;
      const account = await findProviderAccountById(database, "codex-account");
      if (!account) throw new Error("Expected fixture account");
      await listProviderAccountQuotas(database, [account]);
      await expect(
        redeemCodexResetCredit(otherDatabase, account.id, {
          redeemRequestId: "R1",
        })
      ).rejects.toMatchObject({ status: 409, redeemRequestId: "R1" });
      expect(requests).toHaveLength(1);
      const quota = (await listProviderAccountQuotas(database, [account])).get(
        account.id
      );
      const action =
        quota?.data.provider === "codex" ? quota.data.resetCreditAction : null;
      expect(action).toMatchObject({
        kind: "pending",
        creditId: "credit-1",
        redeemRequestId: "R1",
        recovery: { mode: "spend", earlyUse: { percentUsed: 10 } },
      });
      if (action?.kind !== "pending" || !action.recovery)
        throw new Error("Expected current retry confirmation");
      await redeemCodexResetCredit(otherDatabase, account.id, {
        redeemRequestId: "R1",
        creditId: "credit-2",
        offerKey: action.recovery.offerKey,
      });
      expect(requests).toEqual([
        { redeem_request_id: "R1", credit_id: "credit-1" },
        { redeem_request_id: "R1", credit_id: "credit-1" },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test.each(["delete", "change"] as const)(
    "legacy pending identities survive a local account %s and reconnect",
    async (operation) => {
      const now = Date.now();
      await saveCodexResetCreditRedemption(database, {
        redeemRequestId: "legacy-R1",
        providerAccountId: "codex-account",
        creditId: "credit-1",
        status: "retryable",
        createdAt: now,
        updatedAt: now,
      });
      await saveCodexResetCreditRedemption(database, {
        redeemRequestId: "legacy-duplicate",
        providerAccountId: "codex-account",
        creditId: "credit-0",
        status: "pending",
        createdAt: now + 1,
        updatedAt: now,
      });
      if (operation === "delete")
        await deleteProviderAccount(database, "codex-account");
      else
        await updateProviderAccountProfile(database, "codex-account", {
          accountId: "replacement-identity",
          metadata: {
            provider: "codex",
            chatgptAccountId: "replacement-identity",
            email: null,
          },
          label: null,
          now,
        });
      const reconnected = await upsertProviderAccount(database, {
        provider: "codex",
        accountId: accountIdentity,
        accessToken: "fake-access",
        refreshToken: "fake-refresh",
        expiresAt: now + 3_600_000,
        metadata: null,
        now,
      });
      const state = await readCodexResetCreditState(database, accountIdentity);
      expect(state.pending).toMatchObject({
        redeemRequestId: "legacy-R1",
        accountIdentity,
      });
      expect(
        (await findCodexResetCreditRedemption(database, "legacy-duplicate"))
          ?.accountIdentity
      ).toBe(accountIdentity);
      await expect(
        reserveCodexResetCredit(otherDatabase, {
          providerAccountId: reconnected.id,
          accountIdentity,
          redeemRequestId: "fresh-R2",
          creditId: "credit-2",
          offerGeneration: state.generation,
          now,
        })
      ).rejects.toMatchObject({ redeemRequestId: "legacy-R1" });
    }
  );

  test.each([400, 403, 404, 409, 410, 422, 429])(
    "a definitive HTTP %s refusal closes the original attempt and allows the next confirmed credit",
    async (status) => {
      const original = globalThis.fetch;
      const requests: unknown[] = [];
      globalThis.fetch = (async (_url, init) => {
        if (!init?.body)
          return quotaResponse(requests.length ? ["credit-2"] : undefined);
        requests.push(JSON.parse(String(init.body)));
        return requests.length === 1
          ? Response.json({}, { status })
          : Response.json({ code: "reset" });
      }) as typeof fetch;
      try {
        const confirmed = await offer();
        await expect(
          redeemCodexResetCredit(database, "codex-account", {
            ...confirmed,
            redeemRequestId: "rejected-R1",
          })
        ).rejects.toMatchObject({ status: 409, redeemRequestId: null });
        expect(
          (await readCodexResetCreditState(database, accountIdentity)).pending
        ).toBeNull();
        const next = await offer();
        await redeemCodexResetCredit(database, "codex-account", {
          ...next,
          redeemRequestId: "confirmed-R2",
        });
        expect(requests).toEqual([
          { redeem_request_id: "rejected-R1", credit_id: "credit-1" },
          { redeem_request_id: "confirmed-R2", credit_id: "credit-2" },
        ]);
      } finally {
        globalThis.fetch = original;
      }
    }
  );

  test("a stale recovery confirmation never sends until a fresh original-credit warning is approved", async () => {
    const original = globalThis.fetch;
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    let posts = 0;
    globalThis.fetch = (async (_url, init) => {
      if (!init?.body) return quotaResponse();
      posts++;
      return posts === 1
        ? Response.json({}, { status: 503 })
        : Response.json({ code: "reset" });
    }) as typeof fetch;
    try {
      const confirmed = await offer();
      await expect(
        redeemCodexResetCredit(database, "codex-account", {
          ...confirmed,
          redeemRequestId: "R1-stale",
        })
      ).rejects.toMatchObject({ redeemRequestId: "R1-stale" });
      const account = await findProviderAccountById(database, "codex-account");
      if (!account) throw new Error("Expected fixture account");
      const quota = (await listProviderAccountQuotas(database, [account])).get(
        account.id
      );
      const action =
        quota?.data.provider === "codex" ? quota.data.resetCreditAction : null;
      if (action?.kind !== "pending" || !action.recovery)
        throw new Error("Expected recovery offer");
      clock.mockReturnValue(now + 600_001);
      recordProviderAccountLiveLimits(
        account,
        readCodexLiveLimits(
          new Headers({ "x-codex-primary-used-percent": "10" })
        )
      );
      await expect(
        redeemCodexResetCredit(database, account.id, {
          redeemRequestId: "R1-stale",
          offerKey: action.recovery.offerKey,
        })
      ).rejects.toMatchObject({ status: 409, redeemRequestId: "R1-stale" });
      expect(posts).toBe(1);
      const refreshed = (
        await listProviderAccountQuotas(database, [account])
      ).get(account.id);
      const next =
        refreshed?.data.provider === "codex"
          ? refreshed.data.resetCreditAction
          : null;
      if (next?.kind !== "pending" || !next.recovery)
        throw new Error("Expected fresh recovery");
      await redeemCodexResetCredit(database, account.id, {
        redeemRequestId: "R1-stale",
        offerKey: next.recovery.offerKey,
      });
      expect(posts).toBe(2);
    } finally {
      clock.mockRestore();
      globalThis.fetch = original;
    }
  });

  test("an unresolvable legacy record blocks deletion and fresh spending until the owner explicitly reviews it without a spend", async () => {
    const original = globalThis.fetch;
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    await database
      .update(providerAccounts)
      .set({ accountId: null, metadataJson: null })
      .where(eq(providerAccounts.id, "codex-account"));
    await saveCodexResetCreditRedemption(database, {
      redeemRequestId: "unverified-R1",
      providerAccountId: "codex-account",
      creditId: null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    let posts = 0;
    globalThis.fetch = (async (_url, init) => {
      if (init?.body) {
        posts++;
        throw new Error("Legacy review cannot spend");
      }
      return quotaResponse();
    }) as typeof fetch;
    try {
      await expect(
        deleteProviderAccount(database, "codex-account")
      ).rejects.toThrow("older reset has no verified login identity");
      expect(
        await findProviderAccountById(database, "codex-account")
      ).not.toBeNull();
      clock.mockReturnValue(now + 120_001);
      const verified = await findProviderAccountById(database, "other-account");
      if (!verified) throw new Error("Expected verified alias");
      const quota = (await listProviderAccountQuotas(database, [verified])).get(
        verified.id
      );
      const action =
        quota?.data.provider === "codex" ? quota.data.resetCreditAction : null;
      expect(action).toMatchObject({
        kind: "pending",
        identityUnverified: true,
        recovery: { mode: "review" },
      });
      if (action?.kind !== "pending" || !action.recovery)
        throw new Error("Expected owner review");
      await expect(
        redeemCodexResetCredit(database, verified.id, {
          redeemRequestId: "fresh-R2",
        })
      ).rejects.toMatchObject({
        status: 409,
        redeemRequestId: "unverified-R1",
      });
      await expect(
        redeemCodexResetCredit(database, verified.id, {
          redeemRequestId: "unverified-R1",
        })
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await redeemCodexResetCredit(database, verified.id, {
          redeemRequestId: "unverified-R1",
          offerKey: action.recovery.offerKey,
        })
      ).toMatchObject({ code: "reconciled" });
      expect(posts).toBe(0);
      expect(
        (await readCodexResetCreditState(database, accountIdentity)).pending
      ).toBeNull();
      expect(await deleteProviderAccount(database, "codex-account")).toBe(true);
    } finally {
      clock.mockRestore();
      globalThis.fetch = original;
    }
  });

  test("a rejected credential writer cannot attach an unverified legacy claim to its proposed login", async () => {
    const now = Date.now();
    await database
      .update(providerAccounts)
      .set({ accountId: null, metadataJson: null })
      .where(eq(providerAccounts.id, "codex-account"));
    await saveCodexResetCreditRedemption(database, {
      redeemRequestId: "unbound-CAS",
      providerAccountId: "codex-account",
      creditId: null,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    expect(
      await updateProviderAccountTokens(database, "codex-account", {
        accessToken: "losing-access",
        refreshToken: "losing-refresh",
        expectedRefreshToken: "stale-refresh",
        expiresAt: now + 3_600_000,
        lastRefreshStatus: "success",
        accountId: "wrong-login",
        now,
      })
    ).toBeNull();
    expect(
      await findCodexResetCreditRedemption(database, "unbound-CAS")
    ).toMatchObject({ accountIdentity: null, status: "pending" });
  });

  test("a fresh ID cannot spend again while a successful reset is still refreshing quotas", async () => {
    const original = globalThis.fetch;
    let release!: () => void;
    let refreshing!: () => void;
    let secondPost!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
      refreshing = resolve;
    });
    const anotherSpend = new Promise<void>((resolve) => {
      secondPost = resolve;
    });
    let spends = 0;
    globalThis.fetch = (async (url) => {
      if (String(url).endsWith("/consume")) {
        spends++;
        if (spends === 2) secondPost();
        return Response.json({ code: "reset", windows_reset: 2 });
      }
      if (!spends) return quotaResponse();
      refreshing();
      await held;
      return Response.json({ available_count: 0, credits: [] });
    }) as typeof fetch;
    let first: ReturnType<typeof redeemCodexResetCredit> | undefined;
    let retry: Promise<unknown> | undefined;
    try {
      const confirmed = await offer();
      first = redeemCodexResetCredit(database, "codex-account", {
        redeemRequestId: "first-success",
        ...confirmed,
      });
      await refreshStarted;
      retry = redeemCodexResetCredit(otherDatabase, "codex-account", {
        redeemRequestId: "fresh-id",
      }).catch((error: unknown) => error);
      await Promise.race([retry, anotherSpend]);
      expect(spends).toBe(1);
      expect(await retry).toMatchObject({
        status: 409,
        redeemRequestId: "first-success",
      });
    } finally {
      release();
      await Promise.allSettled([first, retry]);
      globalThis.fetch = original;
    }
  });

  test("a settled spend invalidates stale offers across local rows but a newly read credit can be deliberately spent", async () => {
    const original = globalThis.fetch;
    let credits = ["credit-1", "credit-2"];
    const requests: unknown[] = [];
    globalThis.fetch = (async (_url, init) => {
      if (!init?.body) return quotaResponse(credits);
      const body = JSON.parse(String(init.body)) as { credit_id: string };
      requests.push(body);
      credits = credits.filter((id) => id !== body.credit_id);
      return Response.json({ code: "reset" });
    }) as typeof fetch;
    try {
      const confirmed = await offer();
      const staleAlias = await offer("other-account");
      await redeemCodexResetCredit(database, "codex-account", {
        ...confirmed,
        redeemRequestId: "first",
      });
      for (const input of [staleAlias, {}]) {
        await expect(
          redeemCodexResetCredit(otherDatabase, "other-account", {
            ...input,
            redeemRequestId: "stale-id",
          })
        ).rejects.toMatchObject({ status: 409, redeemRequestId: null });
      }
      const next = await offer();
      await redeemCodexResetCredit(database, "codex-account", {
        ...next,
        redeemRequestId: "deliberate-second",
      });
      expect(requests).toEqual([
        { redeem_request_id: "first", credit_id: "credit-1" },
        { redeem_request_id: "deliberate-second", credit_id: "credit-2" },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  test.each(["ledger", "release"] as const)(
    "a %s settlement failure recovers the original result after its orphan lease without spending another credit",
    async (failure) => {
      const original = globalThis.fetch;
      const requests: { redeem_request_id: string; credit_id: string }[] = [];
      globalThis.fetch = (async (_url, init) => {
        if (!init?.body)
          return quotaResponse(requests.length ? ["credit-2"] : undefined);
        requests.push(JSON.parse(String(init.body)));
        return Response.json({
          code: requests.length === 1 ? "reset" : "already_redeemed",
        });
      }) as typeof fetch;
      try {
        const confirmed = await offer();
        await database.run(
          failure === "ledger"
            ? sql`CREATE TRIGGER fail_settlement BEFORE UPDATE OF result_code ON codex_reset_credit_redemptions WHEN new.result_code IS NOT NULL BEGIN SELECT RAISE(ABORT, 'settlement unavailable'); END`
            : sql`CREATE TRIGGER fail_settlement BEFORE UPDATE OF status ON codex_reset_credit_redemptions WHEN new.status = 'completed' BEGIN SELECT RAISE(ABORT, 'settlement unavailable'); END`
        );
        try {
          await expect(
            redeemCodexResetCredit(database, "codex-account", {
              ...confirmed,
              redeemRequestId: "uncertain-settlement",
            })
          ).rejects.toMatchObject({ redeemRequestId: "uncertain-settlement" });
        } finally {
          await database.run(sql`DROP TRIGGER fail_settlement`);
        }
        await database
          .update(schema.codexResetCreditRedemptions)
          .set({ updatedAt: Date.now() - 120_001 });
        if (failure === "ledger") {
          const account = await findProviderAccountById(
            database,
            "codex-account"
          );
          if (!account) throw new Error("Expected fixture account");
          await listProviderAccountQuotas(database, [account]);
        }
        const result = await redeemCodexResetCredit(
          otherDatabase,
          "codex-account",
          { redeemRequestId: "uncertain-settlement", creditId: "credit-2" }
        );
        expect(result?.code).toBe(
          failure === "ledger" ? "already_redeemed" : "reset"
        );
        expect(requests).toHaveLength(1);
        expect(
          requests.every(
            (request) =>
              request.redeem_request_id === "uncertain-settlement" &&
              request.credit_id === "credit-1"
          )
        ).toBe(true);
        expect(
          (await readCodexResetCreditState(database, accountIdentity)).pending
        ).toBeNull();
        expect((await offer()).creditId).toBe("credit-2");
      } finally {
        globalThis.fetch = original;
      }
    }
  );

  test("orphan recovery reuses the ID and stale executors cannot release its fence", async () => {
    const input = {
      accountIdentity,
      providerAccountId: "codex-account",
      redeemRequestId: "orphan",
      creditId: "credit-1",
      offerGeneration: 0,
      now: Date.now(),
    };
    const first = await reserveCodexResetCredit(database, input);
    const recovered = await reserveCodexResetCredit(otherDatabase, {
      ...input,
      offerGeneration: (
        await readCodexResetCreditState(database, accountIdentity)
      ).generation,
      recovery: "spend",
      now: input.now + 120_001,
    });
    if (!first.reservation || !recovered.reservation) {
      throw new Error("Expected reserved requests");
    }
    await settleCodexResetCredit(
      database,
      first.reservation,
      {
        status: "completed",
        resultCode: "reset",
        windowsReset: 2,
        lastError: null,
      },
      input.now + 120_002
    );
    await finishCodexResetCredit(database, first.reservation);
    await expect(
      reserveCodexResetCredit(database, {
        ...input,
        redeemRequestId: "new-id",
        now: input.now + 120_003,
      })
    ).rejects.toMatchObject({ redeemRequestId: "orphan" });
    expect(
      await findCodexResetCreditRedemption(database, "orphan")
    ).toMatchObject({
      status: "pending",
      creditId: "credit-1",
    });
    await settleCodexResetCredit(
      otherDatabase,
      recovered.reservation,
      {
        status: "completed",
        resultCode: "reset",
        windowsReset: 2,
        lastError: null,
      },
      input.now + 120_004
    );
    await finishCodexResetCredit(otherDatabase, recovered.reservation);
    expect(
      await reserveCodexResetCredit(database, {
        ...input,
        redeemRequestId: "next",
        offerGeneration: (
          await readCodexResetCreditState(database, accountIdentity)
        ).generation,
        now: input.now + 120_005,
      })
    ).toHaveProperty("reservation");
  });

  test("unsettled pre-migration ledger rows also block a fresh request", async () => {
    const now = Date.now();
    await saveCodexResetCreditRedemption(database, {
      redeemRequestId: "legacy",
      providerAccountId: "codex-account",
      creditId: "credit-1",
      status: "retryable",
      createdAt: now,
      updatedAt: now,
    });
    await expect(
      reserveCodexResetCredit(otherDatabase, {
        accountIdentity,
        providerAccountId: "other-account",
        redeemRequestId: "new-id",
        creditId: null,
        now,
      })
    ).rejects.toMatchObject({ redeemRequestId: "legacy" });
  });

  test("deleting a local account cannot erase an uncertain identity's spend fence", async () => {
    const input = {
      accountIdentity,
      providerAccountId: "codex-account",
      redeemRequestId: "uncertain",
      creditId: "credit-1",
      offerGeneration: 0,
      now: Date.now(),
    };
    await reserveCodexResetCredit(database, input);
    await database
      .delete(providerAccounts)
      .where(eq(providerAccounts.id, "codex-account"));
    await expect(
      reserveCodexResetCredit(otherDatabase, {
        ...input,
        providerAccountId: "other-account",
        redeemRequestId: "fresh-id",
      })
    ).rejects.toMatchObject({ redeemRequestId: "uncertain" });
  });

  test("unknown or conflicting Codex identities fail closed before any credit is spent", async () => {
    const original = globalThis.fetch;
    let sends = 0;
    globalThis.fetch = (() => {
      sends++;
      throw new Error("Unverified identity must not spend");
    }) as typeof fetch;
    try {
      for (const values of [
        { accountId: null, metadataJson: null },
        {
          accountId: "mismatched-identity",
          metadataJson: JSON.stringify({
            provider: "codex",
            chatgptAccountId: accountIdentity,
            email: null,
          }),
        },
      ]) {
        await database
          .update(providerAccounts)
          .set(values)
          .where(eq(providerAccounts.id, "codex-account"));
        await expect(
          redeemCodexResetCredit(database, "codex-account", {
            redeemRequestId: "fresh-id",
          })
        ).rejects.toMatchObject({ status: 409 });
      }
      expect(sends).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test.each([10, 99.6])(
    "a natural reset and new traffic at %s%% require the owner's new early-spend warning to be confirmed",
    async (currentUse) => {
      const original = globalThis.fetch;
      const now = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(now);
      let percent = 100;
      let resetAt = (now + 500) / 1000;
      let spends = 0;
      globalThis.fetch = (async (url, init) => {
        if (init?.body) {
          spends++;
          return Response.json({ code: "reset" });
        }
        if (String(url).endsWith("/usage"))
          return Response.json({
            rate_limit: {
              primary_window: {
                used_percent: percent,
                reset_at: resetAt,
                limit_window_seconds: 18000,
              },
            },
          });
        return quotaResponse();
      }) as typeof fetch;
      try {
        const confirmed = await offer();
        const account = await findProviderAccountById(
          database,
          "codex-account"
        );
        if (!account) throw new Error("Expected fixture account");
        clock.mockReturnValue(now + 1000);
        percent = currentUse;
        resetAt = (now + 3_600_000) / 1000;
        recordProviderAccountLiveLimits(
          account,
          readCodexLiveLimits(
            new Headers({
              "x-codex-primary-used-percent": String(currentUse),
              "x-codex-primary-reset-at": String(resetAt),
              "x-codex-primary-window-minutes": "300",
            })
          )
        );
        await expect(
          redeemCodexResetCredit(database, account.id, {
            ...confirmed,
            redeemRequestId: "stale-warning",
          })
        ).rejects.toMatchObject({ status: 409, redeemRequestId: null });
        expect(spends).toBe(0);
        const refreshed = await offer();
        expect(refreshed.offerKey).not.toBe(confirmed.offerKey);
        const quota = (
          await listProviderAccountQuotas(database, [account])
        ).get(account.id);
        expect(quota?.data).toMatchObject({
          resetCreditAction: {
            earlyUse: { percentUsed: Math.round(currentUse) },
          },
        });
        await redeemCodexResetCredit(database, account.id, {
          ...refreshed,
          redeemRequestId: "new-warning-confirmed",
        });
        expect(spends).toBe(1);
      } finally {
        clock.mockRestore();
        globalThis.fetch = original;
      }
    }
  );

  test("traffic cannot keep an old credit observation actionable or cause extra upstream reads", async () => {
    const original = globalThis.fetch;
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    let reads = 0;
    let spends = 0;
    globalThis.fetch = (async (_url, init) => {
      if (init?.body) {
        spends++;
        return Response.json({ code: "reset" });
      }
      reads++;
      return quotaResponse();
    }) as typeof fetch;
    try {
      const confirmed = await offer();
      const initialReads = reads;
      const account = await findProviderAccountById(database, "codex-account");
      if (!account) throw new Error("Expected fixture account");
      for (const elapsed of [60_000, 300_000, 600_001]) {
        clock.mockReturnValue(now + elapsed);
        recordProviderAccountLiveLimits(
          account,
          readCodexLiveLimits(
            new Headers({ "x-codex-primary-used-percent": "10" })
          )
        );
      }
      const quota = (await listProviderAccountQuotas(database, [account])).get(
        account.id
      );
      expect(
        quota?.data.provider === "codex" ? quota.data.resetCreditAction : null
      ).toBeNull();
      await expect(
        redeemCodexResetCredit(database, account.id, {
          ...confirmed,
          redeemRequestId: "stale-discovery",
        })
      ).rejects.toMatchObject({ status: 409, redeemRequestId: null });
      expect(spends).toBe(0);
      expect(reads).toBe(initialReads);
    } finally {
      clock.mockRestore();
      globalThis.fetch = original;
    }
  });

  test("a slow quota read cannot overwrite the live limits used for a Codex warning", async () => {
    const original = globalThis.fetch;
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    globalThis.fetch = (async (url) => {
      if (String(url).endsWith("/usage")) {
        started();
        await held;
        return Response.json({
          rate_limit: {
            primary_window: { used_percent: 100, limit_window_seconds: 18000 },
          },
        });
      }
      return quotaResponse();
    }) as typeof fetch;
    let pending: ReturnType<typeof listProviderAccountQuotas> | undefined;
    try {
      const account = await findProviderAccountById(database, "codex-account");
      if (!account) throw new Error("Expected fixture account");
      pending = listProviderAccountQuotas(database, [account]);
      await reading;
      recordProviderAccountLiveLimits(
        account,
        readCodexLiveLimits(
          new Headers({ "x-codex-primary-used-percent": "10" })
        )
      );
      release();
      const quota = (await pending).get(account.id);
      expect(quota?.data).toMatchObject({
        resetCreditAction: { earlyUse: { percentUsed: 10 } },
      });
    } finally {
      release();
      await pending;
      globalThis.fetch = original;
    }
  });
});
