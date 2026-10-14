import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";

import type { Database } from "../../src/db";
import type { ProviderAccountRecord } from "../../src/db/repositories/provider-accounts";
import type { AccountSnapshotStore } from "../../src/domain/providers/account-snapshot-store";
import {
  listProviderAccountQuotas,
  peekProviderAccountQuotas,
  recordProviderAccountLiveLimits,
  setAccountSnapshotStore,
} from "../../src/domain/providers/provider-account-tracking";
import {
  readClaudeLiveLimits,
  readCodexLiveLimits,
  readCodexLiveLimitsEvent,
} from "../../src/providers/account-tracking/live-limits";

const claudeAccount = (
  accountId: string | null = null,
  id: string = crypto.randomUUID()
): ProviderAccountRecord => {
  const now = Date.now();
  return {
    id,
    provider: "claude",
    label: null,
    accountId,
    isPrimary: true,
    enabled: true,
    accessToken: "claude-access",
    refreshToken: "claude-refresh",
    refreshLockToken: null,
    refreshLockExpiresAt: null,
    expiresAt: now + 60 * 60 * 1000,
    metadata: null,
    lastRefreshAt: null,
    lastRefreshStatus: null,
    createdAt: now,
    updatedAt: now,
  };
};

const fiveHourUtilization = (quota: unknown): unknown =>
  (
    quota as {
      data: { subscription?: { fiveHour?: { utilization?: unknown } } };
    }
  ).data.subscription?.fiveHour?.utilization;

const DAY_MS = 24 * 60 * 60 * 1000;

// Quota reads never refresh tokens for unexpired accounts, so no database
// access happens in these tests.
const database = {} as Database;

const trackingFetch = (
  usage: () => Response | Promise<Response>,
  profile: () => Response | Promise<Response> = () => Response.json({})
): typeof fetch =>
  ((input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/oauth/claude_cli/roles")) {
      return Promise.resolve(Response.json({ organization_role: "user" }));
    }
    return Promise.resolve(
      url.endsWith("/api/oauth/profile") ? profile() : usage()
    );
  }) as unknown as typeof fetch;

