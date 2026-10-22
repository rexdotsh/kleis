import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  CLAUDE_SYSTEM_IDENTITY,
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_COMPACTION_ENDPOINT,
  CODEX_RESPONSE_ENDPOINT,
} from "../../src/providers/constants";
import type {
  ClaudeAccountMetadata,
  CodexAccountMetadata,
} from "../../src/providers/metadata";
import type { CodexLiveLimits } from "../../src/providers/account-tracking/live-limits";
import { prepareClaudeProxyRequest } from "../../src/providers/proxies/claude-proxy";
import { prepareCodexProxyRequest } from "../../src/providers/proxies/codex-proxy";
import {
  closeCodexWebSocketSessions,
  setCodexWebSocketConstructorForTests,
  tryProxyCodexWebSocket,
} from "../../src/providers/proxies/codex-websocket";
import { createOpenAiSseUsagePassthrough } from "../../src/providers/proxies/openai-sse-passthrough";
import type { TokenUsage } from "../../src/usage/token-usage";

afterEach(() => {
  closeCodexWebSocketSessions();
  setCodexWebSocketConstructorForTests(null);
});

const createUsageCapture = () => {
  let capturedUsage: TokenUsage | null = null;

  return {
    onTokenUsage(usage: TokenUsage): void {
      capturedUsage = usage;
    },
    read(): TokenUsage | null {
      return capturedUsage;
    },
  };
};

const createSseResponse = (
  events: readonly unknown[],
  contentType = "text/event-stream"
): Response => {
  const payload = events
    .map((event) =>
      typeof event === "string"
        ? `data: ${event}\n\n`
        : `data: ${JSON.stringify(event)}\n\n`
    )
    .join("");
  const encoder = new TextEncoder();
  const responseInit: ResponseInit = {};
  if (contentType) {
    responseInit.headers = {
      "content-type": contentType,
    };
  }

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
    responseInit
  );
};

type MockCodexWebSocketResponse = {
  id: string;
  items?: readonly unknown[];
  terminalType?: "response.completed" | "response.done" | "response.incomplete";
};

type MockWebSocketOptions = {
  headers?: Record<string, string>;
};

const installCodexWebSocketMock = (
  responses: MockCodexWebSocketResponse[],
  sentBodies: unknown[],
  constructorHeaders: Record<string, string>[] = []
): void => {
  class MockWebSocket {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;
    private readonly listeners = new Map<
      string,
      Set<(event: unknown) => void>
    >();

    constructor(_url: string, options?: MockWebSocketOptions) {
      if (options?.headers) {
        constructorHeaders.push(options.headers);
      }
      queueMicrotask(() => this.dispatch("open", {}));
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(
      type: string,
      listener: (event: unknown) => void
    ): void {
      this.listeners.get(type)?.delete(listener);
    }

    send(data: string, callback?: (error?: Error) => void): void {
      sentBodies.push(JSON.parse(data) as unknown);
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected websocket request");
      }

      queueMicrotask(() => {
        callback?.();
        for (const event of [
          { type: "response.created", response: { id: response.id } },
          ...(response.items ?? []).map((item) => ({
            type: "response.output_item.done",
            item,
          })),
          {
            type: response.terminalType ?? "response.completed",
            response: {
              id: response.id,
              usage: {
                input_tokens: 10,
                output_tokens: 2,
                input_tokens_details: { cached_tokens: 3 },
              },
              status:
                response.terminalType === "response.incomplete"
                  ? "incomplete"
                  : "completed",
            },
          },
        ]) {
          this.dispatch("message", { data: JSON.stringify(event) });
        }
      });
    }

    close(): void {
      this.readyState = 3;
    }

    terminate(): void {
      this.readyState = 3;
    }

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  }

  setCodexWebSocketConstructorForTests(MockWebSocket);
};

type ManualCodexWebSocket = {
  dispatch(type: string, event: unknown): void;
  readonly terminated: boolean;
};

