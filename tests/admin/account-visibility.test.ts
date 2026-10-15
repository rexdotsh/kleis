import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import {
  isAccountVisible,
  isFreeTierAccount,
} from "../../public/admin/app-account-visibility.js";

const NOW = Date.UTC(2026, 9, 15, 12);
const HOUR = 60 * 60 * 1000;
const codex = (planType: string | null, fetchedAt = NOW) => ({
  id: "fake-account",
  provider: "codex",
  quota: { fetchedAt, error: null, data: { status: { planType } } },
});
const claude = (fetchedAt: number | null = NOW) => ({
  provider: "claude",
  profile: {
    fetchedAt,
    data: { organizationType: "claude_free", plan: { type: "free" } },
  },
  quota: { fetchedAt: NOW, error: null, data: { plan: { type: "free" } } },
});

describe("free-tier account detection", () => {
  beforeEach(() => setSystemTime(NOW));
  afterEach(() => setSystemTime());
  test.each([
    [codex("free"), true],
    [
      {
        ...codex(null),
        profile: { fetchedAt: NOW, data: { planType: "free" } },
      },
      true,
    ],
    [
      {
        ...codex("plus"),
        profile: { fetchedAt: NOW, data: { planType: "free" } },
      },
      false,
    ],
    [
      {
        provider: "claude",
        profile: {
          fetchedAt: NOW,
          data: { organizationType: "claude_free", plan: null },
        },
      },
      true,
    ],
    [
      {
        provider: "claude",
        quota: { data: { plan: { type: "free", label: "Free" } } },
      },
      false,
    ],
    [
      {
        provider: "claude",
        profile: { fetchedAt: NOW, data: { plan: { type: "free" } } },
      },
      true,
    ],
    [codex(null), false],
    [codex("free_trial"), false],
    [
      {
        provider: "claude",
        profile: {
          fetchedAt: NOW,
          data: { organizationType: "api", subscriptionStatus: null },
        },
      },
      false,
    ],
    [
      {
        provider: "claude",
        profile: {
          fetchedAt: NOW,
          data: {
            organizationType: "claude_future",
            rateLimitTier: "default_claude_free",
          },
        },
      },
      false,
    ],
    [{ provider: "claude", quota: { data: { plan: null } } }, false],
    [
      { provider: "other", quota: { data: { status: { planType: "free" } } } },
      false,
    ],
  ])(
    "classifies explicit plans without inferring from missing subscriptions: %j",
    (account, expected) => {
      expect(isFreeTierAccount(account)).toBe(expected);
    }
  );

  test.each([
    ["fresh verified Claude profile", claude(), true],
    [
      "upgraded account with a three-day-old free profile and a recent usage sync",
      claude(NOW - 72 * HOUR),
      false,
    ],
    [
      "profile at the earliest refresh boundary",
      claude(NOW - 23 * HOUR),
      false,
    ],
    [
      "profile just inside the refresh boundary",
      claude(NOW - 23 * HOUR + 1),
      true,
    ],
    ["undated profile", claude(null), false],
    ["future-dated profile", claude(NOW + 1), false],
    [
      "missing profile with a recently copied free plan",
      { provider: "claude", quota: claude().quota },
      false,
    ],
    [
      "paid Claude profile superseding a cached free quota plan",
      {
        ...claude(),
        profile: {
          fetchedAt: NOW,
          data: { organizationType: "claude_pro", plan: { type: "pro" } },
        },
      },
      false,
    ],
    [
      "failed profile retry retaining its timestamp despite successful usage sync",
      claude(NOW - 23.5 * HOUR),
      false,
    ],
    [
      "failed token refresh",
      { ...claude(), lastRefreshStatus: "failed" },
      false,
    ],
    [
      "failed usage refresh retaining free data",
      {
        ...claude(),
        quota: { ...claude().quota, error: "Usage refresh failed" },
      },
      false,
    ],
    [
      "failed refresh status without a message",
      { ...claude(), quota: { ...claude().quota, errorStatus: 503 } },
      false,
    ],
    [
      "stale Codex usage with a fresh free profile",
      {
        ...codex("free", NOW - 60_000),
        profile: { fetchedAt: NOW, data: { planType: "free" } },
      },
      false,
    ],
    [
      "failed Codex usage with a fresh free profile",
      {
        ...codex("free"),
        quota: { ...codex("free").quota, error: "Usage refresh failed" },
        profile: { fetchedAt: NOW, data: { planType: "free" } },
      },
      false,
    ],
    [
      "stale Codex profile fallback",
      {
        provider: "codex",
        profile: { fetchedAt: NOW - 72 * HOUR, data: { planType: "free" } },
      },
      false,
    ],
    [
      "unverifiable Codex quota",
      { provider: "codex", quota: { data: { status: { planType: "free" } } } },
      false,
    ],
  ])("%s", (_name, account, expected) => {
    expect(isFreeTierAccount(account)).toBe(expected);
  });

  test("keeps primary accounts, pins, traffic and unknown plans visible", () => {
    const free = codex("free");
    expect(isAccountVisible(free)).toBe(false);
    expect(isAccountVisible(free, { showFreeTier: true })).toBe(true);
    expect(isAccountVisible({ ...free, isPrimary: true })).toBe(true);
    expect(isAccountVisible(free, { keepIds: new Set([free.id]) })).toBe(true);
    expect(isAccountVisible(free, { usage: { requestCount: 1 } })).toBe(true);
    expect(isAccountVisible(free, { usage: { requestCount: 0 } })).toBe(false);
    expect(isAccountVisible(codex(null))).toBe(true);
  });
});
