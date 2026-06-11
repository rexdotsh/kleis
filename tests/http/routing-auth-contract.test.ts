import { describe, expect, test } from "bun:test";

import { parseBearerToken } from "../../src/http/utils/bearer";
import { resolveRequestIdleTimeout } from "../../src/http/utils/request-timeout";
import {
  modelScopeCandidates,
  parseModelForProxyRoute,
  resolveProxyRoute,
} from "../../src/http/proxy-routing";
import {
  isRateLimitFailoverEnabled,
  shouldPersistRateLimitFailover,
  shouldRetryRateLimitWithNextAccount,
} from "../../src/http/rate-limit-failover";

describe("bearer parsing", () => {
  test("accepts case-insensitive bearer scheme", () => {
    expect(parseBearerToken("Bearer token-a")).toBe("token-a");
    expect(parseBearerToken("bearer token-b")).toBe("token-b");
    expect(parseBearerToken("BEARER token-c")).toBe("token-c");
  });

  test("rejects malformed authorization headers", () => {
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken("Token abc")).toBeNull();
    expect(parseBearerToken("Bearer")).toBeNull();
    expect(parseBearerToken("Bearer    ")).toBeNull();
  });
});

describe("proxy route mapping", () => {
  test("maps anthropic messages to claude provider", () => {
    const route = resolveProxyRoute("/anthropic/v1/messages");
    expect(route?.provider).toBe("claude");
    expect(route?.endpoint).toBe("messages");
  });

  test("maps openai responses to codex provider", () => {
    const route = resolveProxyRoute("/openai/v1/responses");
    expect(route?.provider).toBe("codex");
    expect(route?.endpoint).toBe("responses");
  });

  test("does not match openai chat completions", () => {
    expect(resolveProxyRoute("/openai/v1/chat/completions")).toBeNull();
  });

  test("does not match legacy generic v1 paths", () => {
    expect(resolveProxyRoute("/v1/chat/completions")).toBeNull();
  });

  test("strips route-specific model prefixes", () => {
    const route = resolveProxyRoute("/openai/v1/responses");
    expect(route).not.toBeNull();
    if (!route) {
      throw new Error("route missing");
    }

    const parsed = parseModelForProxyRoute("openai/gpt-5", route);
    expect(parsed.upstreamModel).toBe("gpt-5");
    expect(modelScopeCandidates(parsed, route)).toEqual([
      "openai/gpt-5",
      "gpt-5",
      "codex/gpt-5",
    ]);
  });

  test("rejects foreign prefixed model candidates", () => {
    const route = resolveProxyRoute("/copilot/v1/responses");
    expect(route).not.toBeNull();
    if (!route) {
      throw new Error("route missing");
    }

    const parsed = parseModelForProxyRoute("openai/gpt-5", route);
    expect(modelScopeCandidates(parsed, route)).toEqual([]);
  });
});

describe("request idle timeouts", () => {
  test("disables Bun idle timeouts for streaming proxy routes", () => {
    expect(resolveRequestIdleTimeout("/openai/v1/responses")).toBe(0);
    expect(resolveRequestIdleTimeout("/anthropic/v1/messages")).toBe(0);
    expect(resolveRequestIdleTimeout("/copilot/v1/chat/completions")).toBe(0);
  });

  test("leaves normal app routes on the server default idle timeout", () => {
    expect(resolveRequestIdleTimeout("/admin")).toBeNull();
    expect(resolveRequestIdleTimeout("/api.json")).toBeNull();
    expect(resolveRequestIdleTimeout("/openai/v2/responses")).toBeNull();
  });
});

describe("rate limit failover", () => {
  test("is disabled unless explicitly enabled", () => {
    const original = process.env.KLEIS_RATE_LIMIT_FAILOVER;
    try {
      process.env.KLEIS_RATE_LIMIT_FAILOVER = "";
      expect(isRateLimitFailoverEnabled()).toBe(false);

      process.env.KLEIS_RATE_LIMIT_FAILOVER = "0";
      expect(isRateLimitFailoverEnabled()).toBe(false);

      process.env.KLEIS_RATE_LIMIT_FAILOVER = "1";
      expect(isRateLimitFailoverEnabled()).toBe(true);
    } finally {
      if (original === undefined) {
        process.env.KLEIS_RATE_LIMIT_FAILOVER = "";
      } else {
        process.env.KLEIS_RATE_LIMIT_FAILOVER = original;
      }
    }
  });

  test("retries only the first eligible 429 with a next account", () => {
    expect(
      shouldRetryRateLimitWithNextAccount({
        failoverEnabled: true,
        failoverAttempted: false,
        canFailover: true,
        statusCode: 429,
        hasNextAccount: true,
      })
    ).toBe(true);

    expect(
      shouldRetryRateLimitWithNextAccount({
        failoverEnabled: true,
        failoverAttempted: true,
        canFailover: true,
        statusCode: 429,
        hasNextAccount: true,
      })
    ).toBe(false);

    expect(
      shouldRetryRateLimitWithNextAccount({
        failoverEnabled: true,
        failoverAttempted: false,
        canFailover: true,
        statusCode: 529,
        hasNextAccount: true,
      })
    ).toBe(false);
  });

  test("persists primary rotation only for unscoped requests", () => {
    expect(shouldPersistRateLimitFailover(null)).toBe(true);
    expect(shouldPersistRateLimitFailover([])).toBe(true);
    expect(shouldPersistRateLimitFailover(["account-a"])).toBe(false);
  });
});
