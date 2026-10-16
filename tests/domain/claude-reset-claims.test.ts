import { createClient } from "@libsql/client";
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
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "../../src/db";
import * as claimRepository from "../../src/db/repositories/claude-reset-claims";
import {
  findProviderAccountById,
  replaceProviderAccountCredentials,
  type ProviderAccountRecord,
} from "../../src/db/repositories/provider-accounts";
import * as schema from "../../src/db/schema";
import { claudeResetClaims, providerAccounts } from "../../src/db/schema";
import {
  ClaudeResetClaimConflict,
  claimClaudeReset,
  describeClaudeResets,
} from "../../src/domain/providers/claude-reset-claims";
import {
  expireProviderAccountTracking,
  listProviderAccountQuotas,
  recordProviderAccountLiveLimits,
  refreshClaudeResetCredits,
  setAccountSnapshotStore,
} from "../../src/domain/providers/provider-account-tracking";
import { readClaudeLiveLimits } from "../../src/providers/account-tracking/live-limits";

const MINUTE = 60_000;
const ORGANIZATION = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: "grant_fake_1",
  label: "Fake saved reset",
  resets_total: 2,
  resets_left: 2,
  starts_at: new Date(Date.now() - 7 * 24 * 60 * MINUTE).toISOString(),
  ends_at: new Date(Date.now() + 7 * 24 * 60 * MINUTE).toISOString(),
  clears: ["five_hour", "seven_day", "seven_day_overage_included"],
  paused: false,
  usable_now: true,
  use_requires_limit: false,
  percent_used: { five_hour: 40, seven_day: 20 },
  blocking: [],
  arm: null,
  ...overrides,
});

const cedar = (
  grants: unknown[] = [grant()],
  overrides: Record<string, unknown> = {}
) => ({
  eligible: true,
  ineligible_reason: null,
  at_limit: false,
  exhausted: [],
  grants,
  next_grant_id: (grants[0] as { id?: string } | undefined)?.id ?? null,
  weekly_resets_at: "2026-10-19T19:00:00+00:00",
  cooldown_until: null,
  event_props: { surface: "claude_code_cli", tier: "claude_max_5x" },
  ...overrides,
});

const usageBody = (block: unknown) => ({
  five_hour: {
    utilization: 40,
    resets_at: new Date(Date.now() + 60 * MINUTE).toISOString(),
  },
  seven_day: {
    utilization: 20,
    resets_at: new Date(Date.now() + 7 * 24 * 60 * MINUTE).toISOString(),
  },
  extra_usage: { is_enabled: true, monthly_limit: 5000 },
  limits: [],
  cedar_ember: block,
});

type ClaimCall = { url: string; body: Record<string, unknown> };

const upstream = {
  usage: (): Response | Promise<Response> => Response.json(usageBody(cedar())),
  claim: (_call: ClaimCall): Response | Promise<Response> =>
    Response.json({
      result: "reset",
      reason: null,
      resets_left: 1,
      cleared: ["five_hour", "seven_day"],
      weekly_resets_at: "2026-10-19T19:00:00+00:00",
    }),
  organization: ORGANIZATION,
  account: ACCOUNT,
  profile: (): Response =>
    Response.json({
      account: { uuid: upstream.account },
      organization: {
        uuid: upstream.organization,
        organization_type: "claude_max",
      },
    }),
  refresh: (): Response => {
    throw new Error("Unexpected token refresh");
  },
  usageUrls: [] as string[],
  claims: [] as ClaimCall[],
  claimHeaders: [] as Headers[],
};

const originalFetch = globalThis.fetch;

const mockAnthropic = (() =>
  ((input: string | URL | Request, init?: RequestInit) => {
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
      return Promise.resolve(upstream.usage());
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
  }) as unknown as typeof fetch)();

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

