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
  decodeClaudeSubscriptionUsage,
  readClaudeRateLimitHeaders,
} from "../../src/providers/account-tracking/claude";

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
      plan_type: "plus",
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

    expect(result.planType).toBe("plus");
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

  test("normalizes unified response headers from 0-1 to 0-100", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.43",
      "anthropic-ratelimit-unified-5h-reset": "2026-08-17T16:30:00Z",
      "anthropic-ratelimit-tokens-remaining": "1200",
      "anthropic-workspace-id": "workspace-1",
    });
    const result = readClaudeRateLimitHeaders(headers);

    expect(result?.workspaceId).toBe("workspace-1");
    expect(result?.unified.fiveHour).toEqual({
      utilization: 43,
      rawUtilization: "0.43",
      resetsAt: "2026-08-17T16:30:00Z",
    });
    expect(result?.limits["anthropic-ratelimit-tokens-remaining"]).toBe("1200");
    expect(readClaudeRateLimitHeaders(new Headers())).toBeNull();
  });
});
