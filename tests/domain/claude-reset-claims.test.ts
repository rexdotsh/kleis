import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import type { Database } from "../../src/db";
import * as claimRepository from "../../src/db/repositories/claude-reset-claims";
import {
  findProviderAccountById,
  replaceProviderAccountCredentials,
  type ProviderAccountRecord,
} from "../../src/db/repositories/provider-accounts";
import { claudeResetClaims, providerAccounts } from "../../src/db/schema";
import {
  ClaudeResetClaimConflict,
  claimClaudeReset,
  listAccountsWithClaudeResets,
} from "../../src/domain/providers/claude-reset-claims";
import {
  expireProviderAccountTracking,
  listProviderAccountQuotas,
  recordProviderAccountLiveLimits,
  refreshClaudeResetCredits,
  setAccountSnapshotStore,
} from "../../src/domain/providers/provider-account-tracking";
import { readClaudeLiveLimits } from "../../src/providers/account-tracking/live-limits";
import { createResetDatabase } from "../helpers/reset-database";

const MINUTE = 60_000;
const ORGANIZATION = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: "grant_fake_1",
  label: "Fake saved reset",
  resets_left: 2,
  starts_at: "2020-01-01T00:00:00Z",
  ends_at: "2100-01-01T00:00:00Z",
  clears: ["five_hour", "seven_day", "seven_day_overage_included"],
  paused: false,
  usable_now: true,
  use_requires_limit: false,
  blocking: [],
  ...overrides,
});

const cedar = (grants: unknown[] = [grant()]) => ({
  eligible: true,
  ineligible_reason: null,
  grants,
  next_grant_id: (grants[0] as { id?: string } | undefined)?.id ?? null,
  weekly_resets_at: "2026-10-19T19:00:00+00:00",
  cooldown_until: null,
  event_props: { surface: "claude_code_cli", tier: "claude_max_5x" },
});

const usageBody = (block: unknown, fiveHour = 40) => ({
  five_hour: {
    utilization: fiveHour,
    resets_at: new Date(Date.now() + 5 * 60 * MINUTE).toISOString(),
  },
  seven_day: {
    utilization: 20,
    resets_at: new Date(Date.now() + 7 * 24 * 60 * MINUTE).toISOString(),
  },
  extra_usage: { is_enabled: true, monthly_limit: 5000 },
  limits: [],
  cedar_ember: block,
});

// A reset of the 5h limit only, which is exhausted: no early-use warning.
const atLimit = () => usageBody(cedar([grant({ clears: ["five_hour"] })]), 100);

const tokens = (access: string, account = ACCOUNT) =>
  Response.json({
    access_token: access,
    refresh_token: `${access}-refresh`,
    expires_in: 3600,
    account: { uuid: account },
    organization: { uuid: ORGANIZATION },
  });

type ClaimCall = { url: string; body: Record<string, unknown> };

const upstream = {
  usage: (_headers: Headers): Response | Promise<Response> =>
    Response.json(usageBody(cedar())),
  claim: (_call: ClaimCall): Response | Promise<Response> =>
    Response.json({ result: "reset", resets_left: 1, cleared: ["five_hour"] }),
  profile: (): Response => Response.json({}),
  refresh: (): Response => {
    throw new Error("Unexpected token refresh");
  },
  usageUrls: [] as string[],
  claims: [] as ClaimCall[],
  claimHeaders: [] as Headers[],
};

const originalFetch = globalThis.fetch;

const mockAnthropic = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (
    url.hostname === "platform.claude.com" &&
    url.pathname === "/v1/oauth/token"
  )
    return Promise.resolve(upstream.refresh());
  if (url.hostname !== "api.anthropic.com") {
    throw new Error(`Unexpected request to ${url.hostname}`);
  }
  if (url.pathname === "/api/oauth/usage") {
    upstream.usageUrls.push(url.toString());
    return Promise.resolve(upstream.usage(new Headers(init?.headers)));
  }
  if (url.pathname === "/api/oauth/profile") {
    return Promise.resolve(upstream.profile());
  }
  if (url.pathname === "/api/oauth/claude_cli/roles") {
    return Promise.resolve(Response.json({}));
  }
  if (url.pathname.endsWith("/reset_rate_limits")) {
    const call = {
      url: url.toString(),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    upstream.claims.push(call);
    upstream.claimHeaders.push(new Headers(init?.headers));
    return Promise.resolve(upstream.claim(call));
  }
  throw new Error(`Unexpected Anthropic request to ${url.pathname}`);
}) as unknown as typeof fetch;

const flush = async () => {
  for (let index = 0; index < 5; index++) {
    await Bun.sleep(0);
  }
};

