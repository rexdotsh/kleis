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

import type { Database } from "../../src/db";
import { upsertProviderAccountSnapshots } from "../../src/db/repositories/provider-account-snapshots";
import { listProviderAccounts } from "../../src/db/repositories/provider-accounts";
import {
  providerAccounts,
  providerAccountSnapshots,
} from "../../src/db/schema";
import * as schema from "../../src/db/schema";
import { createAccountSnapshotStore } from "../../src/domain/providers/account-snapshot-store";
import {
  claudeResetIdentity,
  expireProviderAccountTracking,
  listProviderAccountQuotas,
  peekProviderAccountProfiles,
  peekProviderAccountQuotas,
  recordProviderAccountLiveLimits,
  restoreProviderAccountSnapshots,
  setAccountSnapshotStore,
} from "../../src/domain/providers/provider-account-tracking";
import {
  readClaudeLiveLimits,
  readCodexLiveLimits,
} from "../../src/providers/account-tracking/live-limits";

const HOUR_MS = 60 * 60 * 1000;

const claudeProfileResponse = (rateLimitTier: string) => ({
  account: { display_name: "Dev", full_name: "Dev Example" },
  organization: {
    uuid: "org-uuid",
    name: "Example Org",
    organization_type: "claude_max",
    rate_limit_tier: rateLimitTier,
    billing_type: "stripe_subscription",
    subscription_status: "active",
    has_extra_usage_enabled: false,
  },
});

type Calls = Record<string, number>;

// Routes every provider URL to a fixture and counts calls per path.
const providerFetch = (
  calls: Calls,
  handlers: Record<string, () => Response>
): typeof fetch =>
  ((input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    calls[path] = (calls[path] ?? 0) + 1;
    const handler = handlers[path];
    return Promise.resolve(
      handler ? handler() : Response.json({}, { status: 404 })
    );
  }) as unknown as typeof fetch;