describe("account quota cache", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setAccountSnapshotStore(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSystemTime();
  });

  test("shares one upstream lookup between concurrent cold reads", async () => {
    let calls = 0;
    let release: ((response: Response) => void) | undefined;
    globalThis.fetch = trackingFetch(() => {
      calls++;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const account = claudeAccount();

    const first = listProviderAccountQuotas(database, [account]);
    const second = listProviderAccountQuotas(database, [account]);
    await Promise.resolve();
    expect(calls).toBe(1);

    release?.(Response.json({ five_hour: { utilization: 12 } }));
    const [firstQuotas, secondQuotas] = await Promise.all([first, second]);
    expect(fiveHourUtilization(firstQuotas.get(account.id))).toBe(12);
    expect(fiveHourUtilization(secondQuotas.get(account.id))).toBe(12);
  });

  test("returns an expired snapshot immediately and refreshes it in the background", async () => {
    let utilization = 10;
    let calls = 0;
    globalThis.fetch = trackingFetch(() => {
      calls++;
      return Promise.resolve(
        Response.json({ five_hour: { utilization: utilization++ } })
      );
    });
    const account = claudeAccount();
    const startedAt = Date.now();

    const initial = await listProviderAccountQuotas(database, [account]);
    expect(fiveHourUtilization(initial.get(account.id))).toBe(10);

    const cached = await listProviderAccountQuotas(database, [account]);
    expect(fiveHourUtilization(cached.get(account.id))).toBe(10);
    expect(calls).toBe(1);

    setSystemTime(new Date(startedAt + 181_000));
    const stale = await listProviderAccountQuotas(database, [account]);
    expect(fiveHourUtilization(stale.get(account.id))).toBe(10);
    expect(calls).toBe(2);

    await Bun.sleep(0);
    const refreshed = await listProviderAccountQuotas(database, [account]);
    expect(fiveHourUtilization(refreshed.get(account.id))).toBe(11);
    expect(calls).toBe(2);
  });

  test("does not reuse a snapshot from a different provider identity", async () => {
    let utilization = 30;
    globalThis.fetch = trackingFetch(() =>
      Promise.resolve(
        Response.json({ five_hour: { utilization: utilization++ } })
      )
    );
    const original = claudeAccount("identity-one");
    const replaced = claudeAccount("identity-two", original.id);

    const first = await listProviderAccountQuotas(database, [original]);
    expect(fiveHourUtilization(first.get(original.id))).toBe(30);

    const second = await listProviderAccountQuotas(database, [replaced]);
    expect(fiveHourUtilization(second.get(original.id))).toBe(31);
  });

  test("peeking never waits and starts one lookup the waiting read reuses", async () => {
    let calls = 0;
    let release: ((response: Response) => void) | undefined;
    globalThis.fetch = trackingFetch(() => {
      calls++;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const account = claudeAccount();

    expect(peekProviderAccountQuotas(database, [account]).get(account.id)).toBe(
      null
    );
    const waiting = listProviderAccountQuotas(database, [account]);
    await Promise.resolve();
    expect(calls).toBe(1);

    release?.(Response.json({ five_hour: { utilization: 42 } }));
    expect(fiveHourUtilization((await waiting).get(account.id))).toBe(42);
    expect(
      fiveHourUtilization(
        peekProviderAccountQuotas(database, [account]).get(account.id)
      )
    ).toBe(42);
    expect(calls).toBe(1);
  });

  test("reports the HTTP status of a failed usage sync", async () => {
    globalThis.fetch = trackingFetch(() =>
      Promise.resolve(Response.json({ error: "forbidden" }, { status: 403 }))
    );
    const account = claudeAccount();

    const quotas = await listProviderAccountQuotas(database, [account]);

    expect(quotas.get(account.id)).toMatchObject({
      fetchedAt: null,
      errorStatus: 403,
    });
  });

  const profile = (organization: Record<string, string>) => () =>
    Response.json({ organization });

  test("looks up the plan with usage and refreshes it daily, not every sync", async () => {
    let profileCalls = 0;
    let tier = "default_claude_max_5x";
    let profileHeaders = new Headers();
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/api/oauth/profile")) {
        profileCalls++;
        profileHeaders = new Headers(init?.headers);
        return Promise.resolve(
          profile({ organization_type: "claude_max", rate_limit_tier: tier })()
        );
      }
      return Promise.resolve(Response.json({ five_hour: { utilization: 12 } }));
    }) as unknown as typeof fetch;
    const account = claudeAccount();
    const startedAt = Date.now();

    const first = await listProviderAccountQuotas(database, [account]);
    expect(first.get(account.id)?.data).toMatchObject({
      plan: { type: "max_5x", label: "Max 5x" },
    });
    expect(profileHeaders.get("authorization")).toBe("Bearer claude-access");
    expect(profileHeaders.get("anthropic-beta")).not.toBeNull();
    expect(profileHeaders.get("user-agent")).toStartWith("claude-cli/");

    setSystemTime(new Date(startedAt + 181_000));
    await listProviderAccountQuotas(database, [account]);
    await Bun.sleep(0);
    expect(profileCalls).toBe(1);

    account.expiresAt = startedAt + 3 * DAY_MS;
    setSystemTime(new Date(startedAt + 3_601_000));
    await listProviderAccountQuotas(database, [account]);
    await Bun.sleep(0);
    expect(profileCalls).toBe(1);

    tier = "default_claude_max_20x";
    setSystemTime(new Date(startedAt + DAY_MS + 1000));
    await listProviderAccountQuotas(database, [account]);
    await Bun.sleep(0);
    const later = await listProviderAccountQuotas(database, [account]);
    expect(profileCalls).toBe(2);
    expect(later.get(account.id)?.data).toMatchObject({
      plan: { type: "max_20x", label: "Max 20x" },
    });
  });

  test("reports no plan for accounts without a subscription", async () => {
    globalThis.fetch = trackingFetch(
      () => Response.json({}, { status: 403 }),
      profile({ organization_type: "api" })
    );
    const account = claudeAccount();

    const quotas = await listProviderAccountQuotas(database, [account]);
    expect(quotas.get(account.id)).toMatchObject({
      errorStatus: 403,
      data: { plan: null },
    });
  });

  test("a failed plan lookup keeps usage and the last plan, logs the real error and backs off", async () => {
    let profileCalls = 0;
    let failProfile = false;
    globalThis.fetch = trackingFetch(
      () => Response.json({ five_hour: { utilization: 23 } }),
      () => {
        profileCalls++;
        return failProfile
          ? Promise.reject(new Error("profile socket disconnected"))
          : profile({ organization_type: "claude_pro" })();
      }
    );
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const account = claudeAccount();
      const startedAt = Date.now();
      await listProviderAccountQuotas(database, [account]);

      failProfile = true;
      account.expiresAt = startedAt + 3 * DAY_MS;
      setSystemTime(new Date(startedAt + DAY_MS + 1000));
      await listProviderAccountQuotas(database, [account]);
      await Bun.sleep(0);
      const quotas = await listProviderAccountQuotas(database, [account]);
      expect(quotas.get(account.id)).toMatchObject({
        error: null,
        data: {
          plan: { type: "pro", label: "Pro" },
          subscription: { fiveHour: { utilization: 23 } },
        },
      });
      expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toMatchObject({
        event: "claude_account_plan_fetch_failed",
        errorMessage: "profile socket disconnected",
      });
      expect(profileCalls).toBe(2);

      setSystemTime(new Date(startedAt + DAY_MS + 182_000));
      await listProviderAccountQuotas(database, [account]);
      await Bun.sleep(0);
      expect(profileCalls).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("a rejected plan lookup does not refresh credentials or fail usage", async () => {
    globalThis.fetch = trackingFetch(
      () => Response.json({ five_hour: { utilization: 5 } }),
      () => Response.json({}, { status: 401 })
    );
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const account = claudeAccount();
      const quotas = await listProviderAccountQuotas(database, [account]);
      expect(quotas.get(account.id)).toMatchObject({
        error: null,
        data: { plan: null, subscription: { fiveHour: { utilization: 5 } } },
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("a rate limit keeps the last numbers and pauses every Claude account until checks succeed", async () => {
    let rateLimited = false;
    let usageCalls = 0;
    globalThis.fetch = trackingFetch(() => {
      usageCalls++;
      return rateLimited
        ? Response.json(
            { error: { type: "rate_limit_error" } },
            { status: 429, headers: { "Retry-After": "0" } }
          )
        : Response.json({ five_hour: { utilization: 30 } });
    });
    const first = claudeAccount();
    const second = claudeAccount();
    const startedAt = Date.now();
    await listProviderAccountQuotas(database, [first, second]);
    expect(usageCalls).toBe(2);

    rateLimited = true;
    first.expiresAt = startedAt + 7_200_000;
    second.expiresAt = startedAt + 7_200_000;
    setSystemTime(new Date(startedAt + 181_000));
    await listProviderAccountQuotas(database, [first]);
    await Bun.sleep(0);
    const limited = await listProviderAccountQuotas(database, [first]);
    expect(limited.get(first.id)).toMatchObject({
      errorStatus: 429,
      fetchedAt: startedAt,
      data: { subscription: { fiveHour: { utilization: 30 } } },
    });
    expect(usageCalls).toBe(3);

    await listProviderAccountQuotas(database, [second]);
    await Bun.sleep(0);
    const paused = await listProviderAccountQuotas(database, [second]);
    expect(paused.get(second.id)).toMatchObject({
      errorStatus: 429,
      data: { subscription: { fiveHour: { utilization: 30 } } },
    });
    expect(usageCalls).toBe(3);

    rateLimited = false;
    setSystemTime(new Date(startedAt + 181_000 + 121_000));
    await listProviderAccountQuotas(database, [first]);
    await Bun.sleep(0);
    const recovered = await listProviderAccountQuotas(database, [first]);
    expect(recovered.get(first.id)).toMatchObject({ error: null });
    expect(usageCalls).toBe(4);
  });
});

const claudeHeaders = (fiveHour: number, sevenDay?: number) =>
  readClaudeLiveLimits(
    new Headers({
      "anthropic-ratelimit-unified-5h-utilization": String(fiveHour),
      "anthropic-ratelimit-unified-5h-reset": "1791000000",
      ...(sevenDay === undefined
        ? {}
        : { "anthropic-ratelimit-unified-7d-utilization": String(sevenDay) }),
    })
  );

type RecordedQuota = Parameters<AccountSnapshotStore["recordQuota"]>;

const snapshotSpy = () => {
  const recorded: RecordedQuota[] = [];
  const store = {
    recordQuota: (...args: RecordedQuota) => {
      recorded.push(args);
    },
    recordProfile: () => undefined,
    seed: () => undefined,
  } as unknown as AccountSnapshotStore;
  return { store, recorded };
};

describe("limits from proxied traffic", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setAccountSnapshotStore(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSystemTime();
    setAccountSnapshotStore(null);
  });

  test("merges Claude headers into polled limits and counts as a fresh sync", async () => {
    let usageCalls = 0;
    globalThis.fetch = trackingFetch(
      () => {
        usageCalls++;
        return Response.json({
          five_hour: { utilization: 10, resets_at: "2026-10-14T18:00:00Z" },
          seven_day: { utilization: 20, resets_at: "2026-10-18T00:00:00Z" },
          seven_day_opus: { utilization: 5, resets_at: null },
          extra_usage: { is_enabled: true, monthly_limit: 5000 },
        });
      },
      () =>
        Response.json({
          organization: {
            organization_type: "claude_max",
            rate_limit_tier: "default_claude_max_20x",
          },
        })
    );
    const account = claudeAccount();
    const startedAt = Date.now();
    await listProviderAccountQuotas(database, [account]);
    expect(usageCalls).toBe(1);

    setSystemTime(new Date(startedAt + 120_000));
    recordProviderAccountLiveLimits(account, claudeHeaders(0.42, 0.25));

    const quotas = await listProviderAccountQuotas(database, [account]);
    expect(quotas.get(account.id)).toMatchObject({
      fetchedAt: startedAt + 120_000,
      error: null,
      source: "traffic",
      data: {
        plan: { type: "max_20x" },
        subscription: {
          fiveHour: {
            utilization: 42,
            resetsAt: new Date(1_791_000_000_000).toISOString(),
          },
          sevenDay: { utilization: 25, resetsAt: "2026-10-18T00:00:00Z" },
          modelWindows: { seven_day_opus: { utilization: 5 } },
          extraUsage: { isEnabled: true, monthlyLimit: 5000 },
        },
      },
    });

    // The usual three minutes now run from the header reading.
    setSystemTime(new Date(startedAt + 200_000));
    await listProviderAccountQuotas(database, [account]);
    await Bun.sleep(0);
    expect(usageCalls).toBe(1);

    setSystemTime(new Date(startedAt + 301_000));
    await listProviderAccountQuotas(database, [account]);
    await Bun.sleep(0);
    const polled = await listProviderAccountQuotas(database, [account]);
    expect(usageCalls).toBe(2);
    expect(polled.get(account.id)).toMatchObject({
      source: "poll",
      data: { subscription: { fiveHour: { utilization: 10 } } },
    });
  });

  test("header readings refresh a paused Claude account without lifting the pause", async () => {
    let usageCalls = 0;
    let rateLimited = true;
    globalThis.fetch = trackingFetch(() => {
      usageCalls++;
      return rateLimited
        ? Response.json(
            { error: { type: "rate_limit_error" } },
            { status: 429, headers: { "Retry-After": "0" } }
          )
        : Response.json({ five_hour: { utilization: 1 } });
    });
    const limited = claudeAccount();
    const other = claudeAccount();
    const startedAt = Date.now();
    setSystemTime(new Date(startedAt));
    const first = await listProviderAccountQuotas(database, [limited]);
    expect(first.get(limited.id)).toMatchObject({ errorStatus: 429 });
    expect(usageCalls).toBe(1);

    recordProviderAccountLiveLimits(limited, claudeHeaders(0.3));
    const fresh = await listProviderAccountQuotas(database, [limited]);
    expect(fresh.get(limited.id)).toMatchObject({
      error: null,
      errorStatus: null,
      fetchedAt: startedAt,
      source: "traffic",
      data: { subscription: { fiveHour: { utilization: 30 } } },
    });

    const paused = await listProviderAccountQuotas(database, [other]);
    expect(paused.get(other.id)).toMatchObject({ errorStatus: 429 });
    expect(usageCalls).toBe(1);

    // Leave the shared pause cleared for other tests.
    rateLimited = false;
    setSystemTime(new Date(startedAt + 121_000));
    await listProviderAccountQuotas(database, [other]);
    await Bun.sleep(0);
    const recovered = await listProviderAccountQuotas(database, [other]);
    expect(recovered.get(other.id)).toMatchObject({ error: null });
  });

  test("Codex headers and events keep reset credits and the usage profile", async () => {
    const calls: Record<string, number> = {};
    globalThis.fetch = ((input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      calls[path] = (calls[path] ?? 0) + 1;
      const bodies: Record<string, unknown> = {
        "/backend-api/wham/usage": {
          plan_type: "plus",
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18_000,
              reset_at: 1_791_000_000,
            },
            secondary_window: {
              used_percent: 30,
              limit_window_seconds: 604_800,
              reset_at: 1_791_500_000,
            },
          },
          spend_control: { reached: false },
          rate_limit_reset_credits: { available_count: 1 },
        },
        "/backend-api/wham/rate-limit-reset-credits": {
          available_count: 1,
          credits: [{ id: "credit-1", status: "available" }],
        },
        "/backend-api/wham/profiles/me": {
          profile: { display_name: "Dev" },
          stats: { lifetime_tokens: 1000 },
        },
        "/backend-api/wham/accounts/check": { accounts: [] },
      };
      return Promise.resolve(Response.json(bodies[path] ?? {}));
    }) as unknown as typeof fetch;
    const account: ProviderAccountRecord = {
      ...claudeAccount("workspace-1"),
      provider: "codex",
    };
    await listProviderAccountQuotas(database, [account]);
    const usageCalls = calls["/backend-api/wham/usage"];

    recordProviderAccountLiveLimits(
      account,
      readCodexLiveLimits(
        new Headers({
          "x-codex-primary-used-percent": "45",
        })
      )
    );
    const fromHeaders = await listProviderAccountQuotas(database, [account]);
    expect(fromHeaders.get(account.id)).toMatchObject({
      source: "traffic",
      data: {
        status: {
          planType: "plus",
          primaryWindow: {
            usedPercent: 45,
            windowSeconds: 18_000,
            resetAt: 1_791_000_000,
          },
          secondaryWindow: { usedPercent: 30 },
          spendControl: { reached: false },
          resetCreditsAvailable: 1,
        },
        resetCredits: { availableCount: 1 },
        profile: { displayName: "Dev", lifetimeTokens: 1000 },
      },
    });
    const event = readCodexLiveLimitsEvent({
      type: "codex.rate_limits",
      plan_type: "pro",
      rate_limits: {
        primary: {
          used_percent: 4,
          window_minutes: 300,
          reset_at: 1_791_018_000,
        },
      },
    });
    recordProviderAccountLiveLimits(account, event);
    const fromEvent = await listProviderAccountQuotas(database, [account]);
    expect(fromEvent.get(account.id)).toMatchObject({
      data: {
        status: {
          planType: "pro",
          primaryWindow: { usedPercent: 4, resetAt: 1_791_018_000 },
          secondaryWindow: { usedPercent: 30 },
        },
      },
    });
    expect(calls["/backend-api/wham/usage"]).toBe(usageCalls);

    // A reading never lands on another provider's or identity's limits.
    const moved = { ...account, accountId: "workspace-2" };
    recordProviderAccountLiveLimits(moved, claudeHeaders(0.9));
    recordProviderAccountLiveLimits(
      moved,
      readCodexLiveLimits(new Headers({ "x-codex-primary-used-percent": "70" }))
    );
    const original = await listProviderAccountQuotas(database, [account]);
    expect(original.get(account.id)).toMatchObject({
      data: { status: { primaryWindow: { usedPercent: 4 } } },
    });
  });

  test("a failed poll keeps limits read while it was running", async () => {
    let release: ((response: Response) => void) | undefined;
    globalThis.fetch = trackingFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const account = claudeAccount();
    const pending = listProviderAccountQuotas(database, [account]);
    await Bun.sleep(0);
    recordProviderAccountLiveLimits(account, claudeHeaders(0.6));
    release?.(Response.json({}, { status: 500 }));
    const quotas = await pending;
    expect(quotas.get(account.id)).toMatchObject({
      errorStatus: 500,
      source: "traffic",
      data: { subscription: { fiveHour: { utilization: 60 } } },
    });
  });

  test("a first reading without a sync still polls for the rest", async () => {
    let usageCalls = 0;
    globalThis.fetch = trackingFetch(() => {
      usageCalls++;
      return Response.json({
        five_hour: { utilization: 11 },
        seven_day_opus: { utilization: 3 },
      });
    });
    const account = claudeAccount();
    recordProviderAccountLiveLimits(account, claudeHeaders(0.5));

    const peeked = peekProviderAccountQuotas(database, [account]);
    expect(peeked.get(account.id)).toMatchObject({
      source: "traffic",
      data: {
        subscription: { fiveHour: { utilization: 50 }, modelWindows: {} },
      },
    });
    await Bun.sleep(0);
    expect(usageCalls).toBe(1);
    const polled = await listProviderAccountQuotas(database, [account]);
    expect(polled.get(account.id)).toMatchObject({
      source: "poll",
      data: { subscription: { modelWindows: { seven_day_opus: {} } } },
    });
  });

  test("header readings are stored like polled limits and logged once", () => {
    const { store, recorded } = snapshotSpy();
    setAccountSnapshotStore(store);
    const info = spyOn(console, "info").mockImplementation(() => undefined);
    const account = claudeAccount();
    recordProviderAccountLiveLimits(account, claudeHeaders(0.2));
    recordProviderAccountLiveLimits(account, claudeHeaders(0.3));
    const lines = info.mock.calls.map((call) => String(call[0]));
    info.mockRestore();

    expect(recorded).toHaveLength(2);
    const [stored, quota, signature] = recorded[1] ?? [];
    expect(stored).toMatchObject({ id: account.id });
    expect(quota).toMatchObject({
      source: "traffic",
      error: null,
      data: {
        provider: "claude",
        subscription: { fiveHour: { utilization: 30 } },
      },
    });
    expect(signature).toEqual({ plan: null, resets: [1_791_000_000_000] });
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(JSON.parse(line)).toMatchObject({
      level: "info",
      event: "provider_account_limits_from_traffic",
      providerAccountId: account.id,
      provider: "claude",
      fields: "five_hour",
    });
    expect(line).not.toContain("claude-access");
  });
});
