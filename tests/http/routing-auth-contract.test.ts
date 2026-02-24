import { describe, expect, test } from "bun:test";

import { parseBearerToken } from "../../src/http/utils/bearer";
import {
  modelScopeCandidates,
  parseModelForProxyRoute,
  resolveProxyRoute,
} from "../../src/http/proxy-routing";

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
