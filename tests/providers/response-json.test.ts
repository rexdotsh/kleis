import { expect, test } from "bun:test";
import { fetchTrackingJson } from "../../src/providers/account-tracking/http";
import { errorLogFields } from "../../src/utils/log";

test("tracking JSON parse failures cannot expose response bodies in errors or logs", async () => {
  const originalFetch = globalThis.fetch;
  const secret = "PRIVATESECRETTOKEN🔐";
  globalThis.fetch = (async () => new Response(secret)) as typeof fetch;
  try {
    let failure: unknown;
    try {
      await fetchTrackingJson({
        url: "https://example.test/usage",
        headers: {},
        timeoutMs: 1000,
        errorPrefix: "Account usage response",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SyntaxError);
    const fields = errorLogFields(failure);
    expect(fields.errorMessage).toContain("HTTP 200");
    expect(JSON.stringify(fields)).not.toContain("PRIVATESECRETTOKEN");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
