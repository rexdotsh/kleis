import { describe, expect, test } from "bun:test";

import {
  buildCodexTrackingUrl,
  decodeCodexAccounts,
  decodeCodexResetCredits,
  decodeCodexThreadUsage,
  decodeCodexUsageProfile,
  decodeCodexUsageStatus,
} from "../../src/providers/account-tracking/codex";
import {
  decodeClaudeSubscriptionPlan,
  decodeClaudeSubscriptionUsage,
} from "../../src/providers/account-tracking/claude";
import {
  decodeClaudeResetClaimResult,
  decodeClaudeResetStatus,
  summarizeClaudeResets,
} from "../../src/providers/account-tracking/claude-resets";

describe("Codex account tracking contracts", () => {
  test("builds both supported private route styles", () => {
    expect(buildCodexTrackingUrl("usage")).toBe(
      "https://chatgpt.com/backend-api/wham/usage"
    );
    expect(
      buildCodexTrackingUrl("profiles/me", "https://codex.example.test/v2")
    ).toBe("https://codex.example.test/api/codex/profiles/me");
  });

  test("normalizes quota windows and ignores additive fields", () => {
    const result = decodeCodexUsageStatus({
      plan_type: "self_serve_business_prolite",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 36,
          limit_window_seconds: 18_000,
          reset_after_seconds: 1234,
          reset_at: 1_786_712_700,
          future_field: true,
        },
        secondary_window: null,
      },
      credits: { has_credits: true, unlimited: false, balance: "12.5" },
      spend_control: { reached: false, individual_limit: null },
      rate_limit_reset_credits: { available_count: 1 },
      additional_rate_limits: [
        {
          metered_feature: "review",
          limit_name: "code review",
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { used_percent: 8 },
          },
        },
      ],
      unknown_top_level: "ignored",
    });

    expect(result.planType).toBe("self_serve_business_prolite");
    expect(result.primaryWindow).toEqual({
      usedPercent: 36,
      windowSeconds: 18_000,
      resetAfterSeconds: 1234,
      resetAt: 1_786_712_700,
    });
    expect(result.credits?.balance).toBe("12.5");
    expect(result.additionalRateLimits[0]?.primaryWindow?.usedPercent).toBe(8);
    expect(result.resetCreditsAvailable).toBe(1);
    expect(result).not.toHaveProperty("unknown_top_level");
  });

  test("decodes the spend limit and limit-reached type objects", () => {
    const result = decodeCodexUsageStatus({
      spend_control: {
        reached: true,
        individual_limit: {
          source: "workspace",
          limit: "50.00",
          used: "48.25",
          remaining: "1.75",
          used_percent: 96.5,
          remaining_percent: 3.5,
          reset_after_seconds: 3600,
          reset_at: 1_786_712_700,
        },
      },
      rate_limit_reached_type: { type: "primary_window" },
    });

    expect(result.spendControl).toEqual({
      reached: true,
      individualLimit: {
        source: "workspace",
        limit: "50.00",
        used: "48.25",
        remaining: "1.75",
        usedPercent: 96.5,
        remainingPercent: 3.5,
        resetAfterSeconds: 3600,
        resetAt: 1_786_712_700,
      },
    });
    expect(result.rateLimitReachedType).toBe("primary_window");
    expect(
      decodeCodexUsageStatus({ rate_limit_reached_type: "secondary_window" })
        .rateLimitReachedType
    ).toBe("secondary_window");
  });

  test("normalizes reset credits, profiles, accounts, and thread usage", () => {
    expect(
      decodeCodexResetCredits({
        available_count: 1,
        credits: [
          {
            id: "credit-1",
            reset_type: "codex_rate_limits",
            status: "available",
            granted_at: "2026-08-07T17:59:44Z",
            expires_at: "2026-08-12T17:59:44Z",
          },
          { status: "missing-id" },
        ],
      }).credits
    ).toHaveLength(1);
    expect(
      decodeCodexUsageProfile({
        stats: {
          lifetime_tokens: 123_456,
          daily_usage_buckets: [{ start_date: "2026-08-07", tokens: 1200 }],
        },
      }).dailyUsageBuckets
    ).toEqual([{ startDate: "2026-08-07", tokens: 1200 }]);
    expect(
      decodeCodexAccounts({
        accounts: {
          first: { id: "account-1", name: "Personal", structure: "personal" },
        },
        default_account_id: "account-1",
      }).accounts[0]?.id
    ).toBe("account-1");
    // Shape of a live /wham/accounts/check response for a workspace seat.
    expect(
      decodeCodexAccounts({
        accounts: [
          {
            id: "account-2",
            account_user_id: "user-2__account-2",
            account_user_role: "account-owner",
            structure: "workspace",
            plan_type: "self_serve_business_prolite",
            is_deactivated: false,
            name: "Example Workspace",
            profile_picture_url: null,
          },
        ],
        default_account_id: "account-2",
        account_ordering: ["account-2"],
      }).accounts[0]
    ).toEqual({
      id: "account-2",
      name: "Example Workspace",
      profilePictureUrl: null,
      structure: "workspace",
      planType: "self_serve_business_prolite",
      role: "account-owner",
      isDeactivated: false,
    });
    expect(
      decodeCodexThreadUsage({
        threads: [
          {
            thread_id: "thread-1",
            estimated_usage_credits_micros: 1_230_000,
            groups: [
              {
                model: "gpt-5-codex",
                input_tokens: 1200,
                output_tokens: 500,
                total_tokens: 1700,
              },
            ],
          },
        ],
      })[0]?.groups[0]?.totalTokens
    ).toBe(1700);
  });
});