describe("Claude reset claims", () => {
  let client: ReturnType<typeof createClient>;
  let database: Database;
  let directory: string;
  let startedAt: number;

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

  const readQuota = (account: ProviderAccountRecord) =>
    listProviderAccountQuotas(database, [account]);

  const claimRows = (account: ProviderAccountRecord) =>
    database
      .select()
      .from(claudeResetClaims)
      .where(eq(claudeResetClaims.providerAccountId, account.id));

  const view = async (account: ProviderAccountRecord) => {
    const { claims, fences } =
      await claimRepository.listProviderAccountsWithClaudeResetClaims(
        database,
        startedAt - 10 * MINUTE
      );
    return describeClaudeResets(account, claims, fences);
  };

  const offerOf = async (account: ProviderAccountRecord) => {
    const offer = (await view(account))?.offer;
    if (!offer) throw new Error("no offer");
    return { grantId: offer.grantId, offerKey: offer.key };
  };

  const conflictOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof ClaudeResetClaimConflict) return error.reason;
      throw error;
    }
    throw new Error("expected a conflict");
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kleis-claude-resets-"));
    client = createClient({ url: `file:${join(directory, "test.db")}` });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    setAccountSnapshotStore(null);
    startedAt = Date.now();
    setSystemTime(new Date(startedAt));
    upstream.usage = () => Response.json(usageBody(cedar()));
    upstream.claim = () =>
      Response.json({
        result: "reset",
        reason: null,
        resets_left: 1,
        cleared: ["five_hour", "seven_day"],
        weekly_resets_at: "2026-10-19T19:00:00+00:00",
      });
    upstream.organization = ORGANIZATION;
    upstream.account = ACCOUNT;
    upstream.profile = () =>
      Response.json({
        account: { uuid: upstream.account },
        organization: {
          uuid: upstream.organization,
          organization_type: "claude_max",
        },
      });
    upstream.refresh = () => {
      throw new Error("Unexpected token refresh");
    };
    upstream.usageUrls = [];
    upstream.claims = [];
    upstream.claimHeaders = [];
    globalThis.fetch = mockAnthropic;
  });

  afterEach(async () => {
    await flush();
    globalThis.fetch = originalFetch;
    setSystemTime();
    client.close();
    await rm(directory, { recursive: true, force: true });
  });

  test("reads resets with the usual usage poll and keeps spend data", async () => {
    const account = await addAccount();
    const quotas = await readQuota(account);

    expect(upstream.usageUrls).toEqual([
      "https://api.anthropic.com/api/oauth/usage?cedar_ember=1",
    ]);
    const data = quotas.get(account.id)?.data;
    expect(data).toMatchObject({
      subscription: { extraUsage: { isEnabled: true, monthlyLimit: 5000 } },
      resetCredits: { observedAt: startedAt, status: { eligible: true } },
    });
    expect(JSON.stringify(data)).not.toContain("event_props");
    expect(JSON.stringify(data)).not.toContain("claude_code_cli");
    expect(JSON.stringify(data)).not.toContain(ORGANIZATION);
    expect(await view(account)).toMatchObject({
      saved: 2,
      clears: ["five_hour", "seven_day", "seven_day_overage_included"],
      unavailable: null,
      offer: {
        grantId: "grant_fake_1",
        earlyUse: { limit: "five_hour", percentUsed: 40 },
      },
      claim: null,
    });
  });

  test("traffic never refreshes the resets' read time and an unevaluated read keeps them", async () => {
    const account = await addAccount();
    await readQuota(account);

    setSystemTime(new Date(startedAt + MINUTE));
    recordProviderAccountLiveLimits(
      account,
      readClaudeLiveLimits(
        new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.5" })
      )
    );
    let quotas = await readQuota(account);
    expect(quotas.get(account.id)).toMatchObject({
      fetchedAt: startedAt + MINUTE,
      data: { resetCredits: { observedAt: startedAt } },
    });

    upstream.usage = () => Response.json(usageBody(null));
    setSystemTime(new Date(startedAt + 5 * MINUTE));
    await readQuota(account);
    await flush();
    quotas = await readQuota(account);
    expect(quotas.get(account.id)).toMatchObject({
      fetchedAt: startedAt + 5 * MINUTE,
      data: { resetCredits: { observedAt: startedAt } },
    });
  });

  test("claims the confirmed reset once with a request ID recorded before sending", async () => {
    const account = await addAccount();
    await readQuota(account);
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
        weekly_resets_at: "2026-10-19T19:00:00+00:00",
      });
    };
    const info = spyOn(console, "info").mockImplementation(() => undefined);

    try {
      const outcome = await claimClaudeReset(database, account.id, offer);

      expect(outcome).toMatchObject({
        status: "completed",
        result: "reset",
        resetsLeft: 1,
        cleared: ["five_hour", "seven_day"],
      });
      expect(upstream.claims).toHaveLength(1);
      const [call] = upstream.claims;
      expect(call?.url).toBe(
        `https://api.anthropic.com/api/organizations/${ORGANIZATION}/reset_rate_limits`
      );
      expect(call?.body).toEqual({
        program: "cedar_ember",
        grant_id: "grant_fake_1",
        request_id: outcome?.requestId,
      });
      expect(upstream.claimHeaders[0]?.get("authorization")).toBe(
        `Bearer ${account.accessToken}`
      );
      expect(upstream.claimHeaders[0]?.get("content-type")).toBe(
        "application/json"
      );
      expect(recordedBeforeSend).toMatchObject([
        { status: "pending", grantId: "grant_fake_1" },
      ]);
      expect(await claimRows(account)).toMatchObject([
        { status: "completed", result: "reset", resetsLeft: 1 },
      ]);
      const logged = info.mock.calls.map((args) => String(args[0])).join("\n");
      expect(logged).toContain("claude_reset_claim_settled");
      expect(logged).not.toContain("grant_fake_1");
      expect(logged).not.toContain(ORGANIZATION);
      expect(logged).not.toContain(String(outcome?.requestId));
    } finally {
      info.mockRestore();
    }
  });

  test("a read started before the claim settled can't bring the used reset back", async () => {
    const account = await addAccount();
    await readQuota(account);
    const offer = await offerOf(account);
    const pending: ((response: Response) => void)[] = [];
    upstream.usage = () =>
      new Promise<Response>((resolve) => {
        pending.push(resolve);
      });
    setSystemTime(new Date(startedAt + 4 * MINUTE));
    await readQuota(account);
    await flush();
    expect(pending).toHaveLength(1);

    const outcome = await claimClaudeReset(database, account.id, offer);
    await flush();
    expect(outcome?.status).toBe("completed");
    expect(pending).toHaveLength(2);

    pending[0]?.(Response.json(usageBody(cedar())));
    await flush();
    expect(await view(account)).toBeNull();

    pending[1]?.(Response.json(usageBody(cedar([grant({ resets_left: 1 })]))));
    await flush();
    const after = await view(account);
    expect(after).toMatchObject({ saved: 1 });
    expect(after?.offer?.key).not.toBe(offer.offerKey);
  });

  test("a successful reset stays successful when the refresh after it fails", async () => {
    const account = await addAccount();
    await readQuota(account);
    const offer = await offerOf(account);
    upstream.usage = () => Response.json({}, { status: 500 });

    const outcome = await claimClaudeReset(database, account.id, offer);
    await flush();

    expect(outcome?.status).toBe("completed");
    expect(await view(account)).toBeNull();
  });

  for (const [name, respond] of [
    [
      "a timeout after the reset was spent",
      () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    ],
    ["a server error", () => Response.json({}, { status: 502 })],
    ["a malformed success", () => new Response("<html>", { status: 200 })],
    ["an unknown result", () => Response.json({ result: "granted" })],
    [
      "an unconfirmed reset",
      () => Response.json({ result: "reset", reason: "reset_unconfirmed" }),
    ],
    ["an unavailable result", () => Response.json({ result: "unavailable" })],
  ] as const) {
    test(`${name} is unconfirmed and blocks claims until a later read`, async () => {
      const account = await addAccount();
      await readQuota(account);
      const offer = await offerOf(account);
      upstream.claim = respond;
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const outcome = await claimClaudeReset(database, account.id, offer);
        expect(outcome?.status).toBe("ambiguous");
        expect(await claimRows(account)).toMatchObject([
          { status: "ambiguous" },
        ]);
        await flush();
        expect(await view(account)).toMatchObject({
          offer: null,
          claim: { status: "ambiguous" },
        });

        upstream.claim = () => Response.json({ result: "reset" });
        expect(
          await conflictOf(claimClaudeReset(database, account.id, offer))
        ).toBe("claim_unconfirmed");
        expect(upstream.claims).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("after a later read, retrying the same reset reuses its request ID", async () => {
    const account = await addAccount();
    await readQuota(account);
    const offer = await offerOf(account);
    upstream.claim = () => Response.json({}, { status: 503 });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const first = await claimClaudeReset(database, account.id, offer);
      expect(first?.status).toBe("ambiguous");

      await flush();
      setSystemTime(new Date(startedAt + 4 * MINUTE));
      await readQuota(account);
      await flush();
      expect(await view(account)).toMatchObject({ claim: null });
      const retryOffer = await offerOf(account);

      upstream.claim = () =>
        Response.json({ result: "already_used", reason: "already_used" });
      const second = await claimClaudeReset(database, account.id, retryOffer);

      expect(second).toMatchObject({
        status: "completed",
        result: "already_used",
        requestId: first?.requestId,
      });
      expect(upstream.claims.map((call) => call.body.request_id)).toEqual([
        first?.requestId,
        first?.requestId,
      ]);
      expect(await claimRows(account)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a later read showing another reset closes the unconfirmed claim", async () => {
    const account = await addAccount();
    await readQuota(account);
    const offer = await offerOf(account);
    upstream.claim = () => Response.json({}, { status: 500 });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await claimClaudeReset(database, account.id, offer);
      await flush();
      upstream.usage = () =>
        Response.json(usageBody(cedar([grant({ id: "grant_fake_2" })])));
      setSystemTime(new Date(startedAt + 4 * MINUTE));
      await readQuota(account);
      await flush();
      upstream.claim = () => Response.json({ result: "reset" });
      const outcome = await claimClaudeReset(
        database,
        account.id,
        await offerOf(account)
      );
      expect(outcome?.status).toBe("completed");
      const rows = await claimRows(account);
      expect(rows.map((row) => row.status).sort()).toEqual([
        "completed",
        "reconciled",
      ]);
      expect(new Set(rows.map((row) => row.requestId)).size).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("a refusal means nothing was used and is not retried", async () => {
    const account = await addAccount();
    await readQuota(account);
    const offer = await offerOf(account);
    upstream.claim = () =>
      Response.json({ error: "rate_limited" }, { status: 429 });
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const outcome = await claimClaudeReset(database, account.id, offer);
      expect(outcome).toMatchObject({ status: "failed", httpStatus: 429 });
      expect(upstream.claims).toHaveLength(1);
      expect(await claimRows(account)).toMatchObject([
        { status: "failed", lastError: "HTTP 429" },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("definite outcomes other than reset are recorded as they are", async () => {
    const account = await addAccount();
    await readQuota(account);
    upstream.claim = () =>
      Response.json({
        result: "cooldown",
        reason: "cooldown",
        cooldown_until: "2026-10-15T13:00:00+00:00",
      });
    const outcome = await claimClaudeReset(
      database,
      account.id,
      await offerOf(account)
    );
    expect(outcome).toMatchObject({
      status: "completed",
      result: "cooldown",
      reason: "cooldown",
    });
  });

  test("two claims at once send one request", async () => {
    const account = await addAccount();
    await readQuota(account);
    const offer = await offerOf(account);
    let release: (() => void) | undefined;
    upstream.claim = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(Response.json({ result: "reset" }));
      });

    const first = claimClaudeReset(database, account.id, offer);
    while (!release) await Bun.sleep(1);
    expect(
      await conflictOf(claimClaudeReset(database, account.id, offer))
    ).toBe("claim_in_progress");
    release();
    expect((await first)?.status).toBe("completed");
    expect(upstream.claims).toHaveLength(1);
  });

  test("an open claim from another process blocks this one, and becomes unconfirmed if orphaned", async () => {
    const account = await addAccount();
    await readQuota(account);
    const offer = await offerOf(account);
    await database.insert(claudeResetClaims).values({
      requestId: "other-process-request",
      providerAccountId: account.id,
      accountIdentity: ACCOUNT,
      organizationUuid: ORGANIZATION,
      program: "cedar_ember",
      grantId: "grant_fake_1",
      offerKey: offer.offerKey,
      status: "pending",
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    expect(
      await conflictOf(claimClaudeReset(database, account.id, offer))
    ).toBe("claim_in_progress");
    expect(await view(account)).toMatchObject({ claim: { status: "pending" } });

    setSystemTime(new Date(startedAt + 3 * MINUTE));
    expect(await view(account)).toMatchObject({
      claim: { status: "ambiguous" },
    });
    expect(
      await conflictOf(claimClaudeReset(database, account.id, offer))
    ).toBe("claim_unconfirmed");
    expect(upstream.claims).toHaveLength(0);

    await expect(
      (async () =>
        await database.insert(claudeResetClaims).values({
          requestId: "second-open-request",
          providerAccountId: account.id,
          accountIdentity: ACCOUNT,
          organizationUuid: ORGANIZATION,
          program: "cedar_ember",
          grantId: "grant_fake_1",
          offerKey: offer.offerKey,
          status: "ambiguous",
          createdAt: startedAt,
          updatedAt: startedAt,
        }))()
    ).rejects.toThrow();
  });

  test("resets read before another process's claim are not offered", async () => {
    const account = await addAccount();
    await readQuota(account);
    const offer = await offerOf(account);
    setSystemTime(new Date(startedAt + MINUTE));
    await database.insert(claudeResetClaims).values({
      requestId: "other-process-request",
      providerAccountId: account.id,
      accountIdentity: ACCOUNT,
      organizationUuid: ORGANIZATION,
      program: "cedar_ember",
      grantId: "grant_fake_1",
      offerKey: offer.offerKey,
      status: "completed",
      result: "reset",
      createdAt: startedAt + MINUTE,
      updatedAt: startedAt + MINUTE,
    });
    expect(await view(account)).toMatchObject({
      offer: null,
      unavailable: "checking",
    });
    setSystemTime(new Date(startedAt + 2 * MINUTE));

    upstream.usage = () =>
      Response.json(usageBody(cedar([grant({ resets_left: 1 })])));
    const outcome = await claimClaudeReset(database, account.id, offer).catch(
      (error: unknown) => error
    );
    expect(outcome).toBeInstanceOf(ClaudeResetClaimConflict);
    expect((outcome as ClaudeResetClaimConflict).reason).toBe("offer_changed");
    expect(upstream.claims).toHaveLength(0);
  });

  test("a changed or unusable offer needs a new confirmation", async () => {
    const account = await addAccount();
    await readQuota(account);
    const offer = await offerOf(account);
    expect(
      await conflictOf(
        claimClaudeReset(database, account.id, {
          ...offer,
          offerKey: "0".repeat(32),
        })
      )
    ).toBe("offer_changed");

    upstream.usage = () =>
      Response.json(usageBody(cedar([grant({ use_requires_limit: true })])));
    setSystemTime(new Date(startedAt + 11 * MINUTE));
    expect(
      await conflictOf(claimClaudeReset(database, account.id, offer))
    ).toBe("not_claimable");
    expect(await view(account)).toMatchObject({
      offer: null,
      unavailable: "requires_limit",
      saved: 2,
    });
    expect(upstream.claims).toHaveLength(0);
  });

  test("a stale offer during the shared rate-limit pause sends nothing", async () => {
    const account = await addAccount();
    await readQuota(account);
    const offer = await offerOf(account);
    upstream.usage = () =>
      Response.json({ error: { type: "rate_limit_error" } }, { status: 429 });
    setSystemTime(new Date(startedAt + 11 * MINUTE));

    expect(
      await conflictOf(claimClaudeReset(database, account.id, offer))
    ).toBe("stale");
    expect(upstream.usageUrls).toHaveLength(2);

    expect(
      await conflictOf(claimClaudeReset(database, account.id, offer))
    ).toBe("stale");
    expect(upstream.usageUrls).toHaveLength(2);
    expect(upstream.claims).toHaveLength(0);

    // Leave the shared pause cleared for other tests.
    upstream.usage = () => Response.json(usageBody(cedar()));
    setSystemTime(new Date(startedAt + 14 * MINUTE));
    await readQuota(account);
    await flush();
  });

  test("the organization comes from the stored identity and must match the profile", async () => {
    const unknown = await addAccount({});
    upstream.organization = "";
    await readQuota(unknown);
    expect(
      await conflictOf(
        claimClaudeReset(database, unknown.id, {
          grantId: "grant_fake_1",
          offerKey: "0".repeat(32),
        })
      )
    ).toBe("organization_unknown");

    upstream.organization = "00000000-0000-4000-8000-000000000002";
    const moved = await addAccount();
    await readQuota(moved);
    expect(
      await conflictOf(
        claimClaudeReset(database, moved.id, {
          grantId: "grant_fake_1",
          offerKey: "0".repeat(32),
        })
      )
    ).toBe("identity_changed");
    expect(upstream.claims).toHaveLength(0);
  });

  test("non-Claude and missing accounts are not claimed", async () => {
    expect(
      await claimClaudeReset(database, "missing", {
        grantId: "grant_fake_1",
        offerKey: "0".repeat(32),
      })
    ).toBeNull();
    expect(upstream.claims).toHaveLength(0);
  });

  test.each([false, true])(
    "reservation fences a completed claim when a delayed INSERT resumes (duplicate row: %s)",
    async (duplicate) => {
      const firstAccount = await addAccount();
      const secondAccount = duplicate ? await addAccount() : firstAccount;
      await readQuota(firstAccount);
      if (duplicate) await readQuota(secondAccount);
      const confirmed = await offerOf(secondAccount);
      const contenderClient = createClient({
        url: `file:${join(directory, "test.db")}`,
      });
      const contender = drizzle(contenderClient, { schema });
      const entered = gate();
      const resume = gate();
      const insert = claimRepository.insertClaudeResetClaim;
      let calls = 0;
      const paused = spyOn(
        claimRepository,
        "insertClaudeResetClaim"
      ).mockImplementation(async (...args) => {
        if (++calls === 1) {
          entered.release();
          await resume.promise;
        }
        await insert(...args);
      });
      const delayed = claimClaudeReset(
        contender,
        secondAccount.id,
        confirmed
      ).catch((error: unknown) => error);
      try {
        await entered.promise;
        expect(
          (await claimClaudeReset(database, firstAccount.id, confirmed))?.status
        ).toBe("completed");
        resume.release();
        const outcome = await delayed;
        expect(outcome).toBeInstanceOf(ClaudeResetClaimConflict);
        expect(upstream.claims).toHaveLength(1);
      } finally {
        resume.release();
        paused.mockRestore();
        await delayed;
        contenderClient.close();
      }
    }
  );

  test("duplicate local rows with a null accountId share the OAuth identity's active fence", async () => {
    const first = await addAccount();
    const second = await addAccount();
    expect(first.accountId).toBeNull();
    expect(second.accountId).toBeNull();
    await readQuota(first);
    await readQuota(second);
    const confirmed = await offerOf(first);
    const sending = gate();
    const release = gate();
    upstream.claim = async () => {
      if (upstream.claims.length === 1) {
        sending.release();
        await release.promise;
      }
      return Response.json({ result: "reset" });
    };
    const pending = claimClaudeReset(database, first.id, confirmed);
    try {
      await sending.promise;
      const duplicate = await claimClaudeReset(
        database,
        second.id,
        confirmed
      ).catch((error: unknown) => error);
      expect(duplicate).toBeInstanceOf(ClaudeResetClaimConflict);
      expect(upstream.claims).toHaveLength(1);
    } finally {
      release.release();
      await pending;
    }
  });

  test.each(["organization", "account", "offer", "none"])(
    "proactive refresh cannot change the confirmed %s identity",
    async (changed) => {
      const account = await addAccount();
      await readQuota(account);
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
          account: {
            uuid:
              changed === "account"
                ? "10000000-0000-4000-8000-000000000002"
                : ACCOUNT,
          },
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
      const result = await claimClaudeReset(
        database,
        account.id,
        confirmed
      ).catch((error: unknown) => error);
      if (changed === "none") {
        expect(result).toMatchObject({ status: "completed", result: "reset" });
        expect(upstream.claims).toHaveLength(1);
      } else {
        expect(result).toBeInstanceOf(ClaudeResetClaimConflict);
        expect(upstream.claims).toHaveLength(0);
        expect(await claimRows(account)).toHaveLength(0);
      }
    }
  );

  test("a natural reset requires a new early-use confirmation before dispatch", async () => {
    const account = await addAccount();
    const initial = grant({
      clears: ["five_hour"],
      percent_used: { five_hour: 100 },
    });
    upstream.usage = () =>
      Response.json({
        ...usageBody(
          cedar([initial], { at_limit: true, exhausted: ["five_hour"] })
        ),
        five_hour: {
          utilization: 100,
          resets_at: new Date(startedAt + 5 * 60 * MINUTE).toISOString(),
        },
      });
    await readQuota(account);
    const confirmed = await offerOf(account);
    expect((await view(account))?.offer?.earlyUse).toBeNull();
    upstream.usage = () =>
      Response.json({
        ...usageBody(cedar([{ ...initial, percent_used: { five_hour: 0 } }])),
        five_hour: {
          utilization: 0,
          resets_at: new Date(startedAt + 5 * 60 * MINUTE).toISOString(),
        },
      });
    setSystemTime(new Date(startedAt + 4 * MINUTE));
    await readQuota(account);
    await flush();
    expect((await view(account))?.offer?.earlyUse?.percentUsed).toBe(0);
    const result = await claimClaudeReset(
      database,
      account.id,
      confirmed
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ClaudeResetClaimConflict);
    expect(upstream.claims).toHaveLength(0);
  });

  test.each([
    { clears: ["five_hour", "unknown_window"] },
    { blocking: ["unknown_window"] },
  ])(
    "unknown grant limits disable claiming but preserve ordinary usage: %j",
    async (fields) => {
      const account = await addAccount();
      await readQuota(account);
      const confirmed = await offerOf(account);
      upstream.usage = () => Response.json(usageBody(cedar([grant(fields)])));
      setSystemTime(new Date(startedAt + 4 * MINUTE));
      await readQuota(account);
      await flush();
      const quotas = await readQuota(account);
      expect(quotas.get(account.id)?.data).toMatchObject({
        subscription: { fiveHour: { utilization: 40 } },
      });
      expect((await view(account))?.offer).toBeNull();
      expect((await view(account))?.unavailable).toBe("unsupported_limits");
      const result = await claimClaudeReset(
        database,
        account.id,
        confirmed
      ).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(ClaudeResetClaimConflict);
      expect(upstream.claims).toHaveLength(0);
    }
  );

  test("a completed reservation invalidates the confirmed key even beyond the ledger lookback", async () => {
    const first = await addAccount();
    const second = await addAccount();
    const block = cedar();
    upstream.usage = () => Response.json(usageBody(block));
    await readQuota(first);
    await readQuota(second);
    const confirmed = await offerOf(second);
    await claimClaudeReset(database, first.id, confirmed);
    await flush();
    setSystemTime(new Date(startedAt + 14 * MINUTE));
    const result = await claimClaudeReset(database, second.id, confirmed).catch(
      (error: unknown) => error
    );
    expect(result).toBeInstanceOf(ClaudeResetClaimConflict);
    expect(upstream.claims).toHaveLength(1);
    expect((await offerOf(second)).offerKey).not.toBe(confirmed.offerKey);
  });

  test.each([ACCOUNT.toUpperCase(), "10000000-0000-4000-8000-000000000002"])(
    "identical grant data binds the canonical OAuth user: %s",
    async (nextAccount) => {
      const first = await addAccount();
      await readQuota(first);
      const confirmed = await offerOf(first);
      upstream.account = nextAccount;
      const second = await addAccount({
        accountUuid: upstream.account,
        organizationUuid: ORGANIZATION,
      });
      await readQuota(second);
      const key = (await offerOf(second)).offerKey;
      if (nextAccount === ACCOUNT.toUpperCase())
        expect(key).toBe(confirmed.offerKey);
      else expect(key).not.toBe(confirmed.offerKey);
    }
  );

  test.each(["live", "boundary", "reset-only"])(
    "current limits require renewed early-use confirmation after a natural reset: %s",
    async (source) => {
      const account = await addAccount();
      const block = cedar(
        [grant({ clears: ["five_hour"], percent_used: { five_hour: 100 } })],
        { exhausted: ["five_hour"], at_limit: true }
      );
      upstream.usage = () =>
        Response.json({
          ...usageBody(block),
          five_hour: {
            utilization: 100,
            resets_at: new Date(startedAt + MINUTE).toISOString(),
          },
        });
      await readQuota(account);
      const confirmed = await offerOf(account);
      expect((await view(account))?.offer?.earlyUse).toBeNull();
      setSystemTime(new Date(startedAt + 2 * MINUTE));
      if (source === "live")
        recordProviderAccountLiveLimits(
          account,
          readClaudeLiveLimits(
            new Headers({
              "anthropic-ratelimit-unified-5h-utilization": "0",
              "anthropic-ratelimit-unified-5h-reset": String(
                (startedAt + 5 * 60 * MINUTE) / 1000
              ),
            })
          )
        );
      if (source === "reset-only")
        recordProviderAccountLiveLimits(
          account,
          readClaudeLiveLimits(
            new Headers({
              "anthropic-ratelimit-unified-5h-reset": String(
                (startedAt + 5 * 60 * MINUTE) / 1000
              ),
            })
          )
        );
      const outcome = await claimClaudeReset(
        database,
        account.id,
        confirmed
      ).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(ClaudeResetClaimConflict);
      expect((outcome as ClaudeResetClaimConflict).reason).toBe(
        "offer_changed"
      );
      expect(upstream.claims).toHaveLength(0);
      expect(upstream.usageUrls).toHaveLength(1);
      expect((await view(account))?.offer?.earlyUse?.percentUsed).toBe(
        source === "reset-only" ? null : 0
      );
      expect((await offerOf(account)).offerKey).not.toBe(confirmed.offerKey);
    }
  );

  test.each([false, true])(
    "reauthorization with identity-less credentials cannot claim using a retained display profile (expire: %s)",
    async (expire) => {
      const account = await addAccount();
      await readQuota(account);
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
      upstream.profile = () =>
        Response.json({ error: "profile unavailable" }, { status: 503 });
      await readQuota(replaced);
      await flush();
      const outcome = await claimClaudeReset(
        database,
        account.id,
        confirmed
      ).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(ClaudeResetClaimConflict);
      expect(upstream.claims).toHaveLength(0);
      expect((await view(replaced))?.offer).toBeNull();
      expect((await view(replaced))?.unavailable).toBe("identity_unverified");
    }
  );

  test("reset discovery stays due at the normal pace under continuous proxy traffic", async () => {
    const account = await addAccount();
    const unsupported = cedar([
      grant({ clears: ["five_hour", "unknown_window"] }),
    ]);
    upstream.usage = () => Response.json(usageBody(unsupported));
    await readQuota(account);
    expect((await view(account))?.unavailable).toBe("unsupported_limits");
    upstream.usage = () => Response.json(usageBody(cedar()));
    for (let minute = 1; minute <= 4; minute++) {
      setSystemTime(new Date(startedAt + minute * MINUTE));
      recordProviderAccountLiveLimits(
        account,
        readClaudeLiveLimits(
          new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.4" })
        )
      );
      await readQuota(account);
      await flush();
      if (minute < 3) expect(upstream.usageUrls).toHaveLength(1);
    }
    expect(upstream.usageUrls).toHaveLength(2);
    expect((await view(account))?.unavailable).toBeNull();
    expect((await view(account))?.offer).not.toBeNull();
  });

  test("a live reset during ledger reservation is checked again before sending", async () => {
    const account = await addAccount();
    const block = cedar(
      [grant({ clears: ["five_hour"], percent_used: { five_hour: 100 } })],
      { exhausted: ["five_hour"] }
    );
    upstream.usage = () =>
      Response.json({
        ...usageBody(block),
        five_hour: {
          utilization: 100,
          resets_at: new Date(startedAt + 5 * 60 * MINUTE).toISOString(),
        },
      });
    await readQuota(account);
    const confirmed = await offerOf(account);
    const insert = claimRepository.insertClaudeResetClaim;
    const intercepted = spyOn(
      claimRepository,
      "insertClaudeResetClaim"
    ).mockImplementation(async (...args) => {
      await insert(...args);
      setSystemTime(new Date(startedAt + MINUTE));
      recordProviderAccountLiveLimits(
        account,
        readClaudeLiveLimits(
          new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0" })
        )
      );
    });
    try {
      expect(
        await conflictOf(claimClaudeReset(database, account.id, confirmed))
      ).toBe("offer_changed");
      expect(upstream.claims).toHaveLength(0);
      expect(await claimRows(account)).toMatchObject([{ status: "failed" }]);
    } finally {
      intercepted.mockRestore();
    }
  });

  test("aborting a reused reservation keeps the original ambiguous claim fenced", async () => {
    const account = await addAccount();
    const block = cedar(
      [grant({ clears: ["five_hour"], percent_used: { five_hour: 100 } })],
      { exhausted: ["five_hour"] }
    );
    upstream.usage = () =>
      Response.json({
        ...usageBody(block),
        five_hour: {
          utilization: 100,
          resets_at: new Date(startedAt + 5 * 60 * MINUTE).toISOString(),
        },
      });
    await readQuota(account);
    upstream.claim = () => Response.json({}, { status: 503 });
    const first = await claimClaudeReset(
      database,
      account.id,
      await offerOf(account)
    );
    await flush();
    setSystemTime(new Date(startedAt + 4 * MINUTE));
    await readQuota(account);
    await flush();
    const confirmed = await offerOf(account);
    const reopen = claimRepository.reopenClaudeResetClaim;
    const intercepted = spyOn(
      claimRepository,
      "reopenClaudeResetClaim"
    ).mockImplementation(async (...args) => {
      await reopen(...args);
      recordProviderAccountLiveLimits(
        account,
        readClaudeLiveLimits(
          new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0" })
        )
      );
    });
    try {
      expect(
        await conflictOf(claimClaudeReset(database, account.id, confirmed))
      ).toBe("offer_changed");
      expect(upstream.claims).toHaveLength(1);
      expect(await claimRows(account)).toMatchObject([
        { status: "ambiguous", requestId: first?.requestId },
      ]);
    } finally {
      intercepted.mockRestore();
    }
  });

  test("a successful profile lookup for the current credential can supply missing token identity", async () => {
    const account = await addAccount({});
    await readQuota(account);
    expect(
      (await claimClaudeReset(database, account.id, await offerOf(account)))
        ?.status
    ).toBe("completed");
    expect(upstream.claims).toHaveLength(1);
  });

  test.each([false, true])(
    "a slow poll cannot overwrite newer live limits used in the confirmation (reset-only: %s)",
    async (resetOnly) => {
      const account = await addAccount();
      const block = cedar(
        [grant({ clears: ["five_hour"], percent_used: { five_hour: 100 } })],
        { exhausted: ["five_hour"] }
      );
      const body = {
        ...usageBody(block),
        five_hour: {
          utilization: 100,
          resets_at: new Date(startedAt + 5 * 60 * MINUTE).toISOString(),
        },
      };
      upstream.usage = () => Response.json(body);
      await readQuota(account);
      const confirmed = await offerOf(account);
      let finish: (response: Response) => void = () => undefined;
      upstream.usage = () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        });
      setSystemTime(new Date(startedAt + 3 * MINUTE));
      await readQuota(account);
      await flush();
      setSystemTime(new Date(startedAt + 3 * MINUTE + 1000));
      if (resetOnly)
        recordProviderAccountLiveLimits(
          account,
          readClaudeLiveLimits(
            new Headers({
              "anthropic-ratelimit-unified-5h-utilization": "1",
              "anthropic-ratelimit-unified-5h-reset": String(
                (startedAt + 5 * 60 * MINUTE) / 1000
              ),
            })
          )
        );
      recordProviderAccountLiveLimits(
        account,
        readClaudeLiveLimits(
          new Headers(
            resetOnly
              ? {
                  "anthropic-ratelimit-unified-5h-reset": String(
                    (startedAt + 6 * 60 * MINUTE) / 1000
                  ),
                }
              : { "anthropic-ratelimit-unified-5h-utilization": "0" }
          )
        )
      );
      finish(Response.json(body));
      await flush();
      expect((await view(account))?.offer?.earlyUse?.percentUsed).toBe(
        resetOnly ? null : 0
      );
      expect(
        await conflictOf(claimClaudeReset(database, account.id, confirmed))
      ).toBe("offer_changed");
      expect(upstream.claims).toHaveLength(0);
      upstream.usage = () => Response.json(body);
      setSystemTime(new Date(startedAt + 6 * MINUTE));
      await readQuota(account);
      await flush();
      expect((await view(account))?.offer?.earlyUse).toBeNull();
    }
  );

  test("reset discovery under traffic still respects the shared 429 pause and retry pace", async () => {
    const account = await addAccount();
    upstream.usage = () =>
      Response.json(
        usageBody(cedar([grant({ blocking: ["unknown_window"] })]))
      );
    await readQuota(account);
    upstream.usage = () => Response.json({}, { status: 429 });
    try {
      for (let minute = 1; minute <= 4; minute++) {
        setSystemTime(new Date(startedAt + minute * MINUTE));
        recordProviderAccountLiveLimits(
          account,
          readClaudeLiveLimits(
            new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.4" })
          )
        );
        await readQuota(account);
        await flush();
      }
      expect(upstream.usageUrls).toHaveLength(2);
    } finally {
      upstream.usage = () => Response.json(usageBody(cedar()));
      setSystemTime(new Date(startedAt + 5 * MINUTE + 1000));
      recordProviderAccountLiveLimits(
        account,
        readClaudeLiveLimits(
          new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.4" })
        )
      );
      await readQuota(account);
      await flush();
    }
    expect(upstream.usageUrls).toHaveLength(3);
    expect((await view(account))?.offer).not.toBeNull();
    for (let minute = 6; minute <= 7; minute++) {
      setSystemTime(new Date(startedAt + minute * MINUTE));
      recordProviderAccountLiveLimits(
        account,
        readClaudeLiveLimits(
          new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.4" })
        )
      );
      await readQuota(account);
      await flush();
    }
    expect(upstream.usageUrls).toHaveLength(3);
  });

  test.each([false, true])(
    "a rejected token retry rechecks current limits without changing the request ID (reset: %s)",
    async (reset) => {
      const account = await addAccount();
      const block = cedar(
        [grant({ clears: ["five_hour"], percent_used: { five_hour: 100 } })],
        { exhausted: ["five_hour"] }
      );
      upstream.usage = () =>
        Response.json({
          ...usageBody(block),
          five_hour: {
            utilization: 100,
            resets_at: new Date(startedAt + 5 * 60 * MINUTE).toISOString(),
          },
        });
      await readQuota(account);
      const confirmed = await offerOf(account);
      upstream.claim = () =>
        upstream.claims.length === 1
          ? Response.json({}, { status: 401 })
          : Response.json({ result: "reset" });
      upstream.refresh = () => {
        if (reset)
          recordProviderAccountLiveLimits(
            account,
            readClaudeLiveLimits(
              new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0" })
            )
          );
        return Response.json({
          access_token: "fake-refreshed-access",
          refresh_token: "fake-refreshed-token",
          expires_in: 3600,
          account: { uuid: ACCOUNT },
          organization: { uuid: ORGANIZATION },
        });
      };
      const outcome = await claimClaudeReset(
        database,
        account.id,
        confirmed
      ).catch((error: unknown) => error);
      if (reset) {
        expect(outcome).toBeInstanceOf(ClaudeResetClaimConflict);
        expect(upstream.claims).toHaveLength(1);
      } else {
        expect(outcome).toMatchObject({ status: "completed", result: "reset" });
        expect(upstream.claims).toHaveLength(2);
        expect(upstream.claims[0]?.body.request_id).toBe(
          upstream.claims[1]?.body.request_id
        );
      }
    }
  );

  test("a reset block refreshed during reservation must still match before dispatch", async () => {
    const account = await addAccount();
    await readQuota(account);
    const confirmed = await offerOf(account);
    const insert = claimRepository.insertClaudeResetClaim;
    const intercepted = spyOn(
      claimRepository,
      "insertClaudeResetClaim"
    ).mockImplementation(async (...args) => {
      await insert(...args);
      upstream.usage = () =>
        Response.json(
          usageBody(cedar([grant({ blocking: ["unknown_window"] })]))
        );
      await refreshClaudeResetCredits(database, account);
    });
    try {
      expect(
        await conflictOf(claimClaudeReset(database, account.id, confirmed))
      ).toBe("not_claimable");
      expect(upstream.claims).toHaveLength(0);
      expect(await claimRows(account)).toMatchObject([{ status: "failed" }]);
    } finally {
      intercepted.mockRestore();
    }
  });

  test("an exhausted reset block cannot suppress the warning when current window usage is unknown", async () => {
    const account = await addAccount();
    const block = cedar(
      [grant({ clears: ["five_hour"], percent_used: { five_hour: 100 } })],
      { exhausted: ["five_hour"] }
    );
    upstream.usage = () =>
      Response.json({
        ...usageBody(block),
        five_hour: {
          utilization: 100,
          resets_at: new Date(startedAt + 5 * 60 * MINUTE).toISOString(),
        },
      });
    await readQuota(account);
    const confirmed = await offerOf(account);
    upstream.usage = () =>
      Response.json({ ...usageBody(block), five_hour: null });
    setSystemTime(new Date(startedAt + 3 * MINUTE));
    await readQuota(account);
    await flush();
    expect(
      await conflictOf(claimClaudeReset(database, account.id, confirmed))
    ).toBe("offer_changed");
    expect(upstream.claims).toHaveLength(0);
    expect((await view(account))?.offer?.earlyUse).toEqual({
      limit: null,
      percentUsed: null,
    });
  });
});
