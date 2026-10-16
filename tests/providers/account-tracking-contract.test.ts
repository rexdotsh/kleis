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
      [
        { grants: [grant({ clears: ["mystery_window"] })] },
        "unsupported_limits",
      ],
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

  test("confirmation keys bind early use, labels, weekly dates, and the displayed saved count", () => {
    const key = summarize().offer?.key;
    for (const changed of [
      { exhausted: ["five_hour"] },
      { grants: [grant({ percent_used: { five_hour: 0 } })] },
      { grants: [grant({ label: "A different offer" })] },
      { weekly_resets_at: "2026-10-20T19:00:00Z" },
      { grants: [grant(), grant({ id: "another_grant" })] },
    ])
      expect(summarize(changed).offer?.key).not.toBe(key);
  });

  test("a persisted grant without validated limit-type information is not claimable", () => {
    const status = decodeClaudeResetStatus(block());
    const first = status?.grants[0];
    if (!status || !first) throw new Error("grant missing");
    Reflect.deleteProperty(first, "hasUnknownLimits");
    expect(summarizeClaudeResets(status, now).offer).toBeNull();
  });
});
