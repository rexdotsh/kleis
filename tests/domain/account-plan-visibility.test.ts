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
import {
  expireProviderAccountTracking,
  listProviderAccountQuotas,
  peekProviderAccountProfiles,
  peekProviderAccountQuotas,
  setAccountSnapshotStore,
} from "../../src/domain/providers/provider-account-tracking";
import {
  isAccountVisible,
  isFreeTierAccount,
} from "../../public/admin/app-account-visibility.js";

const START = Date.UTC(2026, 9, 15, 12);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const database = {} as Database;
const originalFetch = globalThis.fetch;
const accountFixture = (
  provider: "codex" | "claude"
): ProviderAccountRecord => ({
  id: crypto.randomUUID(),
  provider,
  label: "Fake account",
  accountId: null,
  isPrimary: false,
  enabled: true,
  metadata: null,
  accessToken: "fake-access",
  refreshToken: "fake-refresh",
  refreshLockToken: null,
  refreshLockExpiresAt: null,
  expiresAt: START + 7 * 24 * HOUR,
  lastRefreshAt: null,
  lastRefreshStatus: null,
  createdAt: START,
  updatedAt: START,
});
function deferredResponse() {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}
const profileResponse = (organizationType = "claude_free") =>
  Response.json({
    organization: { organization_type: organizationType },
  });
const statusResponse = (planType = "free") =>
  Response.json({ plan_type: planType });
const advanceTo = (elapsed: number) => setSystemTime(START + elapsed);
const settle = () => Bun.sleep(0);
const view = (account: ProviderAccountRecord) => ({
  ...account,
  quota: peekProviderAccountQuotas(database, [account]).get(account.id),
  profile: peekProviderAccountProfiles([account]).get(account.id),
});
const expectHidden = (account: ProviderAccountRecord) => {
  const current = view(account);
  expect(isFreeTierAccount(current)).toBe(true);
  expect(isAccountVisible(current)).toBe(false);
  return current;
};
const expectVisible = (account: ProviderAccountRecord) => {
  const current = view(account);
  expect(isFreeTierAccount(current)).toBe(false);
  expect(isAccountVisible(current)).toBe(true);
  return current;
};

describe("free-plan visibility through provider revalidation", () => {
  beforeEach(() => {
    setSystemTime(START);
    setAccountSnapshotStore(null);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSystemTime();
  });

  test.each([0, 0.999])(
    "Claude keeps free accounts hidden across jitter (%s), SWR, and recovery",
    async (random) => {
      const jitter = spyOn(Math, "random").mockReturnValue(random);
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const account = accountFixture("claude");
        let profileCalls = 0;
        let response: () => Response | Promise<Response> = () =>
          profileResponse();
        globalThis.fetch = (async (input: string | URL | Request) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/oauth/profile") {
            profileCalls++;
            return response();
          }
          return Response.json({ five_hour: { utilization: 0 } });
        }) as typeof fetch;
        await listProviderAccountQuotas(database, [account]);
        expectHidden(account);

        advanceTo(22 * HOUR + 59 * MINUTE);
        expectHidden(account);
        await settle();
        expect(profileCalls).toBe(1);

        const pending = deferredResponse();
        response = () => pending.promise;
        advanceTo(23 * HOUR + 59 * MINUTE);
        expectHidden(account);
        await settle();
        expect(profileCalls).toBe(random === 0 ? 1 : 2);
        advanceTo(24 * HOUR + 3 * MINUTE);
        expectHidden(account);
        await settle();
        expect(profileCalls).toBe(2);
        advanceTo(24 * HOUR + 4 * MINUTE);
        expect(expectHidden(account).profile?.fetchedAt).toBe(START);
        pending.resolve(profileResponse());
        await settle();
        const refreshedAt = Date.now();
        expect(expectHidden(account).profile).toMatchObject({
          fetchedAt: refreshedAt,
          error: null,
        });

        const failed = deferredResponse();
        response = () => failed.promise;
        expireProviderAccountTracking(account.id);
        expectHidden(account);
        failed.resolve(Response.json({}, { status: 503 }));
        await settle();
        const rejected = expectVisible(account);
        expect(rejected.quota?.error).toBeNull();
        expect(rejected.profile).toMatchObject({
          fetchedAt: refreshedAt,
          error: "Claude OAuth profile request failed (503)",
          data: { organizationType: "claude_free" },
        });

        const recovered = deferredResponse();
        response = () => recovered.promise;
        advanceTo(24 * HOUR + 10 * MINUTE + 1);
        expectVisible(account);
        recovered.resolve(profileResponse());
        await settle();
        expect(expectHidden(account).profile?.error).toBeNull();

        const upgraded = deferredResponse();
        response = () => upgraded.promise;
        expireProviderAccountTracking(account.id);
        expectHidden(account);
        upgraded.resolve(profileResponse("claude_pro"));
        await settle();
        expect(expectVisible(account).profile).toMatchObject({
          error: null,
          data: { plan: { type: "pro" } },
        });
      } finally {
        jitter.mockRestore();
        warn.mockRestore();
      }
    }
  );

  test("Codex stays hidden during SWR, surfaces failures, and accepts recovery and upgrades", async () => {
    const account = accountFixture("codex");
    let statusCalls = 0;
    let response: () => Response | Promise<Response> = () => statusResponse();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/usage")) {
        statusCalls++;
        return response();
      }
      if (path.endsWith("/rate-limit-reset-credits"))
        return Response.json({ available_count: 0, credits: [] });
      return Response.json({});
    }) as typeof fetch;
    await listProviderAccountQuotas(database, [account]);
    expectHidden(account);
    advanceTo(59_000);
    expectHidden(account);
    expect(statusCalls).toBe(1);

    const pending = deferredResponse();
    response = () => pending.promise;
    advanceTo(61_000);
    expectHidden(account);
    await settle();
    expect(statusCalls).toBe(2);
    advanceTo(75_000);
    expect(expectHidden(account).quota?.fetchedAt).toBe(START);
    pending.resolve(statusResponse());
    await settle();
    expect(expectHidden(account).quota?.fetchedAt).toBe(START + 61_000);

    const failed = deferredResponse();
    response = () => failed.promise;
    advanceTo(122_000);
    expectHidden(account);
    failed.resolve(Response.json({}, { status: 503 }));
    await settle();
    expect(expectVisible(account).quota).toMatchObject({
      errorStatus: 503,
      data: { status: { planType: "free" } },
    });

    const recovered = deferredResponse();
    response = () => recovered.promise;
    advanceTo(183_000);
    expectVisible(account);
    recovered.resolve(statusResponse());
    await settle();
    expect(expectHidden(account).quota?.error).toBeNull();

    const upgraded = deferredResponse();
    response = () => upgraded.promise;
    advanceTo(244_000);
    expectHidden(account);
    upgraded.resolve(statusResponse("plus"));
    await settle();
    expect(expectVisible(account).quota).toMatchObject({
      error: null,
      data: { status: { planType: "plus" } },
    });
    expect(statusCalls).toBe(5);
  });
});
