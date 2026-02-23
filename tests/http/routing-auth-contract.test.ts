import { describe, expect, test } from "bun:test";

import { parseBearerToken } from "../../src/http/utils/bearer";
import { isProviderSupportedForEndpoint } from "../../src/http/v1-routing";

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

describe("v1 provider endpoint compatibility", () => {
  test("disallows codex on chat_completions endpoint", () => {
    expect(isProviderSupportedForEndpoint("chat_completions", "codex")).toBe(
      false
    );
  });

  test("keeps codex enabled for responses endpoint", () => {
    expect(isProviderSupportedForEndpoint("responses", "codex")).toBe(true);
  });
});