const installManualCodexWebSocketMock = (
  sentBodies: unknown[],
  options: { autoOpen?: boolean } = {}
): ManualCodexWebSocket[] => {
  const sockets: ManualCodexWebSocket[] = [];

  class MockWebSocket {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;
    terminated = false;
    private readonly listeners = new Map<
      string,
      Set<(event: unknown) => void>
    >();

    constructor() {
      sockets.push(this);
      if (options.autoOpen ?? true) {
        queueMicrotask(() => this.dispatch("open", {}));
      }
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(
      type: string,
      listener: (event: unknown) => void
    ): void {
      this.listeners.get(type)?.delete(listener);
    }

    send(data: string, callback?: (error?: Error) => void): void {
      sentBodies.push(JSON.parse(data) as unknown);
      callback?.();
    }

    close(): void {
      this.readyState = 3;
    }

    terminate(): void {
      this.terminated = true;
      this.readyState = 3;
    }

    dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  }

  setCodexWebSocketConstructorForTests(MockWebSocket);
  return sockets;
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for websocket mock");
};

describe("proxy contract: codex", () => {
  const codexUsageBody = { model: "gpt-5-codex", input: [] };
  const codexStreamingUsageBody = {
    ...codexUsageBody,
    stream: true,
  };

  const prepareCodexUsageRequest = (
    bodyJson: unknown,
    onTokenUsage?: ((usage: TokenUsage) => void) | null
  ) =>
    prepareCodexProxyRequest({
      headers: new Headers(),
      accessToken: "codex-access",
      accountId: null,
      metadata: null,
      bodyText: JSON.stringify(bodyJson),
      bodyJson,
      onTokenUsage,
    });

  test("applies auth, account-id, and endpoint from metadata", () => {
    const headers = new Headers({
      originator: "custom-client",
      "user-agent": "opencode/1.18.15 ai-sdk/provider-utils/4.0.38",
    });
    const bodyJson = {
      model: "gpt-5-codex",
      instructions: "Keep responses concise",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    };
    const bodyText = JSON.stringify(bodyJson);
    const metadata: CodexAccountMetadata = {
      provider: "codex",
      chatgptAccountId: "acct-meta",
      email: null,
    };

    const result = prepareCodexProxyRequest({
      headers,
      accessToken: "codex-access",
      accountId: "acct-fallback",
      metadata,
      bodyText,
      bodyJson,
    });

    expect(headers.get("authorization")).toBe("Bearer codex-access");
    expect(headers.get(CODEX_ACCOUNT_ID_HEADER)).toBe("acct-meta");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("originator")).toBe("custom-client");
    expect(result.upstreamUrl).toBe(CODEX_RESPONSE_ENDPOINT);
    expect(JSON.parse(result.bodyText)).toEqual({ ...bodyJson, store: false });
  });

  test("uses account id when metadata is absent", () => {
    const headers = new Headers();
    const bodyJson = {
      model: "gpt-5-codex",
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    };

    const result = prepareCodexProxyRequest({
      headers,
      accessToken: "codex-access",
      accountId: "acct-fallback",
      metadata: null,
      bodyText: JSON.stringify(bodyJson),
      bodyJson,
    });

    expect(headers.get(CODEX_ACCOUNT_ID_HEADER)).toBe("acct-fallback");
    expect(result.upstreamUrl).toBe(CODEX_RESPONSE_ENDPOINT);
  });

  test("drops caller account id when stored account ids are blank", () => {
    const headers = new Headers({
      [CODEX_ACCOUNT_ID_HEADER.toLowerCase()]: "caller-account",
    });
    prepareCodexProxyRequest({
      headers,
      accessToken: "codex-access",
      accountId: "   ",
      metadata: {
        provider: "codex",
        chatgptAccountId: " ",
        email: null,
      },
      bodyText: JSON.stringify(codexUsageBody),
      bodyJson: codexUsageBody,
    });

    expect(headers.get(CODEX_ACCOUNT_ID_HEADER)).toBeNull();
  });

  test("promotes OpenCode developer input instead of adding fallback instructions", () => {
    const headers = new Headers();
    const bodyJson = {
      model: "gpt-5.6-sol",
      input: [
        {
          role: "developer",
          content: "Current OpenCode GPT instructions",
        },
        {
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    };

    const result = prepareCodexProxyRequest({
      headers,
      accessToken: "codex-access",
      accountId: "acct-fallback",
      metadata: null,
      bodyText: JSON.stringify(bodyJson),
      bodyJson,
    });

    expect(JSON.parse(result.bodyText)).toEqual({
      model: "gpt-5.6-sol",
      input: [bodyJson.input[1]],
      instructions: "Current OpenCode GPT instructions",
      store: false,
    });
  });

  test("removes output and completion limits the ChatGPT backend rejects", () => {
    const bodyJson = {
      model: "gpt-5-codex",
      instructions: "Keep responses concise",
      max_output_tokens: 4096,
      max_completion_tokens: 4096,
      store: true,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    };

    const result = prepareCodexProxyRequest({
      headers: new Headers(),
      accessToken: "codex-access",
      accountId: null,
      metadata: null,
      bodyText: JSON.stringify(bodyJson),
      bodyJson,
    });

    const transformed = JSON.parse(result.bodyText) as {
      max_output_tokens?: number;
      max_completion_tokens?: number;
      store?: boolean;
    };
    expect(transformed.max_output_tokens).toBeUndefined();
    expect(transformed.max_completion_tokens).toBeUndefined();
    expect(transformed.store).toBe(false);
  });

  test("routes native response compaction without response-only fields", async () => {
    const capture = createUsageCapture();
    const headers = new Headers({
      [CODEX_ACCOUNT_ID_HEADER]: "untrusted-account",
    });
    const bodyJson = {
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "compact this history" }],
      instructions: "Keep the useful context",
      prompt_cache_key: "raw-cache-key",
      stream: true,
      store: true,
      max_output_tokens: 4096,
    };

    const result = prepareCodexProxyRequest({
      operation: "compact",
      headers,
      accessToken: "codex-access",
      accountId: null,
      metadata: null,
      bodyText: JSON.stringify(bodyJson),
      bodyJson,
      promptCacheKey: "kleis_compaction_key",
      onTokenUsage: capture.onTokenUsage,
    });

    expect(result.upstreamUrl).toBe(CODEX_COMPACTION_ENDPOINT);
    expect(headers.get(CODEX_ACCOUNT_ID_HEADER)).toBeNull();
    expect(headers.get("accept")).toBe("application/json");
    expect(JSON.parse(result.bodyText)).toEqual({
      model: bodyJson.model,
      input: bodyJson.input,
      instructions: bodyJson.instructions,
      prompt_cache_key: "kleis_compaction_key",
    });

    await result.transformResponse(
      Response.json({
        object: "response.compaction",
        output: [],
        usage: { input_tokens: 12, output_tokens: 3 },
      })
    );
    expect(capture.read()).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("extracts normalized usage from non-streaming responses", async () => {
    const capture = createUsageCapture();
    const result = prepareCodexUsageRequest(
      codexUsageBody,
      capture.onTokenUsage
    );

    const sourceResponse = Response.json({
      usage: {
        input_tokens: 120,
        output_tokens: 34,
        total_tokens: 154,
        input_tokens_details: {
          cached_tokens: 20,
          cache_write_tokens: 5,
        },
        output_tokens_details: {
          reasoning_tokens: 7,
        },
      },
    });

    await result.transformResponse(sourceResponse);

    expect(capture.read()).toEqual({
      inputTokens: 95,
      outputTokens: 34,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      reasoningTokens: 7,
      totalTokens: 154,
    });
  });

  test("extracts non-streaming usage when content-type is missing", async () => {
    const capture = createUsageCapture();
    const result = prepareCodexUsageRequest(
      codexUsageBody,
      capture.onTokenUsage
    );

    const sourceResponse = new Response(
      new TextEncoder().encode(
        JSON.stringify({
          usage: {
            input_tokens: 60,
            output_tokens: 10,
            total_tokens: null,
            input_tokens_details: {
              cached_tokens: 5,
            },
            output_tokens_details: {
              reasoning_tokens: null,
            },
          },
        })
      )
    );

    await result.transformResponse(sourceResponse);

    expect(capture.read()).toEqual({
      inputTokens: 55,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
    });
  });

  const codexStreamUsageCases = [
    {
      eventType: "response.completed",
      usage: {
        input_tokens: 90,
        output_tokens: 45,
        input_tokens_details: {
          cached_tokens: 30,
        },
      },
      expected: {
        inputTokens: 60,
        outputTokens: 45,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
      },
    },
    {
      eventType: "response.done",
      usage: {
        input_tokens: 72,
        output_tokens: 18,
        input_tokens_details: {
          cached_tokens: 12,
        },
      },
      expected: {
        inputTokens: 60,
        outputTokens: 18,
        cacheReadTokens: 12,
        cacheWriteTokens: 0,
      },
    },
    {
      eventType: "response.failed",
      usage: {
        input_tokens: 22,
        output_tokens: 4,
        input_tokens_details: {
          cached_tokens: 2,
        },
      },
      expected: {
        inputTokens: 20,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
      },
    },
  ] as const;

  for (const testCase of codexStreamUsageCases) {
    test(`extracts usage from streaming ${testCase.eventType} events`, async () => {
      const capture = createUsageCapture();
      const result = prepareCodexUsageRequest(
        codexStreamingUsageBody,
        capture.onTokenUsage
      );

      const transformed = await result.transformResponse(
        createSseResponse([
          {
            type: testCase.eventType,
            response: {
              usage: testCase.usage,
            },
          },
        ])
      );
      const responseText = await transformed.text();

      expect(capture.read()).toEqual(testCase.expected);
      if (testCase.eventType === "response.done") {
        expect(responseText).toContain('"type":"response.completed"');
        expect(responseText).not.toContain('"type":"response.done"');
      }
    });
  }

  test("keeps CRLF event and data lines together when normalizing response.done", async () => {
    const capture = createUsageCapture();
    const result = prepareCodexUsageRequest(
      codexStreamingUsageBody,
      capture.onTokenUsage
    );
    const payload = JSON.stringify({
      type: "response.done",
      response: {
        status: "completed",
        usage: { input_tokens: 20, output_tokens: 3 },
      },
    });
    const transformed = await result.transformResponse(
      new Response(`event: response.done\r\ndata: ${payload}\r\n\r\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    );
    const text = await transformed.text();

    expect(text).toContain("event: response.completed\r\n");
    expect(text).toContain('"type":"response.completed"');
    expect(text).not.toContain("event: response.done");
    expect(capture.read()).toMatchObject({
      inputTokens: 20,
      outputTokens: 3,
    });
  });

  test("normalizes response.done when every read ends inside a CRLF", async () => {
    const payload = JSON.stringify({
      type: "response.done",
      response: { status: "completed" },
    });
    const body = `event: response.done\r\ndata: ${payload}\r\n\r\n`;
    const encoder = new TextEncoder();
    const response = createOpenAiSseUsagePassthrough({
      response: new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            for (const part of body.split(/(?<=\r)/u)) {
              controller.enqueue(encoder.encode(part));
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      ),
      extractUsage: () => null,
    });

    expect(await response.text()).toBe(
      `event: response.completed\r\ndata: ${JSON.stringify({
        ...JSON.parse(payload),
        type: "response.completed",
      })}\r\n\r\n`
    );
  });

  test("retains observed Codex stream usage after downstream cancellation", async () => {
    const capture = createUsageCapture();
    const result = prepareCodexUsageRequest(
      codexStreamingUsageBody,
      capture.onTokenUsage
    );
    const payload = JSON.stringify({
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 35,
          output_tokens: 4,
          input_tokens_details: { cached_tokens: 10 },
        },
      },
    });
    const sourceResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
    const transformed = await result.transformResponse(sourceResponse);
    const reader = transformed.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    await reader?.cancel();

    expect(capture.read()).toEqual({
      inputTokens: 25,
      outputTokens: 4,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
    });
  });

  test("normalizes an unterminated response.done event at EOF", async () => {
    const capture = createUsageCapture();
    const result = prepareCodexUsageRequest(
      codexStreamingUsageBody,
      capture.onTokenUsage
    );
    const upstreamBody = `event: response.done\ndata: ${JSON.stringify({
      type: "response.done",
      response: {
        status: "completed",
        usage: { input_tokens: 14, output_tokens: 6 },
      },
    })}`;

    const transformed = await result.transformResponse(
      new Response(upstreamBody, {
        headers: { "content-type": "text/event-stream" },
      })
    );
    const responseText = await transformed.text();

    expect(responseText).toStartWith("event: response.completed\n");
    expect(responseText).toContain('"type":"response.completed"');
    expect(responseText).not.toContain("response.done");
    expect(capture.read()).toEqual({
      inputTokens: 14,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("does not create a second terminal event from trailing response.done", async () => {
    const upstreamBody = [
      {
        type: "response.completed",
        response: { id: "resp-1", status: "completed" },
      },
      {
        type: "response.done",
        response: { id: "resp-1", status: "completed" },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const response = createOpenAiSseUsagePassthrough({
      response: new Response(upstreamBody, {
        headers: { "content-type": "text/event-stream" },
      }),
      extractUsage: () => null,
    });
    const responseText = await response.text();

    expect(responseText.match(/"type":"response.completed"/gu)).toHaveLength(1);
    expect(responseText.match(/"type":"response.done"/gu)).toHaveLength(1);
  });

  test("extracts usage from streaming responses without content-type", async () => {
    const capture = createUsageCapture();
    const result = prepareCodexUsageRequest(
      codexStreamingUsageBody,
      capture.onTokenUsage
    );

    const transformed = await result.transformResponse(
      createSseResponse(
        [
          {
            type: "response.done",
            response: {
              usage: {
                input_tokens: 81,
                output_tokens: 23,
                input_tokens_details: {
                  cached_tokens: 9,
                },
              },
            },
          },
        ],
        ""
      )
    );
    await transformed.text();

    expect(capture.read()).toEqual({
      inputTokens: 72,
      outputTokens: 23,
      cacheReadTokens: 9,
      cacheWriteTokens: 0,
    });
  });

  test("applies downstream backpressure to OpenAI SSE reads", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const source = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller): void {
            pulls++;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "response.output_text.delta", delta: String(pulls) })}\n\n`
              )
            );
          },
        },
        { highWaterMark: 0 }
      ),
      { headers: { "content-type": "text/event-stream" } }
    );

    const transformed = createOpenAiSseUsagePassthrough({
      response: source,
      extractUsage: () => null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pulls).toBe(1);
    await transformed.body?.cancel();
  });

  test("preserves explicit JSON content type for streaming errors", async () => {
    const body = JSON.stringify({
      error: { message: "bad request", type: "invalid_request_error" },
    });
    const response = createOpenAiSseUsagePassthrough({
      response: new Response(body, {
        status: 400,
        headers: {
          "content-encoding": "gzip",
          "content-length": String(body.length),
          "content-type": "application/json",
        },
      }),
      extractUsage: () => null,
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.headers.has("content-encoding")).toBe(false);
    expect(await response.json()).toEqual({
      error: { message: "bad request", type: "invalid_request_error" },
    });
  });

  test.each([400, 503])(
    "passes headerless HTTP %s bytes through without SSE framing or keepalives",
    async (status) => {
      const body = new Uint8Array([
        0xff,
        ...new TextEncoder().encode('{ "error": { "message": "failed" } }'),
        0xfe,
      ]);
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const response = createOpenAiSseUsagePassthrough({
          response: new Response(
            new ReadableStream<Uint8Array>({
              async start(controller): Promise<void> {
                controller.enqueue(body.slice(0, 4));
                await new Promise((resolve) => setTimeout(resolve, 30));
                controller.enqueue(body.slice(4));
                controller.close();
              },
            }),
            {
              status,
              statusText: "Upstream failure",
              headers: {
                "content-encoding": "gzip",
                "content-length": String(body.length),
                "retry-after": "3",
              },
            }
          ),
          extractUsage: () => null,
          keepAliveIntervalMs: 5,
        });

        expect(response.status).toBe(status);
        expect(response.statusText).toBe("Upstream failure");
        expect(response.headers.has("content-type")).toBe(false);
        expect(response.headers.has("content-encoding")).toBe(false);
        expect(response.headers.has("content-length")).toBe(false);
        expect(response.headers.get("retry-after")).toBe("3");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    }
  );

  test("normalizes and tracks explicitly declared non-2xx SSE", async () => {
    const capture = createUsageCapture();
    const result = prepareCodexUsageRequest(
      codexStreamingUsageBody,
      capture.onTokenUsage
    );
    const body =
      'event: response.done\ndata: {"type":"response.done","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":3}}}\n\n';
    const response = await result.transformResponse(
      new Response(body, {
        status: 503,
        headers: { "content-type": "text/event-stream" },
      })
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toContain('"type":"response.completed"');
    expect(capture.read()).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("injects keepalives only at SSE event boundaries", async () => {
    const encoder = new TextEncoder();
    const createSlowResponse = (
      payload: string,
      contentType: string | null
    ): Response =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller): Promise<void> {
            controller.enqueue(encoder.encode(payload.slice(0, 4)));
            await new Promise((resolve) => setTimeout(resolve, 30));
            controller.enqueue(encoder.encode(payload.slice(4)));
            controller.close();
          },
        }),
        contentType ? { headers: { "content-type": contentType } } : {}
      );

    const jsonBody = JSON.stringify({ error: { message: "slow error" } });
    const jsonResponse = createOpenAiSseUsagePassthrough({
      response: createSlowResponse(jsonBody, "application/json"),
      extractUsage: () => null,
      keepAliveIntervalMs: 5,
    });
    expect(await jsonResponse.text()).toBe(jsonBody);

    const sseBody = 'data: {"type":"response.completed"}\n\n';
    const sseResponse = createOpenAiSseUsagePassthrough({
      response: createSlowResponse(sseBody, null),
      extractUsage: () => null,
      keepAliveIntervalMs: 5,
    });
    const sseText = await sseResponse.text();
    expect(sseText).toContain("response.completed");
    expect(sseText).toContain(": kleis-keepalive\n\n");
    const dataEvents = sseText
      .split("\n\n")
      .filter((event) => event.startsWith("data: "));
    expect(dataEvents).toHaveLength(1);
    expect(JSON.parse(dataEvents[0]?.slice("data: ".length) ?? "")).toEqual({
      type: "response.completed",
    });

    const delayedSseResponse = createOpenAiSseUsagePassthrough({
      response: new Response(
        new ReadableStream<Uint8Array>({
          async start(controller): Promise<void> {
            await new Promise((resolve) => setTimeout(resolve, 30));
            controller.enqueue(encoder.encode(sseBody));
            controller.close();
          },
        })
      ),
      extractUsage: () => null,
      keepAliveIntervalMs: 5,
    });
    const delayedSseText = await delayedSseResponse.text();
    expect(delayedSseText).toContain(": kleis-keepalive\n\n");
    expect(delayedSseText).toEndWith(sseBody);
  });

  test("logs OpenAI terminal failure details", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    try {
      const response = createOpenAiSseUsagePassthrough({
        response: createSseResponse([
          {
            type: "response.failed",
            response: {
              status: "failed",
              error: {
                code: "context_length_exceeded",
                message: "Input exceeded the model context window",
                param: "input",
              },
            },
          },
          { type: "response.future_event", value: true },
        ]),
        extractUsage: () => null,
      });
      await response.text();
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0] ?? "{}")).toMatchObject({
      event: "openai_sse_terminal_anomaly",
      terminalAnomaly: "response.failed",
      responseStatus: "failed",
      errorCode: "context_length_exceeded",
    });
    expect(warnings[0]).not.toContain(
      "Input exceeded the model context window"
    );
  });

  test("logs unexpected OpenAI incomplete reasons", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    try {
      const response = createOpenAiSseUsagePassthrough({
        response: createSseResponse([
          {
            type: "response.incomplete",
            response: {
              status: "incomplete",
              incomplete_details: { reason: "content_filter" },
            },
          },
        ]),
        extractUsage: () => null,
      });
      await response.text();
    } finally {
      console.warn = originalWarn;
    }

    expect(JSON.parse(warnings[0] ?? "{}")).toMatchObject({
      event: "openai_sse_terminal_anomaly",
      terminalAnomaly: "response.incomplete",
      responseStatus: "incomplete",
      incompleteReason: "content_filter",
    });
  });

  test.each(["response.incomplete", "response.failed", "error"])(
    "SSE %s diagnostics allowlist provider metadata and hash request headers",
    async (type) => {
      const secret = "PRIVATESECRETTOKEN";
      const event = {
        type,
        response: {
          status: secret,
          incomplete_details: { reason: secret },
          error: { type: secret, code: secret, message: secret },
        },
        error: { type: secret, code: secret, message: secret },
      };
      const source = createSseResponse([event]);
      source.headers.set("request-id", secret);
      const log = spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const response = createOpenAiSseUsagePassthrough({
          response: source,
          extractUsage: () => null,
        });
        expect(await response.text()).toBe(
          await createSseResponse([event]).text()
        );
        expect(log).toHaveBeenCalledTimes(1);
        const line = String(log.mock.calls[0]?.[0]);
        expect(JSON.parse(line)).toMatchObject({
          event: "openai_sse_terminal_anomaly",
          responseStatus: "other",
          requestIdHash: expect.stringMatching(/^[a-f0-9]{8}$/),
        });
        expect(line).not.toContain(secret);
      } finally {
        log.mockRestore();
      }
    }
  );

  test("logs malformed SSE diagnostics without exposing frame content", async () => {
    const secret = "private prompt text";
    const malformed = `data: {"type":"response.output_text.delta","delta":"${secret}"\n\n`;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    try {
      const response = createOpenAiSseUsagePassthrough({
        response: new Response(malformed, {
          headers: { "content-type": "text/event-stream" },
        }),
        extractUsage: () => null,
      });
      expect(await response.text()).toBe(malformed);
    } finally {
      console.warn = originalWarn;
    }

    expect(JSON.parse(warnings[0] ?? "{}")).toMatchObject({
      event: "openai_sse_invalid_json",
      parseCategory: "invalid_json_or_non_object",
    });
    expect(warnings.join("\n")).not.toContain(secret);
  });

  test("logs upstream overlapping reasoning items without exposing item IDs", async () => {
    const events = [
      {
        type: "response.created",
        sequence_number: 0,
        response: { id: "private-response-1" },
      },
      {
        type: "response.output_item.added",
        sequence_number: 2,
        output_index: 0,
        item: { id: "private-reasoning-1", type: "reasoning" },
      },
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "private-reasoning-1",
        delta: "private reasoning text",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "different-private-id", type: "message" },
      },
      {
        type: "response.created",
        sequence_number: 0,
        response: { id: "private-response-2" },
      },
      {
        type: "response.output_item.added",
        sequence_number: 2,
        output_index: 0,
        item: { id: "private-reasoning-2", type: "reasoning" },
      },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: { id: "private-reasoning-3", type: "reasoning" },
      },
      { type: "response.completed" },
    ];
    const source = createSseResponse(events);
    source.headers.set("x-request-id", "upstream-request-1");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    let output: string;
    try {
      output = await createOpenAiSseUsagePassthrough({
        response: source,
        providerAccountId: "fake-account-1",
        extractUsage: () => null,
      }).text();
    } finally {
      console.warn = originalWarn;
    }

    expect(output).toBe(await createSseResponse(events).text());
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0] ?? "{}")).toMatchObject({
      event: "codex_reasoning_overlap",
      provider: "codex",
      providerAccountId: "fake-account-1",
      requestIdHash: Bun.CryptoHasher.hash(
        "sha256",
        "upstream-request-1",
        "hex"
      ).slice(0, 8),
      history: expect.arrayContaining([
        {
          type: "response.output_item.added",
          sequenceNumber: 2,
          outputIndex: 0,
          itemType: "reasoning",
          itemIdHash: Bun.CryptoHasher.hash(
            "sha256",
            "private-reasoning-2",
            "hex"
          ).slice(0, 8),
          responseIdHash: Bun.CryptoHasher.hash(
            "sha256",
            "private-response-2",
            "hex"
          ).slice(0, 8),
          elapsedMs: expect.any(Number),
        },
      ]),
    });
    expect(warnings[0]).not.toContain("private-reasoning");
    expect(warnings[0]).not.toContain("private reasoning text");
    expect(warnings[0]).not.toContain("private-response");
    expect(warnings[0]).not.toContain("upstream-request-1");
  });

  test("does not flag reasoning items closed by their output item done events", async () => {
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "reasoning-1", type: "reasoning" },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { id: "reasoning-1", type: "reasoning" },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { id: "reasoning-2", type: "reasoning" },
      },
      { type: "response.completed" },
    ];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    try {
      const source = createSseResponse(events);
      expect(
        await createOpenAiSseUsagePassthrough({
          response: source,
          extractUsage: () => null,
        }).text()
      ).toBe(await createSseResponse(events).text());
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toHaveLength(0);
  });

  test("passes unknown valid SSE events without malformed diagnostics", async () => {
    const event =
      'data: {"type":"response.future_event","value":true}\n\ndata: {"type":"response.completed"}\n\n';
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    try {
      const response = createOpenAiSseUsagePassthrough({
        response: new Response(event, {
          headers: { "content-type": "text/event-stream" },
        }),
        extractUsage: () => null,
      });
      expect(await response.text()).toBe(event);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toHaveLength(0);
  });

  test("classifies invalid SSE UTF-8 without logging frame bytes", async () => {
    const encoder = new TextEncoder();
    const prefix = encoder.encode(
      'data: {"type":"response.output_text.delta","delta":"'
    );
    const suffix = encoder.encode('"}\n\n');
    const bytes = new Uint8Array(prefix.length + 2 + suffix.length);
    bytes.set(prefix);
    bytes.set([0xc3, 0x28], prefix.length);
    bytes.set(suffix, prefix.length + 2);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    try {
      const response = createOpenAiSseUsagePassthrough({
        response: new Response(bytes, {
          headers: { "content-type": "text/event-stream" },
        }),
        extractUsage: () => null,
      });
      await response.text();
    } finally {
      console.warn = originalWarn;
    }

    expect(JSON.parse(warnings[0] ?? "{}")).toMatchObject({
      event: "openai_sse_invalid_frame",
      parseCategory: "invalid_utf8",
    });
    expect(warnings.join("\n")).not.toContain("response.output_text.delta");
  });

  test("cancels upstream when an SSE event exceeds the buffer limit", async () => {
    let cancelled = false;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    try {
      const source = new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(
              new TextEncoder().encode(`data: ${"x".repeat(4 * 1024 * 1024)}`)
            );
          },
          cancel(): void {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
      const response = createOpenAiSseUsagePassthrough({
        response: source,
        extractUsage: () => null,
      });

      await expect(response.text()).rejects.toThrow("buffer limit");
      await waitFor(() => cancelled);
    } finally {
      console.warn = originalWarn;
    }

    expect(cancelled).toBe(true);
    expect(warnings.join("\n")).not.toContain("xxxx");
  });

  test("routes compaction turns over HTTP instead of WebSocket", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "compaction-session",
    });

    const response = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5.5",
        stream: true,
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "compaction",
          }),
        },
        input: [{ role: "user", content: "compact" }],
      },
      accountKey: "key-1:account-1",
    });

    expect(response).toBeNull();
    expect(sockets).toHaveLength(0);
    expect(sentBodies).toHaveLength(0);
  });

  test("terminates websocket when the downstream request aborts", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const abortController = new AbortController();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };

    try {
      const responsePromise = tryProxyCodexWebSocket({
        headers: new Headers({
          authorization: "Bearer codex-access",
          [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
          "x-session-affinity": "abort-session",
        }),
        bodyJson: {
          model: "gpt-5.5",
          stream: true,
          input: [{ role: "user", content: "hello" }],
        },
        accountKey: "key-1:account-1",
        signal: abortController.signal,
      });
      await waitFor(() => sentBodies.length === 1);
      abortController.abort(new Error("stop"));
      expect(await responsePromise).toBeNull();
    } finally {
      console.warn = originalWarn;
    }

    expect(sockets[0]?.terminated).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  test("websocket reasoning diagnostics observe upstream events without rewriting them", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    const events = [
      {
        type: "response.output_item.added",
        item: { id: "private-item-1", type: "reasoning" },
      },
      { type: "response.created", response: { id: "private-response" } },
      {
        type: "response.output_item.added",
        sequence_number: 2,
        output_index: 0,
        item: { id: "private-item-2", type: "reasoning" },
      },
      { type: "response.completed", response: { status: "completed" } },
    ];
    try {
      const pending = tryProxyCodexWebSocket({
        headers: new Headers(),
        bodyJson: { model: "gpt-fake", stream: true },
        accountKey: "fake-key:fake-account",
        providerAccountId: "fake-account",
      });
      await waitFor(() => sentBodies.length === 1);
      for (const event of events) {
        sockets[0]?.dispatch("message", { data: JSON.stringify(event) });
      }
      const response = await pending;
      expect(await response?.text()).toBe(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
      );
      expect(warnings).toHaveLength(1);
      expect(JSON.parse(warnings[0] ?? "{}")).toMatchObject({
        event: "codex_reasoning_overlap",
        providerAccountId: "fake-account",
        transport: "websocket",
        history: expect.any(Array),
      });
      expect(warnings[0]).not.toContain("private");
    } finally {
      console.warn = originalWarn;
    }
  });

  test.each([false, true])(
    "websocket close diagnostics redact response IDs in messages and stacks (after output=%s)",
    async (afterOutput) => {
      const sentBodies: unknown[] = [];
      const sockets = installManualCodexWebSocketMock(sentBodies);
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      const error = spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const pending = tryProxyCodexWebSocket({
          headers: new Headers(),
          bodyJson: { model: "gpt-fake", stream: true },
          accountKey: "fake-account",
        });
        await waitFor(() => sentBodies.length === 1);
        let response: Response | null = null;
        if (afterOutput) {
          sockets[0]?.dispatch("message", {
            data: JSON.stringify({
              type: "response.created",
              response: { id: "resp_PRIVATE_RESPONSE_ID" },
            }),
          });
          response = await pending;
          expect(response).not.toBeNull();
        }
        const reason = "Invalid previous_response_id: resp_PRIVATE_RESPONSE_ID";
        sockets[0]?.dispatch("close", { code: 1008, reason });
        if (afterOutput) {
          await expect(response?.text()).rejects.toThrow(
            "invalid_previous_response_id"
          );
        } else {
          expect(await pending).toBeNull();
        }
        const calls = afterOutput ? error.mock.calls : warn.mock.calls;
        expect(calls).toHaveLength(1);
        const line = String(calls[0]?.[0]);
        expect(JSON.parse(line)).toMatchObject({
          event: "codex_websocket_stream_failed",
          stage: "socket_closed_before_terminal",
          webSocketCloseCode: 1008,
          closeReason: "invalid_previous_response_id",
          closeReasonBytes: Buffer.byteLength(reason),
          errorMessage: expect.stringContaining("invalid_previous_response_id"),
          errorStack: expect.stringContaining("WebSocketCloseError"),
        });
        expect(line).not.toContain("PRIVATE_RESPONSE_ID");
        expect(sockets[0]?.terminated).toBe(true);
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    }
  );

  test("websocket error diagnostics do not copy nested provider messages or stacks", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const log = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const pending = tryProxyCodexWebSocket({
        headers: new Headers(),
        bodyJson: { model: "gpt-fake", stream: true },
        accountKey: "fake-account",
      });
      await waitFor(() => sentBodies.length === 1);
      sockets[0]?.dispatch("error", { error: new Error("PRIVATESECRETTOKEN") });
      expect(await pending).toBeNull();
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toMatchObject({
        event: "codex_websocket_stream_failed",
        stage: "socket_error",
        errorName: "WebSocketError",
        errorStack: expect.stringContaining(
          "WebSocket error (other, 18 bytes)"
        ),
      });
      expect(line).not.toContain("PRIVATESECRETTOKEN");
    } finally {
      log.mockRestore();
    }
  });

  test.each(["response.incomplete", "response.failed"])(
    "websocket %s diagnostics allowlist statuses without rewriting provider data",
    async (type) => {
      const sentBodies: unknown[] = [];
      const sockets = installManualCodexWebSocketMock(sentBodies);
      const log = spyOn(console, "warn").mockImplementation(() => undefined);
      const event = {
        type,
        response: {
          status: "PRIVATESECRETTOKEN",
          error: {
            type: "PRIVATESECRETTOKEN",
            code: "PRIVATESECRETTOKEN",
            message: "PRIVATESECRETTOKEN",
          },
        },
      };
      try {
        const pending = tryProxyCodexWebSocket({
          headers: new Headers(),
          bodyJson: { model: "gpt-fake", stream: true },
          accountKey: "fake-account",
        });
        await waitFor(() => sentBodies.length === 1);
        const created = {
          type: "response.created",
          response: { id: "resp_PRIVATE_RESPONSE_ID" },
        };
        let response: Response | null;
        if (type === "response.failed") {
          sockets[0]?.dispatch("message", { data: JSON.stringify(created) });
          response = await pending;
          sockets[0]?.dispatch("message", { data: JSON.stringify(event) });
        } else {
          sockets[0]?.dispatch("message", { data: JSON.stringify(event) });
          response = await pending;
        }
        const events = type === "response.failed" ? [created, event] : [event];
        expect(await response?.text()).toBe(
          `${events.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("")}data: [DONE]\n\n`
        );
        expect(log).toHaveBeenCalledTimes(1);
        const line = String(log.mock.calls[0]?.[0]);
        expect(JSON.parse(line)).toMatchObject({ responseStatus: "other" });
        expect(line).not.toContain("PRIVATESECRETTOKEN");
      } finally {
        log.mockRestore();
      }
    }
  );

  test("falls back when the websocket relay frame bound is exceeded", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    try {
      const sentBodies: unknown[] = [];
      const sockets = installManualCodexWebSocketMock(sentBodies);
      const responsePromise = tryProxyCodexWebSocket({
        headers: new Headers({ authorization: "Bearer codex-access" }),
        bodyJson: {
          model: "gpt-5.6-sol",
          stream: true,
          input: [{ role: "user", content: "hello" }],
        },
        accountKey: "key-1:queue-account",
      });
      await waitFor(() => sockets.length === 1 && sentBodies.length === 1);

      for (let index = 0; index < 8193; index++) {
        sockets[0]?.dispatch("message", {
          data: JSON.stringify({ type: "response.output_text.delta", index }),
        });
      }

      expect(await responsePromise).toBeNull();
      expect(sockets[0]?.terminated).toBe(true);
      expect(
        warnings.some((warning) => {
          const fields = JSON.parse(warning) as Record<string, unknown>;
          return (
            fields.event === "codex_websocket_stream_failed" &&
            fields.reason === "frames"
          );
        })
      ).toBe(true);
      expect(warnings).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("falls back when one websocket frame exceeds the byte bound", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    try {
      const sentBodies: unknown[] = [];
      const sockets = installManualCodexWebSocketMock(sentBodies);
      const responsePromise = tryProxyCodexWebSocket({
        headers: new Headers({ authorization: "Bearer codex-access" }),
        bodyJson: {
          model: "gpt-5.6-sol",
          stream: true,
          input: [{ role: "user", content: "hello" }],
        },
        accountKey: "key-1:large-frame-account",
      });
      await waitFor(() => sockets.length === 1 && sentBodies.length === 1);

      sockets[0]?.dispatch("message", {
        data: "x".repeat(4 * 1024 * 1024 + 1),
      });

      expect(await responsePromise).toBeNull();
      expect(sockets[0]?.terminated).toBe(true);
      expect(warnings.join("\n")).not.toContain("xxxxxxxx");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("fails the stream when the websocket queue overflows after output", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    try {
      const sentBodies: unknown[] = [];
      const sockets = installManualCodexWebSocketMock(sentBodies);
      const responsePromise = tryProxyCodexWebSocket({
        headers: new Headers({ authorization: "Bearer codex-access" }),
        bodyJson: {
          model: "gpt-5.6-sol",
          stream: true,
          input: [{ role: "user", content: "hello" }],
        },
        accountKey: "key-1:stream-overflow-account",
      });
      await waitFor(() => sockets.length === 1 && sentBodies.length === 1);
      sockets[0]?.dispatch("message", {
        data: JSON.stringify({
          type: "response.created",
          response: { id: "resp-overflow" },
        }),
      });
      const response = await responsePromise;
      expect(response).not.toBeNull();

      for (let index = 0; index < 8193; index++) {
        sockets[0]?.dispatch("message", {
          data: JSON.stringify({
            type: "response.output_text.delta",
            delta: String(index),
          }),
        });
      }

      await expect(response?.text()).rejects.toThrow("queue overflow");
      expect(sockets[0]?.terminated).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("normalizes websocket response.done terminal events", async () => {
    const sentBodies: unknown[] = [];
    installCodexWebSocketMock(
      [{ id: "resp_done", terminalType: "response.done" }],
      sentBodies
    );

    const response = await tryProxyCodexWebSocket({
      headers: new Headers({ authorization: "Bearer codex-access" }),
      bodyJson: {
        model: "gpt-5.6-sol",
        stream: true,
        input: [{ role: "user", content: "hello" }],
      },
      accountKey: "key-1:done-account",
    });
    const responseText = await response?.text();

    expect(responseText).toContain('"type":"response.completed"');
    expect(responseText).not.toContain('"type":"response.done"');
    expect(responseText).toEndWith("data: [DONE]\n\n");
  });

  test("drops websocket events after the first terminal", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const responsePromise = tryProxyCodexWebSocket({
      headers: new Headers({ authorization: "Bearer codex-access" }),
      bodyJson: {
        model: "gpt-5.6-sol",
        stream: true,
        input: [{ role: "user", content: "hello" }],
      },
      accountKey: "key-1:duplicate-terminal-account",
    });
    await waitFor(() => sockets.length === 1 && sentBodies.length === 1);
    sockets[0]?.dispatch("message", {
      data: JSON.stringify({
        type: "response.created",
        response: { id: "resp-duplicate" },
      }),
    });
    const response = await responsePromise;
    sockets[0]?.dispatch("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp-duplicate", status: "completed" },
      }),
    });
    sockets[0]?.dispatch("message", {
      data: JSON.stringify({
        type: "response.done",
        response: { id: "resp-duplicate", status: "completed" },
      }),
    });
    const responseText = await response?.text();

    expect(responseText?.match(/"type":"response.completed"/gu)).toHaveLength(
      1
    );
    expect(responseText).not.toContain('"type":"response.done"');
    expect(responseText?.match(/data: \[DONE\]/gu)).toHaveLength(1);
  });

  test("websocket handshake keeps client request, thread, user-agent and beta headers", async () => {
    const constructorHeaders: Record<string, string>[] = [];
    installCodexWebSocketMock([{ id: "resp_1" }], [], constructorHeaders);
    const response = await tryProxyCodexWebSocket({
      headers: new Headers({
        "x-client-request-id": "fake-request",
        "thread-id": "fake-thread",
        "user-agent": "fake-client/1.2.3",
        "OpenAI-Beta": "fake_beta=1",
      }),
      bodyJson: { model: "gpt-5-codex", stream: true, input: [] },
      accountKey: "key-1:account-1",
    });
    await response?.text();

    expect(
      Object.fromEntries(new Headers(constructorHeaders[0]))
    ).toMatchObject({
      "x-client-request-id": "fake-request",
      "thread-id": "fake-thread",
      "user-agent": "fake-client/1.2.3",
      "openai-beta": "fake_beta=1,responses_websockets=2026-02-06",
    });
  });

  test("uses websocket cached delta transport for streaming requests", async () => {
    const firstAssistantItem = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello" }],
    };
    const firstReasoningItem = {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "encrypted",
    };
    const firstAssistantInput = {
      role: "assistant",
      content: [{ type: "output_text", text: "Hello" }],
    };
    const secondAssistantItem = {
      type: "message",
      id: "msg_2",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done" }],
    };
    const responses = [
      { id: "resp_1", items: [firstReasoningItem, firstAssistantItem] },
      { id: "resp_2", items: [secondAssistantItem] },
    ];
    const sentBodies: unknown[] = [];
    const constructorHeaders: Record<string, string>[] = [];
    installCodexWebSocketMock(responses, sentBodies, constructorHeaders);
    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "content-length": "123",
      "session-id": "raw-session-id",
      "x-session-affinity": "session-1",
    });
    const firstInput = [
      { role: "user", content: [{ type: "input_text", text: "Say hello" }] },
    ];
    const capture = createUsageCapture();

    const first = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        store: false,
        input: firstInput,
      },
      accountKey: "key-1:account-1",
      onTokenUsage: capture.onTokenUsage,
    });
    expect(first).not.toBeNull();
    expect(first?.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(first?.headers.get("x-accel-buffering")).toBe("no");
    expect(first?.headers.get("content-length")).toBeNull();
    await first?.text();

    const second = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        store: false,
        input: [
          ...firstInput,
          {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            encrypted_content: "encrypted",
          },
          firstAssistantInput,
          { role: "user", content: [{ type: "input_text", text: "Finish" }] },
        ],
      },
      accountKey: "key-1:account-1",
      onTokenUsage: capture.onTokenUsage,
    });
    expect(second).not.toBeNull();
    await second?.text();

    const firstBody = sentBodies[0] as {
      input?: unknown[];
      previous_response_id?: string;
      stream?: boolean;
      type?: string;
    };
    const secondBody = sentBodies[1] as {
      input?: unknown[];
      previous_response_id?: string;
      stream?: boolean;
      type?: string;
    };
    expect(firstBody.type).toBe("response.create");
    expect(firstBody.stream).toBeUndefined();
    expect(firstBody.previous_response_id).toBeUndefined();
    expect(firstBody.input).toEqual(firstInput);
    expect(firstBody).not.toHaveProperty("prompt_cache_key");
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Finish" }] },
    ]);
    expect(capture.read()).toEqual({
      inputTokens: 7,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    });

    const lowerHeaderEntries = Object.fromEntries(
      Object.entries(constructorHeaders[0] ?? {}).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ])
    );
    expect(lowerHeaderEntries.authorization).toBe("Bearer codex-access");
    expect(lowerHeaderEntries["content-length"]).toBeUndefined();
    expect(lowerHeaderEntries.session_id).toBeUndefined();
    expect(lowerHeaderEntries["session-id"]).toMatch(/^kleis_/);
    expect(lowerHeaderEntries["x-session-affinity"]).toBe(
      lowerHeaderEntries["session-id"]
    );
    expect(lowerHeaderEntries["x-session-id"]).toBe(
      lowerHeaderEntries["session-id"]
    );
    expect(lowerHeaderEntries["x-client-request-id"]).toBeUndefined();
  });

  test("uses cached delta for raw response item replay", async () => {
    const firstInput = [
      { role: "user", content: [{ type: "input_text", text: "Say hello" }] },
    ];
    const firstAssistantItem = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Hello" }],
    };
    const sentBodies: unknown[] = [];
    installCodexWebSocketMock(
      [
        { id: "resp_1", items: [firstAssistantItem] },
        { id: "resp_2", items: [] },
      ],
      sentBodies
    );

    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "raw-session",
    });
    const first = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        store: false,
        input: firstInput,
      },
      accountKey: "key-1:account-1",
    });
    await first?.text();

    const secondInput = [
      ...firstInput,
      firstAssistantItem,
      { role: "user", content: [{ type: "input_text", text: "Finish" }] },
    ];
    const second = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        store: false,
        input: secondInput,
      },
      accountKey: "key-1:account-1",
    });
    await second?.text();

    const secondBody = sentBodies[1] as {
      input?: unknown[];
      previous_response_id?: string;
    };
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Finish" }] },
    ]);
  });

  test("uses cached delta for normalized assistant message content", async () => {
    const firstInput = [
      { role: "user", content: [{ type: "input_text", text: "Say hello" }] },
    ];
    const firstAssistantItem = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Hello",
          annotations: [{ type: "url_citation", url: "https://example.com" }],
        },
      ],
    };
    const sentBodies: unknown[] = [];
    installCodexWebSocketMock(
      [
        { id: "resp_1", items: [firstAssistantItem] },
        { id: "resp_2", items: [] },
      ],
      sentBodies
    );

    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "normalized-message-session",
    });
    const first = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: firstInput,
      },
      accountKey: "key-1:account-1",
    });
    await first?.text();

    const second = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: [
          ...firstInput,
          {
            role: "assistant",
            content: [{ type: "output_text", text: "Hello" }],
          },
          { role: "user", content: [{ type: "input_text", text: "Finish" }] },
        ],
      },
      accountKey: "key-1:account-1",
    });
    await second?.text();

    const secondBody = sentBodies[1] as {
      input?: unknown[];
      previous_response_id?: string;
    };
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "Finish" }] },
    ]);
  });

  test("uses cached delta for lowered reasoning references and function calls", async () => {
    const firstInput = [
      { role: "user", content: [{ type: "input_text", text: "Call tool" }] },
    ];
    const reasoningItem = {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "encrypted",
    };
    const functionCallItem = {
      type: "function_call",
      id: "fc_item_1",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"README.md"}',
    };
    const toolOutput = {
      type: "function_call_output",
      call_id: "call_1",
      output: "done",
    };
    const sentBodies: unknown[] = [];
    installCodexWebSocketMock(
      [
        { id: "resp_1", items: [reasoningItem, functionCallItem] },
        { id: "resp_2", items: [] },
      ],
      sentBodies
    );

    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "tool-session",
    });
    const first = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: firstInput,
      },
      accountKey: "key-1:account-1",
    });
    await first?.text();

    const second = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: [
          ...firstInput,
          { type: "item_reference", id: "rs_1" },
          {
            type: "function_call",
            call_id: "call_1",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
          toolOutput,
        ],
      },
      accountKey: "key-1:account-1",
    });
    await second?.text();

    const secondBody = sentBodies[1] as {
      input?: unknown[];
      previous_response_id?: string;
    };
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.input).toEqual([toolOutput]);
  });

  test("uses cached delta for encrypted reasoning without replayed id", async () => {
    const firstInput = [
      { role: "user", content: [{ type: "input_text", text: "Think" }] },
    ];
    const reasoningItem = {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Checked files" }],
      encrypted_content: "encrypted",
    };
    const functionCallItem = {
      type: "function_call",
      id: "fc_item_1",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"README.md"}',
    };
    const sentBodies: unknown[] = [];
    installCodexWebSocketMock(
      [
        { id: "resp_1", items: [reasoningItem, functionCallItem] },
        { id: "resp_2", items: [] },
      ],
      sentBodies
    );

    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "reasoning-without-id-session",
    });
    const first = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: firstInput,
      },
      accountKey: "key-1:account-1",
    });
    await first?.text();

    const second = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: [
          ...firstInput,
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Checked files" }],
            encrypted_content: "encrypted",
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "read_file",
            arguments: '{"path":"README.md"}',
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "done",
          },
        ],
      },
      accountKey: "key-1:account-1",
    });
    await second?.text();

    const secondBody = sentBodies[1] as {
      input?: unknown[];
      previous_response_id?: string;
    };
    expect(secondBody.previous_response_id).toBe("resp_1");
    expect(secondBody.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "done",
      },
    ]);
  });

  test("falls back for id-less reasoning without encrypted content", async () => {
    const firstInput = [
      { role: "user", content: [{ type: "input_text", text: "Think" }] },
    ];
    const reasoningItem = {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Checked files" }],
    };
    const secondInput = [
      ...firstInput,
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Checked files" }],
      },
      { role: "user", content: [{ type: "input_text", text: "Continue" }] },
    ];
    const sentBodies: unknown[] = [];
    installCodexWebSocketMock(
      [
        { id: "resp_1", items: [reasoningItem] },
        { id: "resp_2", items: [] },
      ],
      sentBodies
    );

    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "unsafe-reasoning-session",
    });
    const first = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: firstInput,
      },
      accountKey: "key-1:account-1",
    });
    await first?.text();

    const second = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: secondInput,
      },
      accountKey: "key-1:account-1",
    });
    await second?.text();

    const secondBody = sentBodies[1] as {
      input?: unknown[];
      previous_response_id?: string;
    };
    expect(secondBody.previous_response_id).toBeUndefined();
    expect(secondBody.input).toEqual(secondInput);
  });

  test("does not store websocket continuation for incomplete responses", async () => {
    const firstInput = [
      { role: "user", content: [{ type: "input_text", text: "Start" }] },
    ];
    const firstAssistantItem = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      content: [{ type: "output_text", text: "Partial" }],
    };
    const secondInput = [
      ...firstInput,
      firstAssistantItem,
      { role: "user", content: [{ type: "input_text", text: "Continue" }] },
    ];
    const sentBodies: unknown[] = [];
    installCodexWebSocketMock(
      [
        {
          id: "resp_1",
          items: [firstAssistantItem],
          terminalType: "response.incomplete",
        },
        { id: "resp_2", items: [] },
      ],
      sentBodies
    );

    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "incomplete-session",
    });
    const first = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: firstInput,
      },
      accountKey: "key-1:account-1",
    });
    await first?.text();

    const second = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: secondInput,
      },
      accountKey: "key-1:account-1",
    });
    await second?.text();

    const secondBody = sentBodies[1] as {
      input?: unknown[];
      previous_response_id?: string;
    };
    expect(secondBody.previous_response_id).toBeUndefined();
    expect(secondBody.input).toEqual(secondInput);
  });

  test("falls back for unmatched hosted tool response items", async () => {
    const firstInput = [
      { role: "user", content: [{ type: "input_text", text: "Search" }] },
    ];
    const hostedToolItem = {
      type: "web_search_call",
      id: "ws_1",
      status: "completed",
      action: { query: "example" },
    };
    const secondInput = [
      ...firstInput,
      {
        type: "function_call",
        call_id: "ws_1",
        name: "web_search",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "ws_1",
        output: "{}",
      },
      { role: "user", content: [{ type: "input_text", text: "Continue" }] },
    ];
    const sentBodies: unknown[] = [];
    installCodexWebSocketMock(
      [
        { id: "resp_1", items: [hostedToolItem] },
        { id: "resp_2", items: [] },
      ],
      sentBodies
    );

    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "hosted-session",
    });
    const first = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: firstInput,
      },
      accountKey: "key-1:account-1",
    });
    await first?.text();

    const second = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: secondInput,
      },
      accountKey: "key-1:account-1",
    });
    await second?.text();

    const secondBody = sentBodies[1] as {
      input?: unknown[];
      previous_response_id?: string;
    };
    expect(secondBody.previous_response_id).toBeUndefined();
    expect(secondBody.input).toEqual(secondInput);
  });

  test("invalidates websocket continuation after same-session busy fallback", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "busy-session",
    });
    const firstInput = [
      { role: "user", content: [{ type: "input_text", text: "Start" }] },
    ];
    const assistantItem = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      content: [{ type: "output_text", text: "Started" }],
    };
    const thirdInput = [
      ...firstInput,
      assistantItem,
      { role: "user", content: [{ type: "input_text", text: "Continue" }] },
    ];

    const firstPromise = tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: firstInput,
      },
      accountKey: "key-1:account-1",
    });
    await waitFor(() => sentBodies.length === 1);

    const busyFallback = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: firstInput,
      },
      accountKey: "key-1:account-1",
    });
    expect(busyFallback).toBeNull();

    expect(sockets[0]).toBeDefined();
    const socket = sockets[0];
    if (!socket) {
      throw new Error("Missing websocket mock");
    }
    socket.dispatch("message", {
      data: JSON.stringify({
        type: "response.created",
        response: { id: "resp_1", status: "completed" },
      }),
    });
    socket.dispatch("message", {
      data: JSON.stringify({
        type: "response.output_item.done",
        item: assistantItem,
      }),
    });
    socket.dispatch("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_1", status: "completed" },
      }),
    });
    const first = await firstPromise;
    await first?.text();

    const thirdPromise = tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: thirdInput,
      },
      accountKey: "key-1:account-1",
    });
    await waitFor(() => sentBodies.length === 2);
    socket.dispatch("message", {
      data: JSON.stringify({
        type: "response.created",
        response: { id: "resp_3", status: "completed" },
      }),
    });
    socket.dispatch("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_3", status: "completed" },
      }),
    });
    const third = await thirdPromise;
    await third?.text();

    const thirdBody = sentBodies[1] as {
      input?: unknown[];
      previous_response_id?: string;
    };
    expect(thirdBody.previous_response_id).toBeUndefined();
    expect(thirdBody.input).toEqual(thirdInput);
  });

  test("retries websocket connection limit errors before streaming output", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "retry-session",
    });

    const responsePromise = tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "Retry" }] },
        ],
      },
      accountKey: "key-1:account-1",
    });

    await waitFor(() => sentBodies.length === 1);
    sockets[0]?.dispatch("message", {
      data: JSON.stringify({
        type: "error",
        error: { code: "websocket_connection_limit_reached" },
      }),
    });

    await waitFor(() => sentBodies.length === 2 && sockets.length === 2);
    sockets[1]?.dispatch("message", {
      data: JSON.stringify({
        type: "response.created",
        response: { id: "resp_1" },
      }),
    });
    sockets[1]?.dispatch("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_1",
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            input_tokens_details: { cached_tokens: 3 },
          },
          status: "completed",
        },
      }),
    });

    const response = await responsePromise;
    expect(response).not.toBeNull();
    const text = await response?.text();
    expect(text).toContain("response.completed");
    expect(sentBodies).toHaveLength(2);
  });

  test("survives a socket close racing a connection limit retry", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "retry-close-race",
    });
    const bodyJson = {
      model: "gpt-5-codex",
      stream: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: "Race" }] },
      ],
    };

    const responsePromise = tryProxyCodexWebSocket({
      headers,
      bodyJson,
      accountKey: "key-1:account-1",
    });
    await waitFor(() => sentBodies.length === 1);

    // The upstream sends the connection limit error and immediately closes
    // the socket; both events are already queued before the retry can
    // detach its listeners.
    sockets[0]?.dispatch("message", {
      data: JSON.stringify({
        type: "error",
        error: { code: "websocket_connection_limit_reached" },
      }),
    });
    sockets[0]?.dispatch("close", { code: 1006, reason: "Connection ended" });

    await waitFor(() => sentBodies.length === 2 && sockets.length === 2);
    sockets[1]?.dispatch("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_race", status: "completed" },
      }),
    });

    const response = await responsePromise;
    expect(response).not.toBeNull();
    expect(await response?.text()).toContain("response.completed");

    // The stale close must not have marked the session for HTTP fallback.
    const followUpPromise = tryProxyCodexWebSocket({
      headers,
      bodyJson,
      accountKey: "key-1:account-1",
    });
    await waitFor(() => sentBodies.length === 3);
    sockets.at(-1)?.dispatch("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_follow", status: "completed" },
      }),
    });
    expect(await followUpPromise).not.toBeNull();
  });

  test("preserves websocket rate limit status_code errors", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
    });

    const responsePromise = tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "Limit" }] },
        ],
      },
      accountKey: "key-1:account-1",
    });

    await waitFor(() => sentBodies.length === 1);
    const event = {
      type: "error",
      status_code: 429,
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
      },
    };
    sockets[0]?.dispatch("message", { data: JSON.stringify(event) });

    const response = await responsePromise;
    expect(response).not.toBeNull();
    expect(response?.status).toBe(429);
    expect(await response?.json()).toEqual(event);
  });

  test("maps websocket usage limit errors without status to 429", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
    });

    const responsePromise = tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "Limit" }] },
        ],
      },
      accountKey: "key-1:account-1",
    });

    await waitFor(() => sentBodies.length === 1);
    const event = {
      type: "error",
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached",
      },
    };
    sockets[0]?.dispatch("message", { data: JSON.stringify(event) });

    const response = await responsePromise;
    expect(response).not.toBeNull();
    expect(response?.status).toBe(429);
    expect(await response?.json()).toEqual(event);
  });

  test("decodes binary websocket messages", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
    });
    const encoder = new TextEncoder();

    const responsePromise = tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "Binary" }] },
        ],
      },
      accountKey: "key-1:account-1",
    });

    await waitFor(() => sentBodies.length === 1);
    for (const event of [
      { type: "response.created", response: { id: "resp_1" } },
      {
        type: "response.completed",
        response: { id: "resp_1", status: "completed" },
      },
    ]) {
      sockets[0]?.dispatch("message", {
        data: encoder.encode(JSON.stringify(event)).buffer,
      });
    }

    const response = await responsePromise;
    expect(response).not.toBeNull();
    const text = await response?.text();
    expect(text).toContain("response.completed");
    expect(text).toContain("data: [DONE]");
  });

  test("preserves websocket message order for async binary messages", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
    });
    const encoder = new TextEncoder();
    let resolveBuffer: ((buffer: ArrayBuffer) => void) | null = null;
    const delayedBuffer = new Promise<ArrayBuffer>((resolve) => {
      resolveBuffer = resolve;
    });

    const responsePromise = tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: [
          { role: "user", content: [{ type: "input_text", text: "Order" }] },
        ],
      },
      accountKey: "key-1:account-1",
    });

    await waitFor(() => sentBodies.length === 1);
    sockets[0]?.dispatch("message", {
      data: { arrayBuffer: () => delayedBuffer },
    });
    sockets[0]?.dispatch("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_1", status: "completed" },
      }),
    });
    sockets[0]?.dispatch("close", { code: 1000 });

    let response: Response | null | undefined;
    const observedResponse = responsePromise.then((value) => {
      response = value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(response).toBeUndefined();

    const createdBytes = encoder.encode(
      JSON.stringify({ type: "response.created", response: { id: "resp_1" } })
    );
    resolveBuffer?.(
      createdBytes.buffer.slice(
        createdBytes.byteOffset,
        createdBytes.byteOffset + createdBytes.byteLength
      )
    );
    await observedResponse;
    if (!response) {
      throw new Error("Expected websocket response");
    }
    const text = await response.text();
    expect(text.indexOf("response.created")).toBeLessThan(
      text.indexOf("response.completed")
    );
  });

  test("keeps retrying websocket setup failures before session fallback", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies, {
      autoOpen: false,
    });
    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "retry-budget-session",
    });
    const bodyJson = {
      model: "gpt-5-codex",
      stream: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: "Retry" }] },
      ],
    };

    for (let attempt = 0; attempt < 6; attempt++) {
      const responsePromise = tryProxyCodexWebSocket({
        headers,
        bodyJson,
        accountKey: "key-1:account-1",
      });
      await waitFor(() => sockets.length === attempt + 1);
      sockets[attempt]?.dispatch("close", { code: 1006 });
      expect(await responsePromise).toBeNull();
    }

    const fallback = await tryProxyCodexWebSocket({
      headers,
      bodyJson,
      accountKey: "key-1:account-1",
    });
    expect(fallback).toBeNull();
    expect(sockets).toHaveLength(6);
  });

  test("isolates close-before-terminal fallback to one session", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "failed-session",
    });
    const bodyJson = {
      model: "gpt-5.5",
      stream: true,
      input: [{ role: "user", content: "hello" }],
    };

    const failedResponsePromise = tryProxyCodexWebSocket({
      headers,
      bodyJson,
      accountKey: "key-1:account-1",
    });
    await waitFor(() => sentBodies.length === 1);
    sockets[0]?.dispatch("message", {
      data: JSON.stringify({
        type: "response.created",
        response: { id: "resp_failed" },
      }),
    });
    const failedResponse = await failedResponsePromise;
    const failedText = failedResponse?.text();
    const warnings: string[] = [];
    const originalWarn = console.error;
    console.error = (message?: unknown): void => {
      warnings.push(String(message));
    };
    let streamFailed: boolean | undefined;
    try {
      sockets[0]?.dispatch("close", {
        code: 1006,
        reason: "Connection ended",
      });
      streamFailed = await failedText?.then(
        () => false,
        () => true
      );
    } finally {
      console.error = originalWarn;
    }
    expect(streamFailed).toBe(true);
    expect(warnings).toHaveLength(1);
    const warning = JSON.parse(warnings[0] ?? "{}") as Record<string, unknown>;
    expect(warning.event).toBe("codex_websocket_stream_failed");
    expect(warning.payloadCount).toBe(1);
    expect(typeof warning.requestBytes).toBe("number");
    expect(typeof warning.upstreamIdleMs).toBe("number");
    expect(typeof warning.downstreamIdleMs).toBe("number");

    const sameSession = await tryProxyCodexWebSocket({
      headers,
      bodyJson,
      accountKey: "key-1:account-1",
    });
    expect(sameSession).toBeNull();
    expect(sockets).toHaveLength(1);

    headers.set("x-session-affinity", "healthy-session");
    const healthyResponsePromise = tryProxyCodexWebSocket({
      headers,
      bodyJson,
      accountKey: "key-1:account-1",
    });
    await waitFor(() => sentBodies.length === 2);
    sockets[1]?.dispatch("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_healthy", status: "completed" },
      }),
    });
    const healthyResponse = await healthyResponsePromise;

    expect(await healthyResponse?.text()).toContain("response.completed");
    expect(sockets).toHaveLength(2);
  });

  test("treats same-session websocket connect races as busy", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies, {
      autoOpen: false,
    });
    const headers = new Headers({
      authorization: "Bearer codex-access",
      [CODEX_ACCOUNT_ID_HEADER]: "acct_1",
      "x-session-affinity": "connecting-session",
    });
    const firstInput = [
      { role: "user", content: [{ type: "input_text", text: "Start" }] },
    ];
    const assistantItem = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      content: [{ type: "output_text", text: "Started" }],
    };
    const thirdInput = [
      ...firstInput,
      assistantItem,
      { role: "user", content: [{ type: "input_text", text: "Continue" }] },
    ];

    const firstPromise = tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: firstInput,
      },
      accountKey: "key-1:account-1",
    });
    await waitFor(() => sockets.length === 1);

    const connectingFallback = await tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: firstInput,
      },
      accountKey: "key-1:account-1",
    });
    expect(connectingFallback).toBeNull();
    expect(sockets).toHaveLength(1);

    const socket = sockets[0];
    if (!socket) {
      throw new Error("Missing websocket mock");
    }
    socket.dispatch("open", {});
    await waitFor(() => sentBodies.length === 1);
    socket.dispatch("message", {
      data: JSON.stringify({
        type: "response.created",
        response: { id: "resp_1", status: "completed" },
      }),
    });
    socket.dispatch("message", {
      data: JSON.stringify({
        type: "response.output_item.done",
        item: assistantItem,
      }),
    });
    socket.dispatch("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_1", status: "completed" },
      }),
    });
    const first = await firstPromise;
    await first?.text();

    const thirdPromise = tryProxyCodexWebSocket({
      headers,
      bodyJson: {
        model: "gpt-5-codex",
        stream: true,
        input: thirdInput,
      },
      accountKey: "key-1:account-1",
    });
    await waitFor(() => sentBodies.length === 2);
    socket.dispatch("message", {
      data: JSON.stringify({
        type: "response.created",
        response: { id: "resp_3", status: "completed" },
      }),
    });
    socket.dispatch("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp_3", status: "completed" },
      }),
    });
    const third = await thirdPromise;
    await third?.text();

    const thirdBody = sentBodies[1] as {
      input?: unknown[];
      previous_response_id?: string;
    };
    expect(thirdBody.previous_response_id).toBeUndefined();
    expect(thirdBody.input).toEqual(thirdInput);
  });
});

