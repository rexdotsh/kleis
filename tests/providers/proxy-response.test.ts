import { expect, spyOn, test } from "bun:test";
import { prepareClaudeProxyRequest } from "../../src/providers/proxies/claude-proxy";
import { prepareCodexProxyRequest } from "../../src/providers/proxies/codex-proxy";
import { createOpenAiSseUsagePassthrough } from "../../src/providers/proxies/openai-sse-passthrough";
import type { TokenUsage } from "../../src/usage/token-usage";

type Provider = "codex" | "claude";
const encoder = new TextEncoder();
const event = (payload: { type: string; [key: string]: unknown }): string =>
  `event: ${payload.type}\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
const terminal = (provider: Provider): string =>
  event({ type: provider === "codex" ? "response.completed" : "message_stop" });
const prepare = (
  provider: Provider,
  callbacks: {
    onTokenUsage?: (usage: TokenUsage) => void;
    onStreamEnd?: (status: number) => void;
  } = {},
  stream = true
) => {
  const bodyJson = { stream };
  const common = {
    headers: new Headers(),
    accessToken: "fake-access",
    metadata: null,
    bodyJson,
    bodyText: JSON.stringify(bodyJson),
    ...callbacks,
  };
  return provider === "codex"
    ? prepareCodexProxyRequest({ ...common, accountId: null })
    : prepareClaudeProxyRequest({
        ...common,
        requestUrl: new URL("https://fake.test/anthropic/v1/messages"),
      });
};

for (const provider of ["codex", "claude"] as const) {
  test(`${provider} accounts for a JSON reply to a streaming request`, async () => {
    const usages: TokenUsage[] = [];
    const statuses: number[] = [];
    const raw = '{ "usage": { "input_tokens": 8, "output_tokens": 3 } }';
    const response = await prepare(provider, {
      onTokenUsage: (usage) => usages.push(usage),
      onStreamEnd: (status) => statuses.push(status),
    }).transformResponse(
      new Response(raw, { headers: { "content-type": "application/json" } })
    );
    expect(await response.text()).toBe(raw);
    expect(usages).toEqual([
      {
        inputTokens: 8,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
    expect(statuses).toEqual([]);
  });

  test.each([
    {
      name: "completed",
      payload: terminal(provider),
      http: 200,
      expected: 200,
    },
    {
      name: "missing terminal",
      payload: ": ping\r\n\r\n",
      http: 200,
      expected: 502,
    },
    {
      name: "rate limited",
      payload: event({ type: "error", error: { type: "rate_limit_error" } }),
      http: 200,
      expected: 429,
    },
    {
      name: "overloaded",
      payload: event({ type: "error", error: { type: "overloaded_error" } }),
      http: 200,
      expected: 529,
    },
    {
      name: "HTTP failure",
      payload: terminal(provider),
      http: 403,
      expected: 403,
    },
  ])(
    `${provider} records $name once without changing SSE bytes or HTTP status`,
    async ({ payload, http, expected }) => {
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      const statuses: number[] = [];
      try {
        const response = await prepare(provider, {
          onStreamEnd: (status) => statuses.push(status),
        }).transformResponse(
          new Response(payload, {
            status: http,
            headers: { "content-type": "text/event-stream" },
          })
        );
        expect(response.status).toBe(http);
        expect(await response.text()).toBe(payload);
        expect(statuses).toEqual([expected]);
      } finally {
        warn.mockRestore();
      }
    }
  );

  test(`${provider} delivers final usage once before the outcome`, async () => {
    const calls: unknown[] = [];
    const upstream =
      provider === "codex"
        ? event({
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 20,
                output_tokens: 1,
                input_tokens_details: { cached_tokens: 5 },
              },
            },
          }) +
          event({
            type: "response.done",
            response: {
              usage: {
                input_tokens: 20,
                output_tokens: 9,
                input_tokens_details: { cached_tokens: 5 },
              },
            },
          })
        : event({
            type: "message_start",
            message: {
              usage: {
                input_tokens: 15,
                output_tokens: 1,
                cache_read_input_tokens: 5,
              },
            },
          }) +
          event({ type: "message_delta", usage: { output_tokens: 9 } }) +
          terminal(provider);
    const response = await prepare(provider, {
      onTokenUsage: (usage) => calls.push(usage),
      onStreamEnd: (status) => calls.push(status),
    }).transformResponse(
      new Response(upstream, {
        headers: { "content-type": "text/event-stream" },
      })
    );
    await response.text();
    expect(calls).toEqual([
      {
        inputTokens: 15,
        outputTokens: 9,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
      },
      200,
    ]);
  });

  test(`${provider} preserves a large event, split UTF-8, CRLF and EOF bytes`, async () => {
    const payload =
      provider === "codex"
        ? {
            type: "response.output_text.delta",
            delta: `🦀${"x".repeat(2 * 1024 * 1024)}`,
          }
        : {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: `🦀${"x".repeat(2 * 1024 * 1024)}`,
            },
          };
    const bytes = encoder.encode(event(payload) + terminal(provider).trimEnd());
    let offset = 0;
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const source = new Response(
        new ReadableStream<Uint8Array>({
          pull(controller): void {
            if (offset === bytes.length) {
              controller.close();
              return;
            }
            const end =
              offset < 120
                ? offset + 1
                : Math.min(offset + 16 * 1024, bytes.length);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
      const response = await prepare(provider).transformResponse(source);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(source.body?.locked).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test(`${provider} backpressures and cancels an in-flight read exactly once`, async () => {
    let pulls = 0;
    let cancellations = 0;
    const statuses: number[] = [];
    const source = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller): void {
            pulls++;
            if (pulls === 1) controller.enqueue(encoder.encode(": ping\n\n"));
          },
          cancel(reason): void {
            expect(reason).toBe("client cancelled");
            cancellations++;
          },
        },
        { highWaterMark: 0 }
      ),
      { headers: { "content-type": "text/event-stream" } }
    );
    const response = await prepare(provider, {
      onStreamEnd: (status) => statuses.push(status),
    }).transformResponse(source);
    await Bun.sleep(0);
    expect(pulls).toBe(1);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing response body");
    await reader.read();
    const pending = reader.read();
    await Bun.sleep(0);
    await reader.cancel("client cancelled");
    expect(await pending).toMatchObject({ done: true });
    expect(statuses).toEqual([499]);
    expect(cancellations).toBe(1);
    expect(source.body?.locked).toBe(false);
  });

  test(`${provider} fails and logs a broken upstream without leaking content`, async () => {
    const secret = "PRIVATE UPSTREAM RESPONSE";
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    const statuses: number[] = [];
    try {
      const response = await prepare(provider, {
        onStreamEnd: (status) => statuses.push(status),
      }).transformResponse(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller): void {
              controller.error(new Error(secret));
            },
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              "x-request-id": secret,
            },
          }
        )
      );
      await expect(response.text()).rejects.toThrow(secret);
      expect(statuses).toEqual([502]);
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]?.[0]);
      expect(line).not.toContain(secret);
      expect(JSON.parse(line)).toMatchObject({
        provider,
        transport: provider === "codex" ? "sse" : "sse_transform",
        bytes: 0,
        chunks: 0,
        elapsedMs: expect.any(Number),
        idleMs: expect.any(Number),
        downstreamIdleMs: expect.any(Number),
        requestIdHash: expect.stringMatching(/^[a-f0-9]{8}$/),
        errorCategory: "stream_read_failed",
      });
    } finally {
      error.mockRestore();
    }
  });

  test.each(["valid JSON", "malformed JSON", "invalid UTF-8"])(
    `${provider} preserves %s bytes while cleaning decoded-body headers`,
    async (variant) => {
      const raw =
        '{ "usage": { "input_tokens": 1e2, "output_tokens": 2 }, "content": [] }\n';
      const bytes =
        variant === "valid JSON"
          ? encoder.encode(raw)
          : variant === "malformed JSON"
            ? encoder.encode(raw.slice(0, -3))
            : new Uint8Array([0xff, ...encoder.encode(raw), 0xfe]);
      const usages: TokenUsage[] = [];
      const response = await prepare(
        provider,
        { onTokenUsage: (usage) => usages.push(usage) },
        false
      ).transformResponse(
        new Response(bytes, {
          status: 201,
          statusText: "Upstream response",
          headers: {
            "content-type": "application/json",
            "content-encoding": "gzip",
            "content-length": String(bytes.length),
            "request-id": "fake-request",
          },
        })
      );
      expect(response.status).toBe(201);
      expect(response.statusText).toBe("Upstream response");
      expect(response.headers.get("request-id")).toBe("fake-request");
      expect(response.headers.has("content-encoding")).toBe(false);
      expect(response.headers.has("content-length")).toBe(false);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(usages).toEqual(
        variant === "valid JSON"
          ? [
              {
                inputTokens: 100,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            ]
          : []
      );
    }
  );
}

test.each([
  {
    type: "response.failed",
    response: { status: "failed", error: { code: "rate_limit_exceeded" } },
    expected: 429,
  },
  {
    type: "response.done",
    response: { status: "failed", error: { code: "usage_limit_reached" } },
    expected: 429,
  },
  {
    type: "response.incomplete",
    response: {
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
    },
    expected: 502,
  },
  {
    type: "response.done",
    response: {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    },
    expected: 200,
  },
])(
  "Codex classifies $type using its terminal payload",
  async ({ expected, ...payload }) => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const statuses: number[] = [];
    try {
      const response = await prepare("codex", {
        onStreamEnd: (status) => statuses.push(status),
      }).transformResponse(
        new Response(event(payload), {
          headers: { "content-type": "text/event-stream" },
        })
      );
      await response.text();
      expect(statuses).toEqual([expected]);
    } finally {
      warn.mockRestore();
    }
  }
);

test("Claude only parses declared JSON and passes other bytes through", async () => {
  const bytes = encoder.encode('{ "usage": { "input_tokens": 10 } }');
  const usages: TokenUsage[] = [];
  const response = await prepare(
    "claude",
    { onTokenUsage: (usage) => usages.push(usage) },
    false
  ).transformResponse(new Response(bytes));
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  expect(usages).toEqual([]);
  expect(response.headers.has("content-type")).toBe(false);
});

test("keepalives cannot accumulate behind backpressured SSE data", async () => {
  let pulls = 0;
  const frame = (delta: number) =>
    event({ type: "response.output_text.delta", delta: String(delta) });
  const response = createOpenAiSseUsagePassthrough({
    response: new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller): void {
            controller.enqueue(encoder.encode(frame(++pulls)));
          },
        },
        { highWaterMark: 0 }
      ),
      { headers: { "content-type": "text/event-stream" } }
    ),
    keepAliveIntervalMs: 5,
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body");
  try {
    await Bun.sleep(30);
    expect(pulls).toBe(1);
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe(frame(1));
    expect(decoder.decode((await reader.read()).value)).toBe(frame(2));
  } finally {
    await reader.cancel();
  }
});
