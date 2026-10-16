import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { createOpenAiSseUsagePassthrough } from "../../src/providers/proxies/openai-sse-passthrough";
import { readUpstreamResponseError } from "../../src/providers/proxies/upstream-error";

test("fetch decompresses SSE before passthrough and removes compressed body headers", async () => {
  const body =
    'data: {"type":"response.output_text.delta","delta":"café 🌊"}\n\n';
  const compressed = gzipSync(body);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(compressed, {
        headers: {
          "content-type": "text/event-stream",
          "content-encoding": "gzip",
          "content-length": String(compressed.byteLength),
        },
      }),
  });
  try {
    const response = createOpenAiSseUsagePassthrough({
      response: await fetch(server.url),
      extractUsage: () => null,
    });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.text()).toBe(body);
  } finally {
    await server.stop(true);
  }
});

test("logging a cloned, decompressed fetch error preserves the original response bytes", async () => {
  const body = '{ "error": {"type":"permission_error","message":"café 🌊"} }';
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(gzipSync(body), {
        status: 403,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      }),
  });
  try {
    const response = await fetch(server.url);
    expect(await readUpstreamResponseError(response)).toEqual({
      errorType: "permission_error",
      errorCode: null,
    });
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe(body);
  } finally {
    await server.stop(true);
  }
});

test("cancelling the logging tee after timeout leaves the original stream readable", async () => {
  const start = '{"error":{"type":"permission_error","message":"';
  const end = 'café 🌊"}}';
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(new TextEncoder().encode(start));
      },
    }),
    { status: 403, headers: { "content-type": "application/json" } }
  );
  expect(await readUpstreamResponseError(response)).toEqual({
    errorType: null,
    errorCode: null,
  });
  if (!source) {
    throw new Error("Missing response stream controller");
  }
  source.enqueue(new TextEncoder().encode(end));
  source.close();
  expect(await response.text()).toBe(`${start}${end}`);
});