describe("account snapshots", () => {
  const originalFetch = globalThis.fetch;
  let client: ReturnType<typeof createClient>;
  let database: Database;

  const insertAccount = async (
    provider: "claude" | "codex",
    input: {
      accountId?: string | null;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<string> => {
    const id = crypto.randomUUID();
    const now = Date.now();
    await database.insert(providerAccounts).values({
      id,
      provider,
      accountId: input.accountId ?? null,
      accessToken: `${provider}-access`,
      refreshToken: `${provider}-refresh`,
      expiresAt: now + 3 * 24 * HOUR_MS,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  };

  const readSnapshot = async (id: string) =>
    (
      await database
        .select()
        .from(providerAccountSnapshots)
        .where(eq(providerAccountSnapshots.providerAccountId, id))
    )[0];

  const accountsById = async (id: string) =>
    (await listProviderAccounts(database)).filter((row) => row.id === id);

  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSystemTime();
    setAccountSnapshotStore(null);
    client.close();
  });

  test("writes a quota at most every five minutes unless the plan changes or a window resets", async () => {
    const store = createAccountSnapshotStore(database);
    const id = await insertAccount("codex", { accountId: "acct-1" });
    const account = { id, accountId: "acct-1" };
    const startedAt = Date.now();
    const resetAt = startedAt + 2 * HOUR_MS;
    const quota = (used: number) => ({
      fetchedAt: Date.now(),
      error: null,
      errorStatus: null,
      data: { provider: "codex", status: { usedPercent: used } },
    });

    store.recordQuota(account, quota(10), { plan: "plus", resets: [resetAt] });
    await store.settled();
    expect(JSON.parse((await readSnapshot(id))?.quotaJson ?? "")).toMatchObject(
      { status: { usedPercent: 10 } }
    );

    setSystemTime(new Date(startedAt + 60_000));
    store.recordQuota(account, quota(20), { plan: "plus", resets: [resetAt] });
    await store.settled();
    expect(JSON.parse((await readSnapshot(id))?.quotaJson ?? "")).toMatchObject(
      { status: { usedPercent: 10 } }
    );

    store.recordQuota(account, quota(30), { plan: "pro", resets: [resetAt] });
    await store.settled();
    expect(JSON.parse((await readSnapshot(id))?.quotaJson ?? "")).toMatchObject(
      { status: { usedPercent: 30 } }
    );

    setSystemTime(new Date(resetAt + 1000));
    store.recordQuota(account, quota(0), {
      plan: "pro",
      resets: [resetAt + 5 * HOUR_MS],
    });
    await store.settled();
    expect(JSON.parse((await readSnapshot(id))?.quotaJson ?? "")).toMatchObject(
      { status: { usedPercent: 0 } }
    );

    setSystemTime(new Date(resetAt + 61_000));
    store.recordQuota(account, quota(5), {
      plan: "pro",
      resets: [resetAt + 5 * HOUR_MS],
    });
    await store.flush();
    expect(JSON.parse((await readSnapshot(id))?.quotaJson ?? "")).toMatchObject(
      { status: { usedPercent: 5 } }
    );
  });

  type PollRaceScenario = {
    name: string;
    poll: number;
    traffic: number | null;
    pollReset: number | null;
    trafficReset: number | null;
    pollRelativeReset?: number;
    windowSeconds?: number;
    completeAfterMs?: number;
    expectedReset?: number;
    expected: number;
    source: "poll" | "traffic";
  };

  test.each(
    (["codex", "claude"] as const).flatMap((provider) =>
      (
        [
          {
            name: "higher traffic in the same window",
            poll: 10,
            traffic: 70,
            pollReset: 18_000,
            trafficReset: 18_000,
            expected: 70,
            source: "traffic",
          },
          {
            name: "delayed traffic below an exhausted poll",
            poll: 100,
            traffic: 20,
            pollReset: 18_000,
            trafficReset: 18_000,
            expected: 100,
            source: "poll",
          },
          {
            name: "expired traffic before a rolled-over poll",
            poll: 5,
            traffic: 100,
            pollReset: 18_000,
            trafficReset: -3600,
            expected: 5,
            source: "poll",
          },
          {
            name: "rolled-over traffic after an exhausted poll",
            poll: 100,
            traffic: 5,
            pollReset: -3600,
            trafficReset: 18_000,
            expected: 5,
            source: "traffic",
          },
          {
            name: "unplaceable traffic",
            poll: 10,
            traffic: 70,
            pollReset: 18_000,
            trafficReset: null,
            expected: 10,
            source: "poll",
          },
          {
            name: "later reset jitter below an exhausted poll",
            poll: 100,
            traffic: 20,
            pollReset: 18_000,
            trafficReset: 18_003,
            expected: 100,
            source: "poll",
          },
          {
            name: "exhausted traffic with earlier reset jitter",
            poll: 20,
            traffic: 100,
            pollReset: 18_000,
            trafficReset: 17_997,
            expectedReset: 18_000,
            expected: 100,
            source: "traffic",
          },
          {
            name: "expired traffic against a poll without a reset",
            poll: 5,
            traffic: 100,
            pollReset: null,
            trafficReset: -1,
            expected: 5,
            source: "poll",
          },
          {
            name: "traffic expiring before the poll completes",
            poll: 5,
            traffic: 100,
            pollReset: null,
            trafficReset: 2,
            completeAfterMs: 3000,
            expected: 5,
            source: "poll",
          },
          ...(provider === "claude"
            ? [
                {
                  name: "reset-only jitter below an exhausted poll",
                  poll: 100,
                  traffic: null,
                  pollReset: 18_000,
                  trafficReset: 18_003,
                  expected: 100,
                  source: "poll" as const,
                },
              ]
            : [
                {
                  name: "expired traffic against a relative-reset poll",
                  poll: 5,
                  traffic: 100,
                  pollReset: null,
                  pollRelativeReset: 18_000,
                  trafficReset: -1,
                  expectedReset: 18_000,
                  expected: 5,
                  source: "poll" as const,
                },
                {
                  name: "reset jitter below an exhausted relative-reset poll",
                  poll: 100,
                  traffic: 20,
                  pollReset: null,
                  pollRelativeReset: 18_000,
                  trafficReset: 18_003,
                  expectedReset: 18_000,
                  expected: 100,
                  source: "poll" as const,
                },
                {
                  name: "a distinct reset for a short known window",
                  poll: 100,
                  traffic: 5,
                  pollReset: 30,
                  trafficReset: 33,
                  windowSeconds: 60,
                  expected: 5,
                  source: "traffic" as const,
                },
              ]),
        ] satisfies PollRaceScenario[]
      ).map((scenario: PollRaceScenario) => ({ provider, ...scenario }))
    )
  )(
    "$provider publishes and persists $name",
    async ({
      provider,
      poll,
      traffic,
      pollReset,
      trafficReset,
      pollRelativeReset,
      windowSeconds,
      completeAfterMs = 1000,
      expectedReset: expectedResetOffset,
      expected: percent,
      source,
    }) => {
      const id = await insertAccount(provider);
      const accounts = await accountsById(id);
      const account = accounts[0];
      if (!account) throw new Error("account missing");
      const store = createAccountSnapshotStore(database);
      setAccountSnapshotStore(store);
      const startedAt = Date.now();
      setSystemTime(startedAt);
      const resetAt = (seconds: number) =>
        Math.floor(startedAt / 1000) + seconds;
      const trafficResetHeaders: Record<string, string> =
        trafficReset === null
          ? {}
          : provider === "codex"
            ? { "x-codex-primary-reset-at": String(resetAt(trafficReset)) }
            : {
                "anthropic-ratelimit-unified-5h-reset": String(
                  resetAt(trafficReset)
                ),
              };
      let finish: (response: Response) => void = () => undefined;
      globalThis.fetch = ((input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/usage")) {
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        return Promise.resolve(Response.json({}));
      }) as typeof fetch;
      const polling = listProviderAccountQuotas(database, accounts);
      await Bun.sleep(0);
      setSystemTime(startedAt + 1000);
      recordProviderAccountLiveLimits(
        account,
        provider === "codex"
          ? readCodexLiveLimits(
              new Headers({
                ...(traffic === null
                  ? {}
                  : { "x-codex-primary-used-percent": String(traffic) }),
                ...trafficResetHeaders,
              })
            )
          : readClaudeLiveLimits(
              new Headers({
                ...(traffic === null
                  ? {}
                  : {
                      "anthropic-ratelimit-unified-5h-utilization": String(
                        traffic / 100
                      ),
                    }),
                ...trafficResetHeaders,
              })
            )
      );
      setSystemTime(startedAt + completeAfterMs);
      finish(
        Response.json(
          provider === "codex"
            ? {
                rate_limit: {
                  primary_window: {
                    used_percent: poll,
                    reset_at: pollReset === null ? null : resetAt(pollReset),
                    reset_after_seconds: pollRelativeReset,
                    limit_window_seconds: windowSeconds,
                  },
                  secondary_window: { used_percent: 20 },
                },
              }
            : {
                five_hour: {
                  utilization: poll,
                  resets_at:
                    pollReset === null
                      ? null
                      : new Date(resetAt(pollReset) * 1000).toISOString(),
                },
                seven_day: { utilization: 20 },
              }
        )
      );
      const winningReset =
        expectedResetOffset ??
        (source === "traffic" && trafficReset !== null
          ? trafficReset
          : pollReset);
      const expectedReset =
        winningReset === null
          ? null
          : expectedResetOffset !== undefined && pollRelativeReset !== undefined
            ? (startedAt + expectedResetOffset * 1000) / 1000
            : resetAt(winningReset);
      const expected =
        provider === "codex"
          ? {
              status: {
                primaryWindow: { usedPercent: percent, resetAt: expectedReset },
                secondaryWindow: { usedPercent: 20 },
              },
            }
          : {
              subscription: {
                fiveHour: {
                  utilization: percent,
                  resetsAt:
                    expectedReset === null
                      ? null
                      : new Date(expectedReset * 1000).toISOString(),
                },
                sevenDay: { utilization: 20 },
              },
            };
      expect((await polling).get(id)).toMatchObject({
        source,
        fetchedAt: startedAt + (source === "traffic" ? 1000 : 0),
        data: expected,
      });
      expect(
        (await listProviderAccountQuotas(database, accounts)).get(id)?.data
      ).toMatchObject(expected);
      await store.flush();
      expect(
        JSON.parse((await readSnapshot(id))?.quotaJson ?? "")
      ).toMatchObject(expected);
    }
  );

  test("profile and quota writes keep each other, and a removed account does not block the rest", async () => {
    const store = createAccountSnapshotStore(database);
    const kept = await insertAccount("claude");
    const removed = await insertAccount("claude");
    const signature = { plan: "max", resets: [] };
    const quota = {
      fetchedAt: 1000,
      error: "Claude subscription usage request failed (429)",
      errorStatus: 429,
      data: { provider: "claude" },
    };
    store.recordQuota({ id: kept, accountId: null }, quota, signature);
    await store.settled();
    store.recordProfile(
      { id: kept, accountId: null },
      { provider: "claude", displayName: "Dev" },
      2000
    );
    await store.settled();
    expect(await readSnapshot(kept)).toMatchObject({
      quotaFetchedAt: 1000,
      lastError: "Claude subscription usage request failed (429)",
      lastErrorStatus: 429,
      profileFetchedAt: 2000,
    });

    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await database
        .delete(providerAccounts)
        .where(eq(providerAccounts.id, removed));
      store.recordProfile({ id: removed, accountId: null }, {}, 3000);
      store.recordProfile(
        { id: kept, accountId: null },
        { provider: "claude", displayName: "Renamed" },
        3000
      );
      await store.flush();
      await store.settled();
    } finally {
      warn.mockRestore();
    }
    expect(await readSnapshot(kept)).toMatchObject({
      profileFetchedAt: 3000,
      quotaFetchedAt: 1000,
    });
    expect(await readSnapshot(removed)).toBeUndefined();

    await database
      .delete(providerAccounts)
      .where(eq(providerAccounts.id, kept));
    expect(await readSnapshot(kept)).toBeUndefined();
  });

  test("boot shows stored plans and limits at once and only refreshes stale limits", async () => {
    const now = Date.now();
    const fresh = await insertAccount("claude");
    const stale = await insertAccount("claude");
    const profile = {
      provider: "claude",
      plan: { type: "max_20x", label: "Max 20x" },
      displayName: "Dev",
      organizationUuid: "org-uuid",
      organizationName: "Example Org",
    };
    const quota = (utilization: number) =>
      JSON.stringify({
        provider: "claude",
        plan: { type: "max", label: "Max" },
        subscription: { fiveHour: { utilization } },
      });
    await upsertProviderAccountSnapshots(database, [
      {
        providerAccountId: fresh,
        accountIdentity: "",
        profile: {
          json: JSON.stringify(profile),
          fetchedAt: now - 2 * HOUR_MS,
        },
        quota: {
          json: quota(11),
          fetchedAt: now - 30_000,
          error: null,
          errorStatus: null,
        },
        updatedAt: now - 30_000,
      },
      {
        providerAccountId: stale,
        accountIdentity: "",
        profile: {
          json: JSON.stringify(profile),
          fetchedAt: now - 2 * HOUR_MS,
        },
        quota: {
          json: quota(22),
          fetchedAt: now - HOUR_MS,
          error: "Claude subscription usage request failed (429)",
          errorStatus: 429,
        },
        updatedAt: now - HOUR_MS,
      },
    ]);
    const calls: Calls = {};
    globalThis.fetch = providerFetch(calls, {
      "/api/oauth/usage": () =>
        Response.json({ five_hour: { utilization: 33 } }),
    });

    const store = createAccountSnapshotStore(database);
    const accounts = await restoreProviderAccountSnapshots(database, store);
    const restored = (accounts ?? []).filter(
      (account) => account.id === fresh || account.id === stale
    );

    const quotas = peekProviderAccountQuotas(database, restored);
    expect(quotas.get(fresh)).toMatchObject({
      fetchedAt: now - 30_000,
      data: {
        plan: { label: "Max 20x" },
        subscription: { fiveHour: { utilization: 11 } },
      },
    });
    expect(quotas.get(stale)).toMatchObject({
      fetchedAt: now - HOUR_MS,
      errorStatus: 429,
      data: { plan: { label: "Max 20x" } },
    });
    expect(peekProviderAccountProfiles(restored).get(fresh)).toMatchObject({
      fetchedAt: now - 2 * HOUR_MS,
      data: { displayName: "Dev" },
    });

    await listProviderAccountQuotas(database, restored);
    await Bun.sleep(0);
    const refreshed = await listProviderAccountQuotas(database, restored);
    expect(calls["/api/oauth/usage"]).toBe(1);
    expect(calls["/api/oauth/profile"]).toBeUndefined();
    expect(refreshed.get(stale)).toMatchObject({
      error: null,
      data: {
        plan: { label: "Max 20x" },
        subscription: { fiveHour: { utilization: 33 } },
      },
    });
  });

  test("Claude profiles refresh daily, when the organization changes, and on request", async () => {
    const now = Date.now();
    const id = await insertAccount("claude", {
      metadata: {
        provider: "claude",
        oauthMode: "max",
        oauthHost: "claude.ai",
        organizationUuid: "org-uuid",
        organizationName: "Example Org",
      },
    });
    await upsertProviderAccountSnapshots(database, [
      {
        providerAccountId: id,
        accountIdentity: "",
        profile: {
          json: JSON.stringify({
            provider: "claude",
            plan: { type: "max_5x", label: "Max 5x" },
            organizationUuid: "org-uuid",
            organizationName: "Example Org",
            organizationRole: "admin",
          }),
          fetchedAt: now - 22 * HOUR_MS,
        },
        updatedAt: now - 22 * HOUR_MS,
      },
    ]);
    const calls: Calls = {};
    let rolesFail = false;
    globalThis.fetch = providerFetch(calls, {
      "/api/oauth/usage": () =>
        Response.json({ five_hour: { utilization: 1 } }),
      "/api/oauth/profile": () =>
        Response.json(claudeProfileResponse("default_claude_max_20x")),
      "/api/oauth/claude_cli/roles": () =>
        rolesFail
          ? Response.json({}, { status: 500 })
          : Response.json({ organization_role: "owner" }),
    });
    const store = createAccountSnapshotStore(database);
    await restoreProviderAccountSnapshots(database, store);
    const account = () => accountsById(id);

    const first = await listProviderAccountQuotas(database, await account());
    expect(calls["/api/oauth/profile"]).toBeUndefined();
    expect(first.get(id)?.data).toMatchObject({ plan: { label: "Max 5x" } });

    setSystemTime(new Date(now + 3 * HOUR_MS));
    rolesFail = true;
    await listProviderAccountQuotas(database, await account());
    await Bun.sleep(0);
    const daily = await listProviderAccountQuotas(database, await account());
    expect(calls["/api/oauth/profile"]).toBe(1);
    expect(daily.get(id)?.data).toMatchObject({ plan: { label: "Max 20x" } });
    await store.settled();
    expect(
      JSON.parse((await readSnapshot(id))?.profileJson ?? "")
    ).toMatchObject({
      plan: { label: "Max 20x" },
      billingType: "stripe_subscription",
      organizationRole: "admin",
    });
    expect((await readSnapshot(id))?.profileFetchedAt).toBe(now + 3 * HOUR_MS);

    rolesFail = false;
    await database
      .update(providerAccounts)
      .set({
        metadataJson: JSON.stringify({
          provider: "claude",
          oauthMode: "max",
          oauthHost: "claude.ai",
          organizationUuid: "other-org",
          organizationName: "Other Org",
        }),
      })
      .where(eq(providerAccounts.id, id));
    setSystemTime(new Date(now + 4 * HOUR_MS));
    await listProviderAccountQuotas(database, await account());
    await Bun.sleep(0);
    await listProviderAccountQuotas(database, await account());
    expect(calls["/api/oauth/profile"]).toBe(2);
    expect(peekProviderAccountProfiles(await account()).get(id)).toMatchObject({
      data: { organizationRole: "owner" },
    });

    setSystemTime(new Date(now + 5 * HOUR_MS));
    expireProviderAccountTracking(id);
    await listProviderAccountQuotas(database, await account());
    await Bun.sleep(0);
    expect(calls["/api/oauth/profile"]).toBe(3);
  });

  test("a restored display profile cannot prove an identity-less credential's Claude identity", async () => {
    const id = await insertAccount("claude");
    const now = Date.now();
    await upsertProviderAccountSnapshots(database, [
      {
        providerAccountId: id,
        accountIdentity: "",
        updatedAt: now,
        profile: {
          fetchedAt: now,
          json: JSON.stringify({
            provider: "claude",
            displayName: "Preview user",
            accountUuid: "old-preview-user",
            organizationUuid: "old-preview-org",
          }),
        },
      },
    ]);
    const store = createAccountSnapshotStore(database);
    await restoreProviderAccountSnapshots(database, store);
    const [account] = await accountsById(id);
    if (!account) throw new Error("account missing");
    expect(peekProviderAccountProfiles([account]).get(id)?.data).toMatchObject({
      displayName: "Preview user",
    });
    expect(claudeResetIdentity(account)).toBeNull();
    await store.settled();
  });

  test("a Codex plan change is stored at once and looks the workspace up again", async () => {
    const id = await insertAccount("codex", { accountId: "acct-2" });
    let plan = "plus";
    const calls: Calls = {};
    globalThis.fetch = providerFetch(calls, {
      "/backend-api/wham/usage": () =>
        Response.json({
          plan_type: plan,
          rate_limit: {
            primary_window: {
              used_percent: 4,
              limit_window_seconds: 18_000,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      "/backend-api/wham/rate-limit-reset-credits": () =>
        Response.json({ available_count: 0, credits: [] }),
      "/backend-api/wham/profiles/me": () =>
        Response.json({
          profile: { display_name: "Dev Example", username: "dev" },
          stats: { lifetime_tokens: 10 },
        }),
      "/backend-api/wham/accounts/check": () =>
        Response.json({
          accounts: [
            {
              id: "acct-other",
              structure: "personal",
              plan_type: "free",
              name: null,
            },
            {
              id: "acct-2",
              account_user_role: "account-owner",
              structure: "workspace",
              plan_type: plan,
              name: "Example Workspace",
            },
          ],
          default_account_id: "acct-other",
          account_ordering: ["acct-other", "acct-2"],
        }),
    });
    const store = createAccountSnapshotStore(database);
    setAccountSnapshotStore(store);
    const accounts = await accountsById(id);
    const startedAt = Date.now();

    await listProviderAccountQuotas(database, accounts);
    await store.settled();
    expect(calls["/backend-api/wham/accounts/check"]).toBe(1);
    expect(peekProviderAccountProfiles(accounts).get(id)).toMatchObject({
      data: {
        planType: "plus",
        workspaceName: "Example Workspace",
        structure: "workspace",
        role: "account-owner",
        displayName: "Dev Example",
        username: "dev",
      },
    });

    setSystemTime(new Date(startedAt + 61_000));
    await listProviderAccountQuotas(database, accounts);
    await Bun.sleep(0);
    await listProviderAccountQuotas(database, accounts);
    await store.settled();
    expect(calls["/backend-api/wham/accounts/check"]).toBe(1);

    plan = "pro";
    setSystemTime(new Date(startedAt + 122_000));
    await listProviderAccountQuotas(database, accounts);
    await Bun.sleep(0);
    await listProviderAccountQuotas(database, accounts);
    await store.settled();
    expect(calls["/backend-api/wham/accounts/check"]).toBe(2);
    const snapshot = await readSnapshot(id);
    expect(JSON.parse(snapshot?.quotaJson ?? "")).toMatchObject({
      status: { planType: "pro" },
    });
    expect(JSON.parse(snapshot?.profileJson ?? "")).toMatchObject({
      planType: "pro",
      workspacePlanType: "pro",
    });
  });
});