describe("proxy contract: claude", () => {
  const legacyClaudeMetadata: ClaudeAccountMetadata = {
    provider: "claude",
    oauthMode: "max",
    oauthHost: "claude.ai",
  };

  const claudeUsageRequestBody = {
    tools: [{ name: "shell" }, { name: "browser" }],
  };
  const prepareClaudeUsageRequest = (
    onTokenUsage?: ((usage: TokenUsage) => void) | null
  ) =>
    prepareClaudeProxyRequest({
      requestUrl: new URL("https://kleis.local/v1/messages"),
      headers: new Headers(),
      bodyText: JSON.stringify(claudeUsageRequestBody),
      bodyJson: claudeUsageRequestBody,
      accessToken: "claude-token",
      metadata: null,
      onTokenUsage,
    });

  test("maps tool names per request and restores them in responses", async () => {
    const requestBody = {
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { name: "Shell" },
        { name: "shell" },
      ],
      tool_choice: { type: "tool", name: "web_search" },
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t-0", name: "read", input: {} },
            {
              type: "tool_use",
              id: "t-browser",
              toolset_name: "browser",
              name: "navigate",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t-0",
              content: [{ type: "tool_reference", tool_name: "read" }],
            },
          ],
        },
      ],
    };
    const result = prepareClaudeProxyRequest({
      requestUrl: new URL("https://kleis.local/v1/messages"),
      headers: new Headers(),
      bodyText: JSON.stringify(requestBody),
      bodyJson: requestBody,
      accessToken: "claude-token",
      metadata: null,
    });
    const transformed = JSON.parse(result.bodyText) as {
      tools: Array<{ name: string }>;
      tool_choice: { name: string };
      messages: Array<{
        content: Array<{ name?: string; content?: [{ tool_name: string }] }>;
      }>;
    };

    expect(transformed.tools.map((tool) => tool.name)).toEqual([
      "web_search",
      "mcp__Shell",
      "mcp_Shell",
    ]);
    expect(transformed.tool_choice.name).toBe("web_search");
    expect(transformed.messages[0]?.content[0]?.name).toBe("mcp_Read");
    expect(transformed.messages[0]?.content[1]?.name).toBe("navigate");
    expect(transformed.messages[1]?.content[0]?.content?.[0].tool_name).toBe(
      "mcp_Read"
    );

    const upstreamNames = ["mcp__Shell", "mcp_Shell", "mcp_Read", "mcp_Other"];
    const clientNames = ["Shell", "shell", "read", "mcp_Other"];
    const toolUse = (name: string) => ({
      type: "tool_use",
      id: "t-1",
      name,
      input: {},
    });

    const sse = await result.transformResponse(
      createSseResponse(
        upstreamNames.map((name) => ({
          type: "content_block_start",
          content_block: toolUse(name),
        }))
      )
    );
    expect((await sse.text()).match(/"name":"[^"]+"/gu)).toEqual(
      clientNames.map((name) => `"name":"${name}"`)
    );

    const json = await result.transformResponse(
      Response.json({ type: "message", content: upstreamNames.map(toolUse) })
    );
    const body = (await json.json()) as { content: Array<{ name: string }> };
    expect(body.content.map((block) => block.name)).toEqual(clientNames);
  });

  test("rewrites the Pi docs phrases that trip the Claude OAuth classifier", () => {
    const requestBody = {
      system:
        "- When asked about: themes (docs/themes.md), pi packages (docs/packages.md), MCP servers (docs/mcp.md)\n" +
        "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
    };

    const result = prepareClaudeProxyRequest({
      requestUrl: new URL("https://kleis.local/v1/messages"),
      headers: new Headers(),
      bodyText: JSON.stringify(requestBody),
      bodyJson: requestBody,
      accessToken: "claude-token",
      metadata: null,
    });

    const transformed = JSON.parse(result.bodyText) as {
      system: Array<{ type: string; text: string }>;
    };

    expect(transformed.system[1]?.text).toBe(
      "- When asked about: themes (docs/themes.md), packages (docs/packages.md), MCP servers (docs/mcp.md)\n" +
        "- When working on pi topics, read the docs and examples, and follow cross-references before implementing"
    );
  });

  test("sanitizes OpenCode text inside array-form system blocks", () => {
    const requestBody = {
      system: [
        {
          type: "text",
          text:
            "You are OpenCode, the best coding agent on the planet.\n\n" +
            "Feedback lives at\n" +
            "  https://github.com/anomalyco/opencode\n\n" +
            "<directories>\n" +
            "  src/\n" +
            "</directories>",
        },
      ],
    };

    const result = prepareClaudeProxyRequest({
      requestUrl: new URL("https://kleis.local/v1/messages"),
      headers: new Headers(),
      bodyText: JSON.stringify(requestBody),
      bodyJson: requestBody,
      accessToken: "claude-token",
      metadata: null,
    });

    const transformed = JSON.parse(result.bodyText) as {
      system: Array<{ type: string; text: string }>;
    };

    expect(transformed.system).toHaveLength(2);
    expect(transformed.system[1]?.text).toContain(
      "https://github.com/anomalyco/project"
    );
    expect(transformed.system[1]?.text).toContain("Directories");
    expect(transformed.system[1]?.text).toContain("src/");
    expect(transformed.system[1]?.text).toContain("</directories>");
  });

  test("adds the Claude Code identity only when the system prompt lacks it", () => {
    const prepareSystem = (requestBody: Record<string, unknown>) =>
      (
        JSON.parse(
          prepareClaudeProxyRequest({
            requestUrl: new URL("https://kleis.local/v1/messages"),
            headers: new Headers(),
            bodyText: JSON.stringify(requestBody),
            bodyJson: requestBody,
            accessToken: "claude-token",
            metadata: null,
          }).bodyText
        ) as { system: unknown }
      ).system;
    const identity = { type: "text", text: CLAUDE_SYSTEM_IDENTITY };
    const cachedIdentity = {
      ...identity,
      cache_control: { type: "ephemeral", ttl: "1h" },
    };
    const custom = { type: "text", text: "Custom system prompt" };

    expect(prepareSystem({ messages: [] })).toEqual([identity]);
    expect(prepareSystem({ system: null })).toEqual([identity]);
    // Anthropic rejects an empty system text block.
    expect(prepareSystem({ system: "" })).toEqual([identity]);
    expect(prepareSystem({ system: CLAUDE_SYSTEM_IDENTITY })).toEqual([
      identity,
    ]);
    expect(prepareSystem({ system: [custom, cachedIdentity] })).toEqual([
      custom,
      cachedIdentity,
    ]);
  });

  test("ignores Claude wire configuration left in legacy account metadata", () => {
    const requestBody = {
      system: "Custom system prompt",
      tools: [{ name: "shell" }],
    };
    const result = prepareClaudeProxyRequest({
      requestUrl: new URL("https://kleis.local/v1/messages"),
      headers: new Headers(),
      bodyText: JSON.stringify(requestBody),
      bodyJson: requestBody,
      accessToken: "claude-token",
      metadata: {
        ...legacyClaudeMetadata,
        systemIdentity: "stale identity",
        toolPrefix: "stale_",
      } as ClaudeAccountMetadata,
    });

    const transformed = JSON.parse(result.bodyText) as {
      system: Array<{ type: string; text: string }>;
      tools: Array<{ name: string }>;
    };

    expect(transformed.system[0]?.text).toBe(CLAUDE_SYSTEM_IDENTITY);
    expect(transformed.tools[0]?.name).toBe("mcp_Shell");
  });

  test("preserves unrelated xml tags while rewriting the known blocked patterns", () => {
    const requestBody = {
      system:
        "Custom system prompt\n\n" +
        "<env>\n" +
        "  Working directory: /tmp/project\n" +
        "</env>\n\n" +
        "Feedback lives at\n" +
        "  https://github.com/anomalyco/opencode\n\n" +
        "<directories>\n" +
        "  src/\n" +
        "</directories>",
    };

    const result = prepareClaudeProxyRequest({
      requestUrl: new URL("https://kleis.local/v1/messages"),
      headers: new Headers(),
      bodyText: JSON.stringify(requestBody),
      bodyJson: requestBody,
      accessToken: "claude-token",
      metadata: null,
    });

    const transformed = JSON.parse(result.bodyText) as {
      system: Array<{ type: string; text: string }>;
    };

    expect(transformed.system).toEqual([
      { type: "text", text: CLAUDE_SYSTEM_IDENTITY },
      {
        type: "text",
        text:
          "Custom system prompt\n\n" +
          "<env>\n" +
          "  Working directory: /tmp/project\n" +
          "</env>\n\n" +
          "Feedback lives at\n" +
          "  https://github.com/anomalyco/project\n\n" +
          "Directories\n" +
          "src/\n" +
          "</directories>",
      },
    ]);
  });

  test("always sends beta=true upstream and keeps other query params", () => {
    const result = prepareClaudeProxyRequest({
      requestUrl: new URL(
        "https://kleis.local/v1/messages?beta=false&beta=false&trace=1"
      ),
      headers: new Headers(),
      bodyText: "{}",
      bodyJson: {},
      accessToken: "claude-token",
      metadata: null,
    });

    expect(result.upstreamUrl).toBe(
      "https://api.anthropic.com/v1/messages?beta=true&trace=1"
    );
  });

  test("strips tool prefix in non-streaming JSON response payload", async () => {
    const capture = createUsageCapture();
    const result = prepareClaudeUsageRequest(capture.onTokenUsage);

    const sourceResponse = Response.json({
      usage: {
        input_tokens: 33,
        output_tokens: 8,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 2,
      },
      type: "message",
      content: [
        {
          type: "tool_use",
          name: "mcp_Shell",
          id: "t-1",
          input: { call: { type: "tool_use", name: "mcp_Shell" } },
        },
      ],
    });

    const transformedResponse = await result.transformResponse(sourceResponse);
    const transformed = (await transformedResponse.json()) as {
      content: Array<{ name: string; input: unknown }>;
    };

    expect(transformed.content).toEqual([
      {
        type: "tool_use",
        name: "shell",
        id: "t-1",
        input: { call: { type: "tool_use", name: "mcp_Shell" } },
      },
    ]);
    expect(capture.read()).toEqual({
      inputTokens: 33,
      outputTokens: 8,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
    });
  });

  test("strips tool prefix in streaming response payload", async () => {
    const result = prepareClaudeUsageRequest();

    const encoder = new TextEncoder();
    const sourceResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(
            encoder.encode(
              'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_'
            )
          );
          controller.enqueue(encoder.encode('Shell"}}\n'));
          controller.enqueue(encoder.encode("\n"));
          controller.close();
        },
      }),
      {
        headers: {
          "content-type": "text/event-stream",
        },
      }
    );
    const transformedResponse = await result.transformResponse(sourceResponse);

    expect(transformedResponse.headers.get("cache-control")).toBe(
      "no-cache, no-transform"
    );
    expect(transformedResponse.headers.get("x-accel-buffering")).toBe("no");
    expect(transformedResponse.headers.get("content-length")).toBeNull();
    const transformedText = await transformedResponse.text();
    expect(transformedText).toContain('"name":"shell"');
  });

  test("passes text events through unchanged and still reports usage and tool names", async () => {
    const usages: TokenUsage[] = [];
    const result = prepareClaudeUsageRequest((usage) => usages.push(usage));
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":40,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"say \\"tool_use\\" and   keep spacing"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"mcp_Shell","input":{}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const response = await result.transformResponse(
      new Response(events.join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    );
    const text = await response.text();

    expect(text).toContain(events[1]);
    expect(text).toContain('"name":"shell"');
    expect(text).not.toContain("mcp_Shell");
    expect(usages).toEqual([
      {
        inputTokens: 3,
        outputTokens: 9,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
      },
    ]);
  });

  test("applies downstream backpressure to Claude SSE reads", async () => {
    const result = prepareClaudeUsageRequest();
    const encoder = new TextEncoder();
    let pulls = 0;
    const source = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller): void {
            pulls++;
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "content_block_delta", index: pulls })}\n\n`
              )
            );
          },
        },
        { highWaterMark: 0 }
      ),
      { headers: { "content-type": "text/event-stream" } }
    );

    const transformed = await result.transformResponse(source);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pulls).toBe(1);
    await transformed.body?.cancel();
  });

  test("logs claude streaming error event details", async () => {
    const result = prepareClaudeUsageRequest();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };

    try {
      const transformedResponse = await result.transformResponse(
        createSseResponse([
          {
            type: "error",
            error: {
              type: "overloaded_error",
              message: "Anthropic is overloaded",
            },
          },
        ])
      );
      await transformedResponse.text();
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toHaveLength(1);
    const warning = JSON.parse(warnings[0] ?? "{}") as Record<string, unknown>;
    expect(warning.event).toBe("claude_sse_error_event");
    expect(warning.errorType).toBe("overloaded_error");
    expect(warning.errorMessage).toBeUndefined();
    expect(warnings[0]).not.toContain("Anthropic is overloaded");
  });

  test("Claude SSE diagnostics do not expose provider metadata or request headers", async () => {
    const event = {
      type: "error",
      error: {
        type: "PRIVATESECRETTOKEN",
        code: "PRIVATESECRETTOKEN",
        message: "PRIVATESECRETTOKEN",
      },
    };
    const source = createSseResponse([event]);
    source.headers.set("request-id", "PRIVATESECRETTOKEN");
    const log = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response =
        await prepareClaudeUsageRequest().transformResponse(source);
      expect(await response.text()).toBe(
        await createSseResponse([event]).text()
      );
      expect(log).toHaveBeenCalledTimes(1);
      const line = String(log.mock.calls[0]?.[0]);
      expect(JSON.parse(line)).toMatchObject({
        event: "claude_sse_error_event",
        errorType: null,
        errorCode: null,
        requestIdHash: expect.stringMatching(/^[a-f0-9]{8}$/),
      });
      expect(line).not.toContain("PRIVATESECRETTOKEN");
    } finally {
      log.mockRestore();
    }
  });

  test("rewrites fragmented multiline SSE events at event boundaries", async () => {
    const result = prepareClaudeUsageRequest();
    const encoder = new TextEncoder();

    const sourceResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(encoder.encode("event: message\n"));
          controller.enqueue(
            encoder.encode(
              'data: {"type":"content_block_start","content_block":{"type":"tool_use",\n'
            )
          );
          controller.enqueue(encoder.encode('data: "name":"mcp_Shell"}}\n\n'));
          controller.close();
        },
      }),
      {
        headers: {
          "content-type": "text/event-stream",
        },
      }
    );

    const transformedResponse = await result.transformResponse(sourceResponse);
    const transformedText = await transformedResponse.text();

    expect(transformedText).toBe(
      'event: message\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"shell"}}\n\n'
    );
  });

  test("rewrites SSE events with mixed newline boundary separators", async () => {
    const result = prepareClaudeUsageRequest();
    const encoder = new TextEncoder();

    const sourceResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(
            encoder.encode(
              'event: message\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Shell"}}\n\r\n'
            )
          );
          controller.enqueue(
            encoder.encode(
              'event: message\r\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Browser"}}\r\n\n'
            )
          );
          controller.close();
        },
      }),
      {
        headers: {
          "content-type": "text/event-stream",
        },
      }
    );

    const transformedResponse = await result.transformResponse(sourceResponse);
    const transformedText = await transformedResponse.text();

    expect(transformedText).toBe(
      'event: message\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"shell"}}\n\r\n' +
        'event: message\r\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"browser"}}\r\n\n'
    );
  });

  test("rewrites tool names when every read ends inside a CRLF", async () => {
    const result = prepareClaudeUsageRequest();
    const encoder = new TextEncoder();
    const original =
      'event: content_block_start\r\ndata: {"type":"content_block_start",\r\ndata: "content_block":{"type":"tool_use","name":"mcp_Shell"}}\r\n\r\n' +
      'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n';
    const sourceResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          for (const part of original.split(/(?<=\r)/u)) {
            controller.enqueue(encoder.encode(part));
          }
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );

    const transformedResponse = await result.transformResponse(sourceResponse);

    expect(await transformedResponse.text()).toBe(
      'event: content_block_start\r\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"shell"}}\r\n\r\n' +
        'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n'
    );
  });

  test("cancels upstream when a Claude SSE event exceeds the buffer limit", async () => {
    const result = prepareClaudeUsageRequest();
    let cancelled = false;
    const sourceResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(
            new TextEncoder().encode(`data: ${"x".repeat(4 * 1024 * 1024)}`)
          );
        },
        cancel(): void {
          cancelled = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
    const originalWarn = console.warn;
    console.warn = (): void => undefined;
    try {
      const transformedResponse =
        await result.transformResponse(sourceResponse);
      await expect(transformedResponse.text()).rejects.toThrow("buffer limit");
      await waitFor(() => cancelled);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("reads and rewrites a final event that has no closing blank line", async () => {
    const capture = createUsageCapture();
    const result = prepareClaudeUsageRequest(capture.onTokenUsage);
    const transformedResponse = await result.transformResponse(
      new Response(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n' +
          'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Shell"}}\n\n' +
          'data: {"type":"message_delta","usage":{"output_tokens":9}}\n',
        { headers: { "content-type": "text/event-stream" } }
      )
    );

    expect(await transformedResponse.text()).toContain('"name":"shell"');
    expect(capture.read()).toEqual({
      inputTokens: 3,
      outputTokens: 9,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  const streamRecords = () => ({
    usages: [] as TokenUsage[],
    statuses: [] as number[],
  });
  const prepareClaudeStreamEndRequest = (
    records: ReturnType<typeof streamRecords>
  ) =>
    prepareClaudeProxyRequest({
      requestUrl: new URL("https://kleis.local/v1/messages"),
      headers: new Headers(),
      bodyText: "{}",
      bodyJson: {},
      accessToken: "claude-token",
      metadata: null,
      onTokenUsage: (usage) => records.usages.push(usage),
      onStreamEnd: (statusCode) => records.statuses.push(statusCode),
    });

  const messageStart = {
    type: "message_start",
    message: { usage: { input_tokens: 3, cache_read_input_tokens: 8 } },
  };
  const observedUsage = {
    inputTokens: 3,
    outputTokens: 0,
    cacheReadTokens: 8,
    cacheWriteTokens: 0,
  };
  const toNamedSse = (events: readonly { type: string }[]): string =>
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      )
      .join("");

  const claudeStreamEndCases = [
    { name: "message_stop", event: { type: "message_stop" }, status: 200 },
    {
      name: "a rate limit error",
      event: { type: "error", error: { type: "rate_limit_error" } },
      status: 429,
    },
    {
      name: "an overloaded error",
      event: { type: "error", error: { type: "overloaded_error" } },
      status: 529,
    },
    {
      name: "another error",
      event: { type: "error", error: { type: "api_error" } },
      status: 502,
    },
  ] as const;

  for (const testCase of claudeStreamEndCases) {
    test(`records usage and one outcome for a Claude stream ended by ${testCase.name}`, async () => {
      const records = streamRecords();
      const result = prepareClaudeStreamEndRequest(records);
      const originalWarn = console.warn;
      console.warn = (): void => undefined;
      try {
        const response = await result.transformResponse(
          new Response(toNamedSse([messageStart, testCase.event]), {
            headers: { "content-type": "text/event-stream" },
          })
        );
        await response.text();
      } finally {
        console.warn = originalWarn;
      }

      expect(records.usages).toEqual([observedUsage]);
      expect(records.statuses).toEqual([testCase.status]);
    });
  }

  test("forwards a Claude stream without message_stop as is and records 502", async () => {
    const records = streamRecords();
    const result = prepareClaudeStreamEndRequest(records);
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown): void => {
      warnings.push(String(message));
    };
    const body = `data: ${JSON.stringify(messageStart)}\n\ndata: {"type":"message_delta"`;
    let output: string;
    try {
      const response = await result.transformResponse(
        new Response(body, { headers: { "content-type": "text/event-stream" } })
      );
      output = await response.text();
    } finally {
      console.warn = originalWarn;
    }

    expect(output).toBe(body);
    expect(records.usages).toEqual([observedUsage]);
    expect(records.statuses).toEqual([502]);
    expect(warnings).toHaveLength(1);
    const warning = JSON.parse(warnings[0] ?? "{}") as Record<string, unknown>;
    expect(warning.event).toBe("claude_sse_missing_message_stop");
    expect(warning.truncatedEvent).toBe(true);
  });

  test("records a cancelled Claude stream as 499 unless message_stop arrived", async () => {
    for (const [events, status] of [
      [[messageStart], 499],
      [[messageStart, { type: "message_stop" }], 200],
    ] as const) {
      const records = streamRecords();
      const result = prepareClaudeStreamEndRequest(records);
      const response = await result.transformResponse(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(new TextEncoder().encode(toNamedSse(events)));
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
      );
      const reader = response.body?.getReader();
      expect((await reader?.read())?.done).toBe(false);
      await reader?.cancel();

      expect(records.usages).toEqual([observedUsage]);
      expect(records.statuses).toEqual([status]);
    }
  });

  test("records a non-2xx Claude event stream with its HTTP status", async () => {
    const records = streamRecords();
    const response = await prepareClaudeStreamEndRequest(
      records
    ).transformResponse(
      new Response(
        toNamedSse([
          {
            type: "error",
            error: { type: "authentication_error", message: "Unauthorized" },
          } as { type: string },
        ]),
        { status: 401, headers: { "content-type": "text/event-stream" } }
      )
    );
    await response.text();

    expect(records.usages).toEqual([]);
    expect(records.statuses).toEqual([401]);
  });

  test("records a Claude stream whose upstream read fails as 502", async () => {
    const records = streamRecords();
    const result = prepareClaudeStreamEndRequest(records);
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const response = await result.transformResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            upstream = controller;
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(messageStart)}\n\n`
              )
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      )
    );
    const reader = response.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    upstream?.error(new Error("upstream interrupted"));
    const originalWarn = console.warn;
    console.warn = (): void => undefined;
    try {
      await expect(reader?.read()).rejects.toThrow("upstream interrupted");
    } finally {
      console.warn = originalWarn;
    }

    expect(records.usages).toEqual([observedUsage]);
    expect(records.statuses).toEqual([502]);
  });

  test("extracts usage from fragmented streaming events", async () => {
    const capture = createUsageCapture();
    const result = prepareClaudeUsageRequest(capture.onTokenUsage);
    const encoder = new TextEncoder();

    const sourceResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(
            encoder.encode('data: {"type":"message_start","message":{"usage":{')
          );
          controller.enqueue(
            encoder.encode('"input_tokens":55,"cache_read_input_tokens":11,')
          );
          controller.enqueue(
            encoder.encode('"cache_creation_input_tokens":5}}}\n\n')
          );
          controller.enqueue(
            encoder.encode('data: {"type":"message_delta","usage":{')
          );
          controller.enqueue(
            encoder.encode(
              '"input_tokens":56,"output_tokens":13,"cache_read_input_tokens":12,"cache_creation_input_tokens":7'
            )
          );
          controller.enqueue(encoder.encode("}}\n\n"));
          controller.close();
        },
      }),
      {
        headers: {
          "content-type": "text/event-stream",
        },
      }
    );

    const transformedResponse = await result.transformResponse(sourceResponse);
    await transformedResponse.text();

    expect(capture.read()).toEqual({
      inputTokens: 56,
      outputTokens: 13,
      cacheReadTokens: 12,
      cacheWriteTokens: 7,
    });
  });

  test("leaves tool_use look-alikes outside content blocks byte-for-byte", async () => {
    const result = prepareClaudeUsageRequest();
    const events =
      'event: future_event\ndata: { "type": "future_event", "item": {"type":"tool_use","name":"mcp_Shell"} }\n\n' +
      'event: message_delta\ndata: { "type": "message_delta", "delta": {"stop_reason":"tool_use"} }\n\n';

    const response = await result.transformResponse(
      new Response(events, { headers: { "content-type": "text/event-stream" } })
    );

    expect(await response.text()).toBe(events);
  });
});