describe("Claude account tracking contracts", () => {
  // Synthetic profiles modeled on Claude Code 2.1.63's fetchProfileInfo contract.
  test.each([
    ["claude_free", null, "free", "Free"],
    ["claude_free", "default_claude_free", "free", "Free"],
    ["claude_pro", "default_claude_pro", "pro", "Pro"],
    ["claude_max", "default_claude_max_5x", "max_5x", "Max 5x"],
    ["claude_max", "default_claude_max_20x", "max_20x", "Max 20x"],
    ["claude_max", null, "max", "Max"],
    ["claude_max", "future_max_tier", "max", "Max"],
    ["claude_team", "default_claude_max_5x", "team_premium", "Team Premium"],
    ["claude_team", "default_raven", "team", "Team"],
    ["claude_enterprise", "default_claude_max_20x", "enterprise", "Enterprise"],
  ])("maps %s / %s to %s (%s)", (organizationType, tier, type, label) => {
    expect(
      decodeClaudeSubscriptionPlan({
        account: { uuid: "fake-user", email: "alex@northwind.dev" },
        organization: {
          uuid: "fake-org",
          organization_type: organizationType,
          rate_limit_tier: tier,
          billing_type: "stripe_subscription",
          future_field: true,
        },
      })
    ).toEqual({ type, label });
  });

  // Seat tiers as reported for live Team accounts.
  test.each([
    ["team_standard", "default_raven", "team_standard", "Team Standard"],
    ["team_tier_1", "default_claude_max_5x", "team_premium", "Team Premium"],
    ["team_future_seat", "default_raven", "team", "Team"],
  ])("maps the Team %s seat (%s) to %s (%s)", (seatTier, tier, type, label) => {
    expect(
      decodeClaudeSubscriptionPlan({
        organization: {
          organization_type: "claude_team",
          rate_limit_tier: tier,
          seat_tier: seatTier,
        },
      })
    ).toEqual({ type, label });
  });

  test.each([
    {},
    { organization: null },
    { organization: { organization_type: "api" } },
    { organization: { organization_type: "claude_future" } },
    { organization: { organization_type: 123 } },
    { organization: { rate_limit_tier: "default_claude_max_20x" } },
    { account: { has_claude_max: true, has_claude_pro: true } },
    { account: { has_claude_max: false, has_claude_pro: false } },
  ])("does not guess a subscription for %j", (profile) => {
    expect(decodeClaudeSubscriptionPlan(profile)).toBeNull();
  });

  test.each([{ value: null }, { value: [] }, { value: "not a profile" }])(
    "rejects malformed profile %j",
    ({ value }) => {
      expect(() => decodeClaudeSubscriptionPlan(value)).toThrow(
        "Claude OAuth profile response is malformed"
      );
    }
  );

  test("keeps subscription, scoped limit, and overage data separate", () => {
    const result = decodeClaudeSubscriptionUsage({
      five_hour: { utilization: 10, resets_at: "2026-08-17T16:30:00Z" },
      seven_day: { utilization: 4, resets_at: "2026-08-24T08:00:00Z" },
      seven_day_opus: { utilization: 2, resets_at: null },
      extra_usage: {
        is_enabled: false,
        monthly_limit: 31_000,
        used_credits: 23_408,
        utilization: 75.5,
        currency: "AUD",
        disabled_reason: "out_of_credits",
      },
      limits: [
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 2,
          resets_at: "2026-08-24T08:00:00Z",
          scope: { model: { id: null, display_name: "Fable" } },
          is_active: false,
        },
      ],
      future_field: { secret: "not retained" },
    });

    expect(result.fiveHour?.utilization).toBe(10);
    expect(result.modelWindows.seven_day_opus?.utilization).toBe(2);
    expect(result.extraUsage?.currency).toBe("AUD");
    expect(result.limits[0]?.modelDisplayName).toBe("Fable");
    expect(result.limits[0]?.isActive).toBe(false);
    expect(result).not.toHaveProperty("future_field");
  });
});

