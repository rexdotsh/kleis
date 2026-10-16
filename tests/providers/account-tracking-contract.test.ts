import { describe, expect, test } from "bun:test";

import {
  decodeClaudeResetClaimResult,
  decodeClaudeResetStatus,
  summarizeClaudeResets,
} from "../../src/providers/account-tracking/claude-resets";

describe("Claude saved reset contracts", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const grant = (overrides: Record<string, unknown> = {}) => ({
    id: "grant_fake_1",
    label: "Fake saved reset",
    resets_total: 1,
    resets_left: 1,
    starts_at: "2026-09-22T16:00:00+00:00",
    ends_at: "2026-10-22T16:00:00+00:00",
    clears: ["five_hour", "seven_day"],
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    percent_used: { five_hour: 30, seven_day: 55 },
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
  const usage = { five_hour: 30, seven_day: 55 };
  const summarize = (
    overrides: Record<string, unknown> = {},
    current: Record<string, number> = usage,
    binding: unknown[] = []
  ) => {
    const status = decodeClaudeResetStatus(block(overrides));
    if (!status) throw new Error("block did not decode");
    return summarizeClaudeResets(status, current, binding, now);
  };

  test("decodes the observed OAuth shape without event props", () => {
    expect(decodeClaudeResetStatus(block())).toEqual({
      eligible: true,
      ineligibleReason: null,
      grants: [
        {
          id: "grant_fake_1",
          label: "Fake saved reset",
          resetsLeft: 1,
          startsAt: "2026-09-22T16:00:00+00:00",
          endsAt: "2026-10-22T16:00:00+00:00",
          clears: ["five_hour", "seven_day"],
          paused: false,
          usableNow: true,
          useRequiresLimit: false,
          blocking: [],
          hasUnknownLimits: false,
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
        earlyUse: { limit: "seven_day", percentUsed: 55 },
      },
    });
  });

  test("a missing or malformed block is unevaluated, not zero", () => {
    for (const value of [undefined, null, { grants: [] }, { eligible: "yes" }])
      expect(decodeClaudeResetStatus(value)).toBeNull();
  });

  test("skips malformed grants, drops a dangling next grant and flags unknown limits", () => {
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
            usable_now: "true",
            use_requires_limit: null,
          }),
        ],
      })
    );
    expect(status?.grants).toEqual([
      expect.objectContaining({
        id: "grant_fake_5",
        clears: ["five_hour"],
        usableNow: false,
        useRequiresLimit: true,
        hasUnknownLimits: true,
      }),
    ]);
    expect(status?.nextGrantId).toBeNull();
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
      [{ grants: [grant({ clears: ["mystery"] })] }, "unsupported_limits"],
      [{ grants: [grant({ blocking: ["mystery"] })] }, "unsupported_limits"],
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

  test("early use follows current limits, not the grant's own percentages", () => {
    const needsLimit = { grants: [grant({ use_requires_limit: true })] };
    expect(summarize(needsLimit, { five_hour: 100 }).offer).toMatchObject({
      earlyUse: null,
    });
    expect(summarize({}, {}).offer?.earlyUse).toEqual({
      limit: null,
      percentUsed: null,
    });
  });

  test("the offer key binds everything the admin confirms", () => {
    const key = summarize().offer?.key;
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    for (const changed of [
      summarize({ grants: [grant({ resets_left: 2 })] }),
      summarize({ grants: [grant({ clears: ["five_hour"] })] }),
      summarize({ grants: [grant({ label: "A different offer" })] }),
      summarize({ weekly_resets_at: "2026-10-20T19:00:00Z" }),
      summarize({ grants: [grant(), grant({ id: "another_grant" })] }),
      summarize({}, { five_hour: 30, seven_day: 60 }),
      summarize({}, { five_hour: 100 }),
      summarize({}, usage, [1]),
    ])
      expect(changed.offer?.key).not.toBe(key);
  });

  test("decodes claim results strictly", () => {
    expect(
      decodeClaudeResetClaimResult({
        result: "reset",
        reason: null,
        resets_left: 0,
        cleared: ["five_hour", "mystery_window"],
      })
    ).toEqual({
      result: "reset",
      reason: null,
      resetsLeft: 0,
      cleared: ["five_hour"],
    });
    for (const value of [{ result: "granted" }, {}, "reset"])
      expect(() => decodeClaudeResetClaimResult(value)).toThrow();
  });
});
