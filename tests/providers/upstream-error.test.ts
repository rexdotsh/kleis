import { expect, test } from "bun:test";
import { readUpstreamResponseError } from "../../src/providers/proxies/upstream-error";

test.each(["application/json", null])(
  "only allowlisted error metadata is read with content-type %s, without changing response bytes",
  async (contentType) => {
    const body =
      '{ "error": {"type":"permission_error","code":"private-code","message":"private prompt", "param":"private tool content"} }';
    const response = new Response(new TextEncoder().encode(body), {
      status: 403,
      headers: contentType ? { "content-type": contentType } : {},
    });
    expect(await readUpstreamResponseError(response)).toEqual({
      errorType: "permission_error",
      errorCode: null,
    });
    expect(await response.text()).toBe(body);
  }
);

test.each(["text/html", "text/event-stream"])(
  "%s error bodies are never read for logging",
  async (contentType) => {
    const response = new Response("private body", {
      status: 502,
      headers: { "content-type": contentType },
    });
    expect(await readUpstreamResponseError(response)).toEqual({
      errorType: null,
      errorCode: null,
    });
    expect(await response.text()).toBe("private body");
  }
);

test.each(["application/json", null])(
  "oversized or invalid JSON with content-type %s does not become log content",
  async (contentType) => {
    for (const body of [
      "private malformed JSON",
      JSON.stringify({
        error: { code: "server_error", message: "private".repeat(2000) },
      }),
    ]) {
      const response = new Response(new TextEncoder().encode(body), {
        status: 500,
        headers: contentType ? { "content-type": contentType } : {},
      });
      expect(await readUpstreamResponseError(response)).toEqual({
        errorType: null,
        errorCode: null,
      });
      expect(await response.text()).toBe(body);
    }
  }
);

test.each(["application/json", null])(
  "an unfinished JSON body with content-type %s cannot hold the proxy open for logging",
  async (contentType) => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":'));
        },
      }),
      {
        status: 503,
        headers: contentType ? { "content-type": contentType } : {},
      }
    );
    const startedAt = Date.now();
    expect(await readUpstreamResponseError(response)).toEqual({
      errorType: null,
      errorCode: null,
    });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await response.body?.cancel();
  }
);