describe("Claude saved reset contracts", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const grant = (overrides: Record<string, unknown> = {}) => ({
    id: "grant_fake_1",
    label: "Fake saved reset",
    resets_total: 1,
    resets_left: 1,
    starts_at: "2026-09-22T16:00:00+00:00",
    ends_at: "2026-10-22T16:00:00+00:00",
    clears: ["five_hour", "seven_day", "seven_day_overage_included"],
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    percent_used: {
      five_hour: 30,
      seven_day: 55,
      seven_day_overage_included: 55,
    },
    blocking: [],
    arm: null,
    ...overrides,
  });
  const block = (overrides: Record<string, unknown> = {}) => ({
    eligible: true,
    ineligible_reason: null,
    at_limit: false,
    exhausted: [],
    grants: [grant()],
    next_grant_id: "grant_fake_1",
    weekly_resets_at: "2026-10-19T19:00:00+00:00",
    cooldown_until: null,
    event_props: { surface: "claude_code_cli", tier: "claude_max_5x" },
    ...overrides,
  });
  const summarize = (overrides: Record<string, unknown> = {}) => {
    const status = decodeClaudeResetStatus(block(overrides));
    if (!status) throw new Error("block did not decode");
    return summarizeClaudeResets(status, now);
  };

  test("decodes the observed OAuth shape without event props", () => {
    const status = decodeClaudeResetStatus(block());
    expect(status).toEqual({
      eligible: true,
      ineligibleReason: null,
      atLimit: false,
      exhausted: [],
      grants: [
        {
          id: "grant_fake_1",
          label: "Fake saved reset",
          resetsTotal: 1,
          resetsLeft: 1,
          startsAt: "2026-09-22T16:00:00+00:00",
          endsAt: "2026-10-22T16:00:00+00:00",
          clears: ["five_hour", "seven_day", "seven_day_overage_included"],
          paused: false,
          usableNow: true,
          useRequiresLimit: false,
          percentUsed: {
            five_hour: 30,
            seven_day: 55,
            seven_day_overage_included: 55,
          },
          blocking: [],
        },
      ],
      nextGrantId: "grant_fake_1",
      weeklyResetsAt: "2026-10-19T19:00:00+00:00",
      cooldownUntil: null,
    });
    expect(summarize()).toMatchObject({
      saved: 1,
      nextEndsAt: "2026-10-22T16:00:00+00:00",
      unavailable: null,
      offer: {
        grantId: "grant_fake_1",
        clears: ["five_hour", "seven_day", "seven_day_overage_included"],
        earlyUse: { limit: "seven_day", percentUsed: 55 },
      },
    });
  });

  test("a missing or malformed block is unevaluated, not zero", () => {
    expect(decodeClaudeResetStatus(undefined)).toBeNull();
    expect(decodeClaudeResetStatus(null)).toBeNull();
    expect(decodeClaudeResetStatus({ grants: [] })).toBeNull();
    expect(decodeClaudeResetStatus({ eligible: "yes" })).toBeNull();
  });

  test("skips malformed grants and drops a dangling next grant", () => {
    const status = decodeClaudeResetStatus(
      block({
        grants: [
          grant({ id: "Bad ID!" }),
          grant({ id: "grant_fake_2", resets_left: -1 }),
          grant({ id: "grant_fake_3", resets_left: 1.5 }),
          grant({ id: "grant_fake_4", resets_left: undefined }),
          grant({
            id: "grant_fake_5",
            clears: ["five_hour", "mystery_window"],
            percent_used: { five_hour: 140, seven_day: "12" },
            usable_now: "true",
            use_requires_limit: null,
          }),
        ],
        next_grant_id: "grant_fake_1",
        ineligible_reason: "brand_new_reason",
      })
    );
    expect(status?.grants).toEqual([
      expect.objectContaining({
        id: "grant_fake_5",
        clears: ["five_hour"],
        percentUsed: {},
        usableNow: false,
        useRequiresLimit: true,
      }),
    ]);
    expect(status?.nextGrantId).toBeNull();
    expect(status?.ineligibleReason).toBe("unknown");
  });

  test("only offers the server's next usable, live, unblocked grant", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ eligible: false, ineligible_reason: "surface" }, "ineligible"],
      [{ grants: [grant({ resets_left: 0 })] }, "none_left"],
      [{ grants: [grant({ ends_at: "2026-10-01T00:00:00Z" })] }, "none_left"],
      [{ grants: [grant({ starts_at: "2026-11-01T00:00:00Z" })] }, "none_left"],
      [{ grants: [grant({ ends_at: "soon" })] }, "none_left"],
      [{ grants: [grant({ paused: true })] }, "paused"],
      [{ grants: [grant({ usable_now: false })] }, "not_usable"],
      [{ grants: [grant({ clears: ["mystery_window"] })] }, "not_usable"],
      [{ grants: [grant({ blocking: ["seven_day_opus"] })] }, "not_usable"],
      [{ next_grant_id: null }, "not_usable"],
      [{ cooldown_until: "2026-10-15T13:00:00Z" }, "cooldown"],
      [{ cooldown_until: "later" }, "cooldown"],
      [{ grants: [grant({ use_requires_limit: true })] }, "requires_limit"],
    ];
    for (const [overrides, reason] of cases) {
      expect(summarize(overrides)).toMatchObject({
        offer: null,
        unavailable: reason,
      });
    }
    expect(
      summarize({ eligible: false, ineligible_reason: "surface" })
    ).toMatchObject({ saved: 0, ineligibleReason: "surface" });
    expect(summarize({ grants: [grant({ paused: true })] }).saved).toBe(1);
  });

  test("a grant that needs a limit is offered once a limit it refills is reached", () => {
    const summary = summarize({
      at_limit: true,
      exhausted: ["five_hour"],
      grants: [grant({ use_requires_limit: true })],
    });
    expect(summary.offer).toMatchObject({ earlyUse: null });
  });

  test("the offer key changes with what the admin confirms", () => {
    const key = summarize().offer?.key;
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(
      summarize({ grants: [grant({ resets_left: 2 })] }).offer?.key
    ).not.toBe(key);
    expect(
      summarize({ grants: [grant({ clears: ["five_hour"] })] }).offer?.key
    ).not.toBe(key);
  });

  test("decodes claim results strictly", () => {
    expect(
      decodeClaudeResetClaimResult({
        result: "reset",
        reason: null,
        resets_left: 0,
        cleared: ["five_hour", "mystery_window"],
        weekly_resets_at: "2026-10-19T19:00:00+00:00",
        cooldown_until: null,
      })
    ).toEqual({
      result: "reset",
      reason: null,
      resetsLeft: 0,
      cleared: ["five_hour"],
      weeklyResetsAt: "2026-10-19T19:00:00+00:00",
      cooldownUntil: null,
    });
    expect(
      decodeClaudeResetClaimResult({ result: "ineligible", reason: "new_one" })
        .reason
    ).toBe("unknown");
    expect(() => decodeClaudeResetClaimResult({ result: "granted" })).toThrow();
    expect(() => decodeClaudeResetClaimResult({})).toThrow();
    expect(() => decodeClaudeResetClaimResult("reset")).toThrow();
  });
});
