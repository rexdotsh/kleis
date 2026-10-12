import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import type { Database } from "../../src/db";
import type { ProviderAccountRecord } from "../../src/db/repositories/provider-accounts";
import { listProviderAccountQuotas } from "../../src/domain/providers/provider-account-tracking";

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

describe("account quota cache", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSystemTime();
  });

  test("shares one upstream lookup between concurrent cold reads", async () => {
    let calls = 0;
    let release: ((response: Response) => void) | undefined;
    globalThis.fetch = (() => {
      calls++;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }) as unknown as typeof fetch;
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
    globalThis.fetch = (() => {
      calls++;
      return Promise.resolve(
        Response.json({ five_hour: { utilization: utilization++ } })
      );
    }) as unknown as typeof fetch;
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
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ five_hour: { utilization: utilization++ } })
      )) as unknown as typeof fetch;
    const original = claudeAccount("identity-one");
    const replaced = claudeAccount("identity-two", original.id);

    const first = await listProviderAccountQuotas(database, [original]);
    expect(fiveHourUtilization(first.get(original.id))).toBe(30);

    const second = await listProviderAccountQuotas(database, [replaced]);
    expect(fiveHourUtilization(second.get(original.id))).toBe(31);
  });
});
