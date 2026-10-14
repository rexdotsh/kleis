import { expect, test } from "bun:test";
import { fetchTrackingJson } from "../../src/providers/account-tracking/http";
import { readResponseJson } from "../../src/utils/response-json";
import { errorLogFields } from "../../src/utils/log";

test("provider parse errors retain HTTP status and UTF-8 byte count, without body text in message or stack", async () => {
  const body = "PRIVATESECRETTOKEN🔐";
  try {
    await readResponseJson(
      new Response(body, { status: 201 }),
      "Provider response"
    );
    throw new Error("Expected invalid JSON");
  } catch (error) {
    const fields = errorLogFields(error);
    expect(fields).toMatchObject({
      errorName: "SyntaxError",
      errorMessage: "Provider response is not valid JSON (HTTP 201, 22 bytes)",
      errorStack: expect.stringContaining(
        "Provider response is not valid JSON"
      ),
    });
    expect(JSON.stringify(fields)).not.toContain(body);
    expect(JSON.stringify(fields)).not.toContain("PRIVATESECRETTOKEN");
  }
});

test("provider JSON parsing leaves valid payloads and transport failures intact", async () => {
  expect(
    await readResponseJson(
      Response.json({ access_token: "fake-token" }),
      "Token response"
    )
  ).toEqual({ access_token: "fake-token" });
  const error = new Error("upstream connection reset");
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    })
  );
  await expect(readResponseJson(response, "Token response")).rejects.toBe(
    error
  );
});

test("parse diagnostics count original bytes even for malformed UTF-8", async () => {
  await expect(
    readResponseJson(
      new Response(new Uint8Array([0xff, 0xff])),
      "Provider response"
    )
  ).rejects.toThrow("Provider response is not valid JSON (HTTP 200, 2 bytes)");
});

test("tracking JSON parse failures are content-free too", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response("PRIVATESECRETTOKEN"))) as typeof fetch;
  try {
    await expect(
      fetchTrackingJson({
        url: "https://example.test/usage",
        headers: {},
        timeoutMs: 1000,
        errorPrefix: "Account usage response",
      })
    ).rejects.toThrow(
      "Account usage response is not valid JSON (HTTP 200, 18 bytes)"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
