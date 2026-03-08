import { describe, expect, test } from "bun:test";

import {
  calculateSuccessRate,
  classifyRequestOutcome,
  countScoredFailures,
  countUnattributedFailures,
} from "../../src/usage/request-outcome";

describe("request outcome metrics", () => {
  test("excludes 429s from scored failures", () => {
    const upstreamRateLimited = classifyRequestOutcome(429, "upstream");
    const proxyRateLimited = classifyRequestOutcome(429, "proxy");

    expect(upstreamRateLimited).toEqual({
      successCount: 0,
      clientErrorCount: 0,
      serverErrorCount: 0,
      authErrorCount: 0,
      rateLimitCount: 1,
      proxyErrorCount: 0,
      upstreamErrorCount: 0,
    });
    expect(proxyRateLimited).toEqual(upstreamRateLimited);
  });

  test("tracks upstream failures separately from proxy failures", () => {
    expect(classifyRequestOutcome(502, "upstream")).toEqual({
      successCount: 0,
      clientErrorCount: 0,
      serverErrorCount: 1,
      authErrorCount: 0,
      rateLimitCount: 0,
      proxyErrorCount: 0,
      upstreamErrorCount: 1,
    });

    expect(classifyRequestOutcome(502, "proxy")).toEqual({
      successCount: 0,
      clientErrorCount: 0,
      serverErrorCount: 1,
      authErrorCount: 0,
      rateLimitCount: 0,
      proxyErrorCount: 1,
      upstreamErrorCount: 0,
    });
  });

  test("does not let upstream failures reduce success rate", () => {
    const counts = {
      successCount: 8,
      clientErrorCount: 1,
      serverErrorCount: 5,
      authErrorCount: 0,
      rateLimitCount: 3,
      proxyErrorCount: 1,
      upstreamErrorCount: 5,
    };

    expect(countUnattributedFailures(counts)).toBe(0);
    expect(countScoredFailures(counts)).toBe(1);
    expect(calculateSuccessRate(counts)).toBe(89);
  });

  test("keeps legacy unattributed failures in the denominator", () => {
    const counts = {
      successCount: 8,
      clientErrorCount: 2,
      serverErrorCount: 1,
      authErrorCount: 1,
      rateLimitCount: 4,
      proxyErrorCount: 0,
      upstreamErrorCount: 0,
    };

    expect(countUnattributedFailures(counts)).toBe(4);
    expect(countScoredFailures(counts)).toBe(4);
    expect(calculateSuccessRate(counts)).toBe(67);
  });

  test("returns null when only excluded outcomes are present", () => {
    expect(
      calculateSuccessRate({
        successCount: 0,
        clientErrorCount: 0,
        serverErrorCount: 0,
        authErrorCount: 0,
        rateLimitCount: 7,
        proxyErrorCount: 0,
        upstreamErrorCount: 0,
      })
    ).toBeNull();
  });
});
