import { describe, expect, test } from "bun:test";
import {
  isAccountVisible,
  isFreeTierAccount,
} from "../../public/admin/app-account-visibility.js";

const codex = (planType: string | null) => ({
  id: "fake-account",
  provider: "codex",
  quota: { data: { status: { planType } } },
});

describe("free-tier account detection", () => {
  test.each([
    [codex("free"), true],
    [{ ...codex(null), profile: { data: { planType: "free" } } }, true],
    [{ ...codex("plus"), profile: { data: { planType: "free" } } }, false],
    [
      {
        provider: "claude",
        profile: { data: { organizationType: "claude_free", plan: null } },
      },
      true,
    ],
    [
      {
        provider: "claude",
        quota: { data: { plan: { type: "free", label: "Free" } } },
      },
      true,
    ],
    [
      { provider: "claude", profile: { data: { plan: { type: "free" } } } },
      true,
    ],
    [codex(null), false],
    [codex("free_trial"), false],
    [
      {
        provider: "claude",
        profile: {
          data: { organizationType: "api", subscriptionStatus: null },
        },
      },
      false,
    ],
    [
      {
        provider: "claude",
        profile: {
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