describe("proxy contract: live limits", () => {
  test("reports websocket rate-limit events and still relays them", async () => {
    const sentBodies: unknown[] = [];
    const sockets = installManualCodexWebSocketMock(sentBodies);
    const readings: (CodexLiveLimits | null)[] = [];
    const responsePromise = tryProxyCodexWebSocket({
      headers: new Headers({ authorization: "Bearer codex-access" }),
      bodyJson: {
        model: "gpt-5.6-sol",
        stream: true,
        input: [{ role: "user", content: "hello" }],
      },
      accountKey: "key-1:rate-limit-event-account",
      onLiveLimits: (limits) => readings.push(limits),
    });
    await waitFor(() => sockets.length === 1 && sentBodies.length === 1);
    sockets[0]?.dispatch("message", {
      data: JSON.stringify({
        type: "codex.rate_limits",
        plan_type: "plus",
        rate_limits: {
          primary: { used_percent: 31, window_minutes: 300, reset_at: null },
          secondary: null,
        },
      }),
    });
    sockets[0]?.dispatch("message", {
      data: JSON.stringify({
        type: "response.completed",
        response: { id: "resp-rate-limits", status: "completed" },
      }),
    });
    const responseText = await (await responsePromise)?.text();

    expect(readings).toEqual([
      {
        provider: "codex",
        primaryWindow: {
          usedPercent: 31,
          windowSeconds: 18_000,
          resetAt: null,
        },
        secondaryWindow: null,
        credits: null,
        planType: "plus",
      },
    ]);
    expect(responseText).toContain('"type":"codex.rate_limits"');
    expect(responseText).toContain('"type":"response.completed"');
  });
});
