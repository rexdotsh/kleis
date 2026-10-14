import {
  afterEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";

import type { Database } from "../../src/db";
import type { ProviderAccountRecord } from "../../src/db/repositories/provider-accounts";
import {
  listProviderAccountQuotas,
  peekProviderAccountQuotas,
} from "../../src/domain/providers/provider-account-tracking";

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

// Quota reads never refresh tokens for unexpired accounts, so no database
// access happens in these tests.
const database = {} as Database;

const trackingFetch = (
  usage: () => Response | Promise<Response>,
  profile: () => Response | Promise<Response> = () => Response.json({})
): typeof fetch =>
  ((input: string | URL | Request) =>
    Promise.resolve(
      String(input).endsWith("/api/oauth/profile") ? profile() : usage()
    )) as unknown as typeof fetch;

describe("account quota cache", () => {
  const originalFetch = globalThis.fetch;

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

    setSystemTime(new Date(startedAt + 61_000));
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

  test("looks up the plan with usage and refreshes it hourly, not every sync", async () => {
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

    setSystemTime(new Date(startedAt + 61_000));
    await listProviderAccountQuotas(database, [account]);
    await Bun.sleep(0);
    expect(profileCalls).toBe(1);

    tier = "default_claude_max_20x";
    account.expiresAt = startedAt + 7_200_000;
    setSystemTime(new Date(startedAt + 3_601_000));
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
      account.expiresAt = startedAt + 7_200_000;
      setSystemTime(new Date(startedAt + 3_601_000));
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

      setSystemTime(new Date(startedAt + 3_662_000));
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
});
