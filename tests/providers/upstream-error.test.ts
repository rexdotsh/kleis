import { expect, test } from "bun:test";
import { readUpstreamResponseError } from "../../src/providers/proxies/upstream-error";

test("only allowlisted error metadata is read, without changing response bytes", async () => {
  const body =
    '{ "error": {"type":"permission_error","code":"private-code","message":"private prompt", "param":"private tool content"} }';
  const response = new Response(body, {
    status: 403,
    headers: { "content-type": "application/json" },
  });
  expect(await readUpstreamResponseError(response)).toEqual({
    errorType: "permission_error",
    errorCode: null,
  });
  expect(await response.text()).toBe(body);
});

test.each([
  "text/html",
  "text/event-stream",
])("%s error bodies are never read for logging", async (contentType) => {
  const response = new Response("private body", {
    status: 502,
    headers: { "content-type": contentType },
  });
  expect(await readUpstreamResponseError(response)).toEqual({
    errorType: null,
    errorCode: null,
  });
  expect(await response.text()).toBe("private body");
});

test("oversized or invalid JSON does not become log content", async () => {
  for (const body of [
    "private malformed JSON",
    JSON.stringify({
      error: { code: "server_error", message: "private".repeat(2000) },
    }),
  ]) {
    const response = new Response(body, {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    expect(await readUpstreamResponseError(response)).toEqual({
      errorType: null,
      errorCode: null,
    });
    expect(await response.text()).toBe(body);
  }
});

test("an unfinished JSON body cannot hold the proxy open for logging", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":'));
      },
    }),
    { status: 503, headers: { "content-type": "application/json" } }
  );
  const startedAt = Date.now();
  expect(await readUpstreamResponseError(response)).toEqual({
    errorType: null,
    errorCode: null,
  });
  expect(Date.now() - startedAt).toBeLessThan(1000);
  await response.body?.cancel();
});