const gate = () => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const live = (
  account: ProviderAccountRecord,
  headers: Record<string, string>
) =>
  recordProviderAccountLiveLimits(
    account,
    readClaudeLiveLimits(new Headers(headers))
  );

const fiveHourReset = (offsetMs: number) => ({
  "anthropic-ratelimit-unified-5h-reset": String(
    (Date.now() + offsetMs) / 1000
  ),
});

describe("Claude reset claims", () => {
  let fixture: Awaited<ReturnType<typeof createResetDatabase>>;
  let database: Database;
  let startedAt: number;
  let warnings: ReturnType<typeof spyOn>;

  const at = (offsetMs: number) =>
    setSystemTime(new Date(startedAt + offsetMs));

  const addAccount = async (
    metadata: Record<string, unknown> = {
      accountUuid: ACCOUNT,
      organizationUuid: ORGANIZATION,
    }
  ): Promise<ProviderAccountRecord> => {
    const now = Date.now();
    const id = crypto.randomUUID();
    await database.insert(providerAccounts).values({
      id,
      provider: "claude",
      accessToken: `access-${id}`,
      refreshToken: "refresh",
      expiresAt: now + 24 * 60 * MINUTE,
      metadataJson: JSON.stringify({
        provider: "claude",
        oauthMode: "max",
        oauthHost: "claude.ai",
        ...metadata,
      }),
      createdAt: now,
      updatedAt: now,
    });
    const account = await findProviderAccountById(database, id);
    if (!account) throw new Error("account missing");
    return account;
  };

  // Reads usage (and resets) the way the admin does, letting background
  // refreshes it starts finish.
  const read = async (account: ProviderAccountRecord) => {
    const quotas = await listProviderAccountQuotas(database, [account]);
    await flush();
    return quotas.get(account.id);
  };

  const rows = () => database.select().from(claudeResetClaims);

  const view = async (account: ProviderAccountRecord) =>
    (await listAccountsWithClaudeResets(database)).describe(account);

  const offerOf = async (account: ProviderAccountRecord) => {
    const offer = (await view(account))?.offer;
    if (!offer) throw new Error("no offer");
    return { grantId: offer.grantId, offerKey: offer.key };
  };

  const claim = (
    account: ProviderAccountRecord,
    confirmation: { grantId: string; offerKey: string }
  ) => claimClaudeReset(database, account.id, confirmation);

  const conflictOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof ClaudeResetClaimConflict) return error.reason;
      throw error;
    }
    throw new Error("expected a conflict");
  };

  // Clears the shared Claude 429 pause for later tests.
  const clearRateLimitPause = async (account: ProviderAccountRecord) => {
    upstream.usage = () => Response.json(usageBody(cedar()));
    at(30 * MINUTE);
    expect(await refreshClaudeResetCredits(database, account)).not.toBeNull();
  };

  beforeEach(async () => {
    fixture = await createResetDatabase();
    database = fixture.database;
    setAccountSnapshotStore(null);
    startedAt = Date.now();
    at(0);
    upstream.usage = () => Response.json(usageBody(cedar()));
    upstream.claim = () =>
      Response.json({
        result: "reset",
        resets_left: 1,
        cleared: ["five_hour"],
      });
    upstream.profile = () => Response.json({});
    upstream.refresh = () => {
      throw new Error("Unexpected token refresh");
    };
    upstream.usageUrls = [];
    upstream.claims = [];
    upstream.claimHeaders = [];
    globalThis.fetch = mockAnthropic;
    warnings = spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await flush();
    warnings.mockRestore();
    globalThis.fetch = originalFetch;
    setSystemTime();
    await fixture.close();
  });

  describe("discovery", () => {
    test("reads resets with the usual usage poll, keeping spend data and no event props", async () => {
      const account = await addAccount();
      const data = (await read(account))?.data;

      expect(data).toMatchObject({
        subscription: { extraUsage: { isEnabled: true, monthlyLimit: 5000 } },
        resetCredits: { observedAt: startedAt, status: { eligible: true } },
      });
      for (const secret of [
        "event_props",
        "claude_code_cli",
        ORGANIZATION,
        account.accessToken,
      ])
        expect(JSON.stringify(data)).not.toContain(secret);
      expect(await view(account)).toMatchObject({
        saved: 2,
        unavailable: null,
        offer: {
          grantId: "grant_fake_1",
          earlyUse: { limit: "five_hour", percentUsed: 40 },
        },
        claim: null,
      });
    });

    test("traffic refreshes limits but not resets, which stay due at the normal pace", async () => {
      const account = await addAccount();
      upstream.usage = () =>
        Response.json(usageBody(cedar([grant({ clears: ["mystery"] })])));
      await read(account);
      expect((await view(account))?.unavailable).toBe("unsupported_limits");
      upstream.usage = () => Response.json(usageBody(cedar()));
      for (let minute = 1; minute <= 4; minute++) {
        at(minute * MINUTE);
        live(account, { "anthropic-ratelimit-unified-5h-utilization": "0.4" });
        const quota = await read(account);
        if (minute === 1)
          expect(quota).toMatchObject({
            fetchedAt: startedAt + MINUTE,
            data: { resetCredits: { observedAt: startedAt } },
          });
        if (minute < 3) expect(upstream.usageUrls).toHaveLength(1);
      }
      expect(upstream.usageUrls).toHaveLength(2);
      expect((await view(account))?.offer).not.toBeNull();

      // A read without the block was not evaluated for resets.
      upstream.usage = () => Response.json(usageBody(null));
      at(7 * MINUTE);
      await read(account);
      expect(await read(account)).toMatchObject({
        fetchedAt: startedAt + 7 * MINUTE,
        data: { resetCredits: { observedAt: startedAt + 3 * MINUTE } },
      });
    });

    test("respects the shared 429 pause and retry pace under traffic", async () => {
      const account = await addAccount();
      await read(account);
      upstream.usage = () => Response.json({}, { status: 429 });
      for (let minute = 1; minute <= 4; minute++) {
        at(minute * MINUTE);
        live(account, { "anthropic-ratelimit-unified-5h-utilization": "0.4" });
        await read(account);
      }
      expect(upstream.usageUrls).toHaveLength(2);
      await clearRateLimitPause(account);
    });

    test.each([
      { clears: ["five_hour", "unknown_window"] },
      { blocking: ["unknown_window"] },
    ])(
      "unknown limit types disable claiming but keep ordinary usage: %j",
      async (fields) => {
        const account = await addAccount();
        await read(account);
        const confirmed = await offerOf(account);
        upstream.usage = () => Response.json(usageBody(cedar([grant(fields)])));
        at(4 * MINUTE);
        expect((await read(account))?.data).toMatchObject({
          subscription: { fiveHour: { utilization: 40 } },
        });
        expect(await view(account)).toMatchObject({
          offer: null,
          unavailable: "unsupported_limits",
        });
        expect(await conflictOf(claim(account, confirmed))).toBe(
          "not_claimable"
        );
        expect(upstream.claims).toHaveLength(0);
      }
    );
  });

  describe("dispatch and outcomes", () => {
    test("records the request ID before sending the confirmed reset once, and logs no IDs", async () => {
      const account = await addAccount();
      await read(account);
      const offer = await offerOf(account);
      let recordedBeforeSend: unknown[] = [];
      upstream.claim = async (call) => {
        recordedBeforeSend = await database
          .select()
          .from(claudeResetClaims)
          .where(eq(claudeResetClaims.requestId, String(call.body.request_id)));
        return Response.json({
          result: "reset",
          resets_left: 1,
          cleared: ["five_hour", "seven_day", "mystery_window"],
        });
      };
      const info = spyOn(console, "info").mockImplementation(() => undefined);
      try {
        const outcome = await claim(account, offer);
        expect(outcome).toMatchObject({
          status: "completed",
          result: "reset",
          resetsLeft: 1,
          cleared: ["five_hour", "seven_day"],
        });
        expect(upstream.claims).toHaveLength(1);
        expect(upstream.claims[0]).toMatchObject({
          url: `https://api.anthropic.com/api/organizations/${ORGANIZATION}/reset_rate_limits`,
          body: { grant_id: offer.grantId, request_id: outcome?.requestId },
        });
        expect(upstream.claimHeaders[0]?.get("authorization")).toBe(
          `Bearer ${account.accessToken}`
        );
        expect(recordedBeforeSend).toMatchObject([{ status: "pending" }]);
        expect(await rows()).toMatchObject([
          { status: "completed", result: "reset", httpStatus: null },
        ]);
        const logged = info.mock.calls.map((args) => String(args[0])).join();
        for (const secret of ["grant_fake_1", ORGANIZATION, outcome?.requestId])
          expect(logged).not.toContain(String(secret));
      } finally {
        info.mockRestore();
      }
    });

    test.each([
      ["a refusal", () => Response.json({}, { status: 429 }), "failed"],
      ["a cooldown", () => Response.json({ result: "cooldown" }), "completed"],
      [
        "a timeout",
        () => {
          throw new DOMException("The operation timed out.", "TimeoutError");
        },
        "ambiguous",
      ],
      ["a server error", () => Response.json({}, { status: 502 }), "ambiguous"],
      ["a malformed success", () => new Response("<html>"), "ambiguous"],
      ["an unknown result", () => Response.json({ result: "x" }), "ambiguous"],
      [
        "an unconfirmed reset",
        () => Response.json({ result: "reset", reason: "reset_unconfirmed" }),
        "ambiguous",
      ],
      [
        "an unavailable result",
        () => Response.json({ result: "unavailable" }),
        "ambiguous",
      ],
    ] as const)("%s is %s and never resent", async (_name, respond, status) => {
      const account = await addAccount();
      await read(account);
      const offer = await offerOf(account);
      upstream.claim = respond;
      expect((await claim(account, offer))?.status).toBe(status);
      expect(await rows()).toMatchObject([{ status }]);
      expect(upstream.claims).toHaveLength(1);
      if (status !== "ambiguous") return;
      await flush();
      expect(await view(account)).toMatchObject({
        offer: null,
        claim: { status: "ambiguous" },
      });
      expect(await conflictOf(claim(account, offer))).toBe("claim_unconfirmed");
      expect(upstream.claims).toHaveLength(1);
    });

    test.each([
      ["the same reset reuses its request ID", "grant_fake_1"],
      ["another reset closes the claim", "grant_fake_2"],
    ])("after a later read, retrying %s", async (_name, nextGrant) => {
      const account = await addAccount();
      await read(account);
      upstream.claim = () => Response.json({}, { status: 503 });
      const first = await claim(account, await offerOf(account));
      upstream.usage = () =>
        Response.json(usageBody(cedar([grant({ id: nextGrant })])));
      at(MINUTE);
      await read(account);
      expect((await view(account))?.claim).toMatchObject({
        status: "ambiguous",
      });
      at(4 * MINUTE);
      await read(account);
      upstream.claim = () => Response.json({ result: "already_used" });
      const second = await claim(account, await offerOf(account));
      const reused = nextGrant === "grant_fake_1";
      expect(second?.status).toBe("completed");
      expect(second?.requestId === first?.requestId).toBe(reused);
      expect((await rows()).map((row) => row.status).sort()).toEqual(
        reused ? ["completed"] : ["completed", "reconciled"]
      );
    });

    test("a successful reset stays successful when the refresh after it fails", async () => {
      const account = await addAccount();
      await read(account);
      const offer = await offerOf(account);
      upstream.usage = () => Response.json({}, { status: 500 });
      expect((await claim(account, offer))?.status).toBe("completed");
      await flush();
      expect(await view(account)).toBeNull();
    });

    test("a read started before the claim settled can't bring the used reset back", async () => {
      const account = await addAccount();
      await read(account);
      const offer = await offerOf(account);
      const pending: ((response: Response) => void)[] = [];
      upstream.usage = () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        });
      at(4 * MINUTE);
      await read(account);
      expect(pending).toHaveLength(1);

      expect((await claim(account, offer))?.status).toBe("completed");
      await flush();
      expect(pending).toHaveLength(2);
      pending[0]?.(Response.json(usageBody(cedar())));
      await flush();
      expect((await view(account))?.offer ?? null).toBeNull();

      pending[1]?.(
        Response.json(usageBody(cedar([grant({ resets_left: 1 })])))
      );
      await flush();
      const after = await view(account);
      expect(after).toMatchObject({ saved: 1 });
      expect(after?.offer?.key).not.toBe(offer.offerKey);
    });

    test.each([false, true])(
      "a rejected token is refreshed and the same request resent once, after rechecking limits (limits changed: %s)",
      async (changed) => {
        const account = await addAccount();
        upstream.usage = () => Response.json(atLimit());
        await read(account);
        const confirmed = await offerOf(account);
        upstream.claim = () =>
          upstream.claims.length === 1
            ? Response.json({}, { status: 401 })
            : Response.json({ result: "reset" });
        upstream.refresh = () => {
          if (changed)
            live(account, {
              "anthropic-ratelimit-unified-5h-utilization": "0",
            });
          return tokens("fake-refreshed-access");
        };
        const outcome = claim(account, confirmed);
        if (changed) {
          expect(await conflictOf(outcome)).toBe("offer_changed");
          expect(upstream.claims).toHaveLength(1);
          return;
        }
        expect(await outcome).toMatchObject({ status: "completed" });
        expect(upstream.claims.map((call) => call.body.request_id)).toEqual([
          upstream.claims[0]?.body.request_id,
          upstream.claims[0]?.body.request_id,
        ]);
      }
    );
  });

  describe("one claim per confirmed offer", () => {
    test.each([false, true])(
      "two claims at once send one request (duplicate row of the same login: %s)",
      async (duplicate) => {
        const first = await addAccount();
        const second = duplicate ? await addAccount() : first;
        await read(first);
        if (duplicate) await read(second);
        const offer = await offerOf(first);
        const sending = gate();
        const release = gate();
        upstream.claim = async () => {
          sending.release();
          await release.promise;
          return Response.json({ result: "reset" });
        };
        const pending = claim(first, offer);
        try {
          await sending.promise;
          expect(await conflictOf(claim(second, offer))).toBe(
            "claim_in_progress"
          );
        } finally {
          release.release();
        }
        expect((await pending)?.status).toBe("completed");
        expect(upstream.claims).toHaveLength(1);
      }
    );

    test.each([false, true])(
      "a delayed reservation is fenced after a claim completes (duplicate row: %s)",
      async (duplicate) => {
        const firstAccount = await addAccount();
        const secondAccount = duplicate ? await addAccount() : firstAccount;
        await read(firstAccount);
        if (duplicate) await read(secondAccount);
        const confirmed = await offerOf(secondAccount);
        const contender = fixture.contender;
        const entered = gate();
        const resume = gate();
        const reserve = claimRepository.reserveClaudeResetClaim;
        let calls = 0;
        const paused = spyOn(
          claimRepository,
          "reserveClaudeResetClaim"
        ).mockImplementation(async (...args) => {
          if (++calls === 1) {
            entered.release();
            await resume.promise;
          }
          await reserve(...args);
        });
        const delayed = claimClaudeReset(
          contender,
          secondAccount.id,
          confirmed
        ).catch((error: unknown) => error);
        try {
          await entered.promise;
          expect((await claim(firstAccount, confirmed))?.status).toBe(
            "completed"
          );
          resume.release();
          expect(await delayed).toBeInstanceOf(ClaudeResetClaimConflict);
          expect(upstream.claims).toHaveLength(1);
        } finally {
          resume.release();
          paused.mockRestore();
          await delayed;
        }
      }
    );

    test("an open claim from another process blocks this one, and is unconfirmed once orphaned", async () => {
      const account = await addAccount();
      await read(account);
      const offer = await offerOf(account);
      await database.insert(claudeResetClaims).values({
        requestId: "other-process-request",
        accountIdentity: ACCOUNT,
        organizationUuid: ORGANIZATION,
        grantId: "grant_fake_1",
        status: "pending",
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      expect(await conflictOf(claim(account, offer))).toBe("claim_in_progress");
      expect((await view(account))?.claim).toMatchObject({ status: "pending" });

      at(3 * MINUTE);
      expect((await view(account))?.claim).toMatchObject({
        status: "ambiguous",
      });
      expect(await conflictOf(claim(account, offer))).toBe("claim_unconfirmed");
      expect(upstream.claims).toHaveLength(0);
    });

    test("resets read before another process's claim settled are not offered", async () => {
      const account = await addAccount();
      await read(account);
      const offer = await offerOf(account);
      at(MINUTE);
      await database.insert(claudeResetClaims).values({
        requestId: "other-process-request",
        accountIdentity: ACCOUNT,
        organizationUuid: ORGANIZATION,
        grantId: "grant_fake_1",
        status: "completed",
        createdAt: startedAt + MINUTE,
        updatedAt: startedAt + MINUTE,
      });
      expect(await view(account)).toMatchObject({
        offer: null,
        unavailable: "checking",
      });
      at(2 * MINUTE);
      upstream.usage = () =>
        Response.json(usageBody(cedar([grant({ resets_left: 1 })])));
      expect(await conflictOf(claim(account, offer))).toBe("offer_changed");
      expect(upstream.claims).toHaveLength(0);
    });

    test("a reservation invalidates confirmations of identical offers, even beyond the ledger lookback", async () => {
      const first = await addAccount();
      const second = await addAccount();
      await read(first);
      await read(second);
      const confirmed = await offerOf(second);
      await claim(first, confirmed);
      at(14 * MINUTE);
      expect(await conflictOf(claim(second, confirmed))).toBe("offer_changed");
      expect(upstream.claims).toHaveLength(1);
      expect((await offerOf(second)).offerKey).not.toBe(confirmed.offerKey);
    });

    test.each([
      ["the same user, differently cased", ACCOUNT.toUpperCase(), true],
      ["another user", OTHER, false],
    ])(
      "identical grant data for %s gets the matching offer key",
      async (_name, nextAccount, same) => {
        const first = await addAccount();
        await read(first);
        const second = await addAccount({
          accountUuid: nextAccount,
          organizationUuid: ORGANIZATION,
        });
        await read(second);
        const [a, b] = [await offerOf(first), await offerOf(second)];
        expect(a.offerKey === b.offerKey).toBe(same);
      }
    );
  });

  describe("confirmation binding", () => {
    test("an unchanged confirmed grant cannot be spent after its expiry", async () => {
      const account = await addAccount();
      const body = usageBody(
        cedar([grant({ ends_at: new Date(startedAt + MINUTE).toISOString() })])
      );
      upstream.usage = () => Response.json(body);
      await read(account);
      const confirmed = await offerOf(account);

      at(MINUTE + 1);
      const outcome = await claim(account, confirmed).catch(
        (error: unknown) => error
      );
      expect(upstream.claims).toHaveLength(0);
      expect(outcome).toBeInstanceOf(ClaudeResetClaimConflict);
      expect((outcome as ClaudeResetClaimConflict).reason).toBe(
        "not_claimable"
      );
    });

    test.each([
      { eligible: false },
      { grants: [grant({ resets_left: 0 })] },
      { grants: [grant({ resets_left: -1 })] },
      { grants: [grant({ id: "../../other-grant" })] },
      { grants: [grant({ ends_at: "2020-01-01T00:00:00Z" })] },
      { grants: [grant({ starts_at: "2100-01-01T00:00:00Z" })] },
      { grants: [grant({ ends_at: "unreadable" })] },
      { grants: [grant({ paused: true })] },
      { grants: [grant({ usable_now: false })] },
      { grants: [grant({ blocking: ["seven_day_opus"] })] },
      { next_grant_id: "unrecognized_grant" },
      { cooldown_until: "2100-01-01T00:00:00Z" },
      { cooldown_until: "unreadable" },
    ])(
      "unusable upstream reset offers cannot be spent: %j",
      async (changed) => {
        const account = await addAccount();
        await read(account);
        const confirmed = await offerOf(account);
        upstream.usage = () =>
          Response.json(usageBody({ ...cedar(), ...changed }));
        at(4 * MINUTE);
        await read(account);
        await expect(claim(account, confirmed)).rejects.toBeInstanceOf(
          ClaudeResetClaimConflict
        );
        expect(upstream.claims).toHaveLength(0);
      }
    );

    test.each([
      { grants: [grant({ resets_left: 1 })] },
      { grants: [grant({ clears: ["five_hour"] })] },
      { grants: [grant({ label: "A different offer" })] },
      { weekly_resets_at: "2100-01-01T00:00:00Z" },
      { grants: [grant(), grant({ id: "another_grant" })] },
    ])(
      "changing a confirmed offer requires renewed consent before dispatch: %j",
      async (changed) => {
        const account = await addAccount();
        await read(account);
        const confirmed = await offerOf(account);
        upstream.usage = () =>
          Response.json(usageBody({ ...cedar(), ...changed }));
        at(4 * MINUTE);
        await read(account);
        expect(await conflictOf(claim(account, confirmed))).toBe(
          "offer_changed"
        );
        expect(upstream.claims).toHaveLength(0);
      }
    );

    test("a changed or unusable offer needs a new confirmation", async () => {
      const account = await addAccount();
      await read(account);
      const offer = await offerOf(account);
      expect(
        await conflictOf(claim(account, { ...offer, offerKey: "0".repeat(32) }))
      ).toBe("offer_changed");

      upstream.usage = () =>
        Response.json(usageBody(cedar([grant({ use_requires_limit: true })])));
      at(11 * MINUTE);
      expect(await conflictOf(claim(account, offer))).toBe("not_claimable");
      expect(await view(account)).toMatchObject({
        offer: null,
        unavailable: "requires_limit",
        saved: 2,
      });
      expect(upstream.claims).toHaveLength(0);
    });

    test("a stale offer during the shared rate-limit pause sends nothing", async () => {
      const account = await addAccount();
      await read(account);
      const offer = await offerOf(account);
      upstream.usage = () => Response.json({}, { status: 429 });
      at(11 * MINUTE);
      expect(await conflictOf(claim(account, offer))).toBe("stale");
      expect(await conflictOf(claim(account, offer))).toBe("stale");
      expect(upstream.usageUrls).toHaveLength(2);
      expect(upstream.claims).toHaveLength(0);
      await clearRateLimitPause(account);
    });

    test.each(["poll", "live", "boundary", "reset-only", "unknown"])(
      "current limits from a %s reading require renewed early-use confirmation",
      async (source) => {
        const account = await addAccount();
        upstream.usage = () =>
          Response.json({
            ...atLimit(),
            five_hour: {
              utilization: 100,
              resets_at: new Date(startedAt + MINUTE).toISOString(),
            },
          });
        await read(account);
        const confirmed = await offerOf(account);
        expect((await view(account))?.offer?.earlyUse).toBeNull();
        at(2 * MINUTE);
        if (source === "boundary") {
          // The 5h window's reset time has passed.
        } else if (source === "live") {
          live(account, {
            "anthropic-ratelimit-unified-5h-utilization": "0",
            ...fiveHourReset(5 * 60 * MINUTE),
          });
        } else if (source === "reset-only") {
          live(account, fiveHourReset(5 * 60 * MINUTE));
        } else {
          upstream.usage = () =>
            Response.json(
              source === "poll"
                ? usageBody(cedar([grant({ clears: ["five_hour"] })]), 0)
                : { ...atLimit(), five_hour: null }
            );
          at(4 * MINUTE);
          await read(account);
        }
        expect(await conflictOf(claim(account, confirmed))).toBe(
          "offer_changed"
        );
        expect(upstream.claims).toHaveLength(0);
        expect((await view(account))?.offer?.earlyUse).toEqual({
          limit: ["boundary", "live", "poll"].includes(source)
            ? "five_hour"
            : null,
          percentUsed: ["boundary", "live", "poll"].includes(source) ? 0 : null,
        });
      }
    );

    test.each([
      ["live limits change", "offer_changed", false],
      ["a newer reset block arrives", "not_claimable", false],
      ["live limits change for a reused claim", "offer_changed", true],
    ] as const)(
      "the confirmation is checked again before sending when %s during reservation",
      async (_name, reason, reuse) => {
        const account = await addAccount();
        upstream.usage = () => Response.json(atLimit());
        await read(account);
        let first: Awaited<ReturnType<typeof claim>> = null;
        if (reuse) {
          upstream.claim = () => Response.json({}, { status: 503 });
          first = await claim(account, await offerOf(account));
          await flush();
          at(4 * MINUTE);
          await read(account);
        }
        const confirmed = await offerOf(account);
        const reserve = claimRepository.reserveClaudeResetClaim;
        const intercepted = spyOn(
          claimRepository,
          "reserveClaudeResetClaim"
        ).mockImplementation(async (...args) => {
          await reserve(...args);
          if (reason === "not_claimable") {
            upstream.usage = () =>
              Response.json(
                usageBody(cedar([grant({ blocking: ["unknown_window"] })]))
              );
            await refreshClaudeResetCredits(database, account);
          } else {
            live(account, {
              "anthropic-ratelimit-unified-5h-utilization": "0",
            });
          }
        });
        try {
          expect(await conflictOf(claim(account, confirmed))).toBe(reason);
          expect(upstream.claims).toHaveLength(reuse ? 1 : 0);
          expect(await rows()).toMatchObject([
            reuse
              ? { status: "ambiguous", requestId: first?.requestId }
              : { status: "failed" },
          ]);
        } finally {
          intercepted.mockRestore();
        }
      }
    );

    test.each(["utilization", "reset-only", "unmatched reset-only"])(
      "a slow poll cannot overwrite newer live limits (%s)",
      async (reading) => {
        const account = await addAccount();
        const body = atLimit();
        const usage = {
          ...body,
          five_hour: {
            ...body.five_hour,
            resets_at:
              reading === "unmatched reset-only"
                ? null
                : body.five_hour.resets_at,
          },
        };
        upstream.usage = () => Response.json(usage);
        await read(account);
        const confirmed = await offerOf(account);
        let finish: (response: Response) => void = () => undefined;
        upstream.usage = () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          });
        at(3 * MINUTE);
        await read(account);
        if (reading === "reset-only") {
          live(account, {
            "anthropic-ratelimit-unified-5h-utilization": "1",
            ...fiveHourReset(5 * 60 * MINUTE - 3 * MINUTE),
          });
          live(account, fiveHourReset(6 * 60 * MINUTE));
        } else if (reading === "unmatched reset-only") {
          live(account, fiveHourReset(6 * 60 * MINUTE));
        } else {
          live(account, { "anthropic-ratelimit-unified-5h-utilization": "0" });
        }
        finish(Response.json(usage));
        await flush();
        upstream.usage = () => Response.json(usage);
        expect(await conflictOf(claim(account, confirmed))).toBe(
          "offer_changed"
        );
        expect(upstream.claims).toHaveLength(0);
        expect((await view(account))?.offer?.earlyUse?.percentUsed).toBe(
          reading === "utilization" ? 0 : null
        );
      }
    );

    test("usage 401 recovery keeps only the refreshed token's live readings", async () => {
      const account = await addAccount();
      upstream.usage = () => Response.json(atLimit());
      await read(account);
      const confirmed = await offerOf(account);
      upstream.refresh = () => tokens("fake-recovered-access");
      const retryStarted = gate();
      let finish: (response: Response) => void = () => undefined;
      upstream.usage = (headers) => {
        if (headers.get("authorization") === `Bearer ${account.accessToken}`) {
          live(account, { "anthropic-ratelimit-unified-5h-utilization": "0" });
          return Response.json({}, { status: 401 });
        }
        retryStarted.release();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      };
      at(3 * MINUTE);
      const reading = read(account);
      await retryStarted.promise;
      const refreshed = await findProviderAccountById(database, account.id);
      if (!refreshed) throw new Error("refreshed account missing");
      live(refreshed, { "anthropic-ratelimit-unified-5h-utilization": "0.3" });
      live(account, { "anthropic-ratelimit-unified-5h-utilization": "0" });
      upstream.usage = () => Response.json(atLimit());
      finish(Response.json(atLimit()));
      await reading;
      await flush();
      expect((await read(refreshed))?.data).toMatchObject({
        subscription: { fiveHour: { utilization: 30 } },
      });
      expect(await conflictOf(claim(account, confirmed))).toBe("offer_changed");
      expect(upstream.claims).toHaveLength(0);
    });
  });

  describe("identity from the current credential", () => {
    test.each(["organization", "account", "offer", "none"])(
      "a proactive refresh that changes the %s sends nothing",
      async (changed) => {
        const account = await addAccount();
        await read(account);
        const confirmed = await offerOf(account);
        await database
          .update(providerAccounts)
          .set({ expiresAt: startedAt + 1000 })
          .where(eq(providerAccounts.id, account.id));
        upstream.refresh = () =>
          Response.json({
            access_token: "fake-refreshed-access",
            refresh_token: "fake-refreshed-token",
            expires_in: 3600,
            account: { uuid: changed === "account" ? OTHER : ACCOUNT },
            organization: {
              uuid:
                changed === "organization"
                  ? "00000000-0000-4000-8000-000000000002"
                  : ORGANIZATION,
            },
          });
        if (changed === "offer")
          upstream.usage = () =>
            Response.json(usageBody(cedar([grant({ resets_left: 1 })])));
        const outcome = claim(account, confirmed);
        if (changed === "none") {
          expect(await outcome).toMatchObject({ status: "completed" });
          return;
        }
        expect(await conflictOf(outcome)).toBeDefined();
        expect(upstream.claims).toHaveLength(0);
        expect(await rows()).toHaveLength(0);
      }
    );

    test("the identity must be known and agree with a profile looked up with the current credential", async () => {
      const unknown = await addAccount({});
      await read(unknown);
      expect((await view(unknown))?.unavailable).toBe("identity_unverified");
      const confirmation = {
        grantId: "grant_fake_1",
        offerKey: "0".repeat(32),
      };
      expect(await conflictOf(claim(unknown, confirmation))).toBe(
        "identity_unverified"
      );

      let organization = "00000000-0000-4000-8000-000000000002";
      upstream.profile = () =>
        Response.json({
          account: { uuid: ACCOUNT },
          organization: { uuid: organization },
        });
      const moved = await addAccount();
      await read(moved);
      expect(await conflictOf(claim(moved, confirmation))).toBe(
        "identity_unverified"
      );
      expect(upstream.claims).toHaveLength(0);

      organization = ORGANIZATION;
      const proven = await addAccount({});
      await read(proven);
      expect((await claim(proven, await offerOf(proven)))?.status).toBe(
        "completed"
      );
    });

    test.each([false, true])(
      "identity-less reauthorized credentials can't borrow the previous profile (expired: %s)",
      async (expire) => {
        upstream.profile = () =>
          Response.json({
            account: { uuid: ACCOUNT },
            organization: { uuid: ORGANIZATION },
          });
        const account = await addAccount({});
        await read(account);
        const confirmed = await offerOf(account);
        const replaced = await replaceProviderAccountCredentials(
          database,
          account.id,
          {
            provider: "claude",
            accountId: null,
            accessToken: "fake-other-user-access",
            refreshToken: "fake-other-user-refresh",
            expiresAt: startedAt + 24 * 60 * MINUTE,
            metadata: {
              provider: "claude",
              scope: null,
              oauthMode: "max",
              oauthHost: "claude.ai",
            },
            now: startedAt + 1000,
          }
        );
        if (!replaced) throw new Error("reauthorization missing");
        if (expire) expireProviderAccountTracking(account.id);
        upstream.profile = () => Response.json({}, { status: 503 });
        await read(replaced);
        expect(await conflictOf(claim(replaced, confirmed))).toBe(
          "identity_unverified"
        );
        expect(await view(replaced)).toMatchObject({
          offer: null,
          unavailable: "identity_unverified",
        });
        expect(upstream.claims).toHaveLength(0);
      }
    );
  });
});
