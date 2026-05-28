import { afterEach, describe, expect, test } from "bun:test";

import {
  CLAUDE_REQUIRED_BETA_HEADERS,
  CLAUDE_SYSTEM_IDENTITY,
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_ORIGINATOR,
  CODEX_RESPONSE_ENDPOINT,
  CODEX_USER_AGENT,
  CODEX_WEBSOCKET_BETA_HEADER,
  COPILOT_INITIATOR_HEADER,
  COPILOT_VISION_HEADER,
} from "../../src/providers/constants";
import type {
  CodexAccountMetadata,
  CopilotAccountMetadata,
} from "../../src/providers/metadata";
import { prepareClaudeProxyRequest } from "../../src/providers/proxies/claude-proxy";
import { prepareCodexProxyRequest } from "../../src/providers/proxies/codex-proxy";
import {
  closeCodexWebSocketSessions,
  tryProxyCodexWebSocket,
} from "../../src/providers/proxies/codex-websocket";
import { prepareCopilotProxyRequest } from "../../src/providers/proxies/copilot-proxy";
import type { TokenUsage } from "../../src/usage/token-usage";

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  closeCodexWebSocketSessions();
  globalThis.WebSocket = originalWebSocket;
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

    constructor(
      _url: string,
      protocols?: string | string[] | { headers?: Record<string, string> }
    ) {
      if (
        protocols &&
        typeof protocols === "object" &&
        !Array.isArray(protocols) &&
        protocols.headers
      ) {
        constructorHeaders.push(protocols.headers);
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

    send(data: string): void {
      sentBodies.push(JSON.parse(data) as unknown);
      const response = responses.shift();
      if (!response) {
        throw new Error("Unexpected websocket request");
      }

      queueMicrotask(() => {
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

    private dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  }

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
};

type ManualCodexWebSocket = {
  dispatch(type: string, event: unknown): void;
};

const installManualCodexWebSocketMock = (
  sentBodies: unknown[],
  options: { autoOpen?: boolean } = {}
): ManualCodexWebSocket[] => {
  const sockets: ManualCodexWebSocket[] = [];

  class MockWebSocket {
    static OPEN = 1;
    readyState = MockWebSocket.OPEN;
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

    send(data: string): void {
      sentBodies.push(JSON.parse(data) as unknown);
    }

    close(): void {
      this.readyState = 3;
    }

    dispatch(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  }

  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
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
    const headers = new Headers();
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
      tokenType: null,
      scope: null,
      idToken: null,
      chatgptAccountId: "acct-meta",
      organizationIds: [],
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
    expect(headers.get("originator")).toBe(CODEX_ORIGINATOR);
    expect(headers.get("User-Agent")).toBe(CODEX_USER_AGENT);
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
    const transformed = JSON.parse(result.bodyText) as {
      instructions?: string;
    };
    expect(transformed.instructions).toContain(
      "You are OpenCode, the best coding agent on the planet."
    );
  });

  test("uses derived session headers and prompt cache key for codex requests", () => {
    const headers = new Headers({
      session_id: "raw-session-underscore",
      "session-id": "raw-session-header",
      "x-session-affinity": "raw-session-affinity",
      "x-client-request-id": "raw-request-id",
    });
    const bodyJson = {
      model: "gpt-5-codex",
      prompt_cache_key: "raw-prompt-cache-key",
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
      sessionId: "kleis_derived_session",
    });

    const transformed = JSON.parse(result.bodyText) as {
      prompt_cache_key?: string;
    };
    expect(transformed.prompt_cache_key).toBe("kleis_derived_session");
    expect(headers.get("session_id")).toBeNull();
    expect(headers.get("x-session-affinity")).toBeNull();
    expect(headers.get("session-id")).toBe("kleis_derived_session");
    expect(headers.get("x-client-request-id")).toBe("kleis_derived_session");
  });

  test("does not use x-client-request-id as codex session affinity", () => {
    const headers = new Headers({
      "x-client-request-id": "raw-request-id",
    });
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

    const transformed = JSON.parse(result.bodyText) as {
      prompt_cache_key?: string;
    };
    expect(transformed.prompt_cache_key).toBeUndefined();
    expect(headers.get("session-id")).toBeNull();
    expect(headers.get("x-client-request-id")).toBeNull();
  });

  test("removes unsupported token limit params", () => {
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
        input_tokens_details: {
          cached_tokens: 20,
        },
      },
    });

    await result.transformResponse(sourceResponse);

    expect(capture.read()).toEqual({
      inputTokens: 100,
      outputTokens: 34,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
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
            input_tokens_details: {
              cached_tokens: 5,
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
      await transformed.text();

      expect(capture.read()).toEqual(testCase.expected);
    });
  }

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
    expect(lowerHeaderEntries["openai-beta"]).toBe(CODEX_WEBSOCKET_BETA_HEADER);
    expect(lowerHeaderEntries.authorization).toBe("Bearer codex-access");
    expect(lowerHeaderEntries["content-length"]).toBeUndefined();
    expect(lowerHeaderEntries.session_id).toBeUndefined();
    expect(lowerHeaderEntries["x-session-affinity"]).toBeUndefined();
    expect(lowerHeaderEntries["session-id"]).toMatch(/^kleis_/);
    expect(lowerHeaderEntries["x-client-request-id"]).toBe(
      lowerHeaderEntries["session-id"]
    );
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
    responsePromise.then((value) => {
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
    await waitFor(() => response !== undefined);
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

describe("proxy contract: copilot", () => {
  test("derives user + vision headers for chat completions", () => {
    const headers = new Headers();
    const bodyJson = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            {
              type: "image_url",
              image_url: { url: "https://example.com/a.png" },
            },
          ],
        },
      ],
      stream: true,
    };

    const result = prepareCopilotProxyRequest({
      endpoint: "chat_completions",
      requestUrl: new URL("https://kleis.local/chat/completions?stream=true"),
      headers,
      bodyText: JSON.stringify(bodyJson),
      bodyJson,
      githubAccessToken: "gh-token",
      metadata: null,
    });

    expect(headers.get("authorization")).toBe("Bearer gh-token");
    expect(headers.get(COPILOT_INITIATOR_HEADER)).toBe("user");
    expect(headers.get(COPILOT_VISION_HEADER)).toBe("true");
    expect(result.upstreamUrl).toBe(
      "https://api.githubcopilot.com/chat/completions?stream=true"
    );

    const transformed = JSON.parse(result.bodyText) as {
      stream_options?: { include_usage?: boolean };
    };
    expect(transformed.stream_options?.include_usage).toBe(true);
  });

  test("derives agent and clears vision header for responses", () => {
    const headers = new Headers({
      [COPILOT_VISION_HEADER]: "true",
    });
    const metadata: CopilotAccountMetadata = {
      provider: "copilot",
      tokenType: null,
      scope: null,
      enterpriseDomain: null,
      copilotApiBaseUrl: "https://copilot.internal",
      githubUserId: null,
      githubLogin: null,
      githubEmail: null,
    };

    const bodyJson = {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "question" }],
        },
        {
          role: "assistant",
          content: [{ type: "output_text", text: "answer" }],
        },
      ],
    };

    const result = prepareCopilotProxyRequest({
      endpoint: "responses",
      requestUrl: new URL("https://kleis.local/responses"),
      headers,
      bodyText: JSON.stringify(bodyJson),
      bodyJson,
      githubAccessToken: "gh-token",
      metadata,
    });

    expect(headers.get(COPILOT_INITIATOR_HEADER)).toBe("agent");
    expect(headers.get(COPILOT_VISION_HEADER)).toBeNull();
    expect(result.upstreamUrl).toBe("https://copilot.internal/responses");
  });

  const copilotStreamUsageCases = [
    {
      name: "chat-completions stream chunks",
      endpoint: "chat_completions",
      requestUrl: "https://kleis.local/chat/completions?stream=true",
      bodyJson: {
        stream: true,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        ],
      },
      event: {
        id: "cmpl_1",
        object: "chat.completion.chunk",
        choices: [],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 12,
          prompt_tokens_details: {
            cached_tokens: 8,
          },
        },
      },
      expected: {
        inputTokens: 42,
        outputTokens: 12,
        cacheReadTokens: 8,
        cacheWriteTokens: 0,
      },
    },
    {
      name: "responses stream response.done events",
      endpoint: "responses",
      requestUrl: "https://kleis.local/responses?stream=true",
      bodyJson: {
        stream: true,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        ],
      },
      event: {
        type: "response.done",
        response: {
          usage: {
            input_tokens: 140,
            output_tokens: 50,
            input_tokens_details: {
              cached_tokens: 20,
            },
          },
        },
      },
      expected: {
        inputTokens: 120,
        outputTokens: 50,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
      },
    },
  ] as const;

  for (const testCase of copilotStreamUsageCases) {
    test(`extracts usage from ${testCase.name}`, async () => {
      const capture = createUsageCapture();
      const result = prepareCopilotProxyRequest({
        endpoint: testCase.endpoint,
        requestUrl: new URL(testCase.requestUrl),
        headers: new Headers(),
        bodyText: JSON.stringify(testCase.bodyJson),
        bodyJson: testCase.bodyJson,
        githubAccessToken: "gh-token",
        metadata: null,
        onTokenUsage: capture.onTokenUsage,
      });

      const transformed = await result.transformResponse(
        createSseResponse([testCase.event])
      );
      await transformed.text();

      expect(capture.read()).toEqual(testCase.expected);
    });
  }

  test("extracts usage from responses stream without content-type", async () => {
    const capture = createUsageCapture();
    const bodyJson = {
      stream: true,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    };

    const result = prepareCopilotProxyRequest({
      endpoint: "responses",
      requestUrl: new URL("https://kleis.local/responses?stream=true"),
      headers: new Headers(),
      bodyText: JSON.stringify(bodyJson),
      bodyJson,
      githubAccessToken: "gh-token",
      metadata: null,
      onTokenUsage: capture.onTokenUsage,
    });

    const transformed = await result.transformResponse(
      createSseResponse(
        [
          {
            type: "response.done",
            response: {
              usage: {
                input_tokens: 88,
                output_tokens: 21,
                input_tokens_details: {
                  cached_tokens: 8,
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
      inputTokens: 80,
      outputTokens: 21,
      cacheReadTokens: 8,
      cacheWriteTokens: 0,
    });
  });

  test("extracts usage from non-streaming responses without content-type", async () => {
    const capture = createUsageCapture();
    const bodyJson = {
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    };

    const result = prepareCopilotProxyRequest({
      endpoint: "responses",
      requestUrl: new URL("https://kleis.local/responses"),
      headers: new Headers(),
      bodyText: JSON.stringify(bodyJson),
      bodyJson,
      githubAccessToken: "gh-token",
      metadata: null,
      onTokenUsage: capture.onTokenUsage,
    });

    const transformed = await result.transformResponse(
      new Response(
        new TextEncoder().encode(
          JSON.stringify({
            usage: {
              input_tokens: 54,
              output_tokens: 9,
              input_tokens_details: {
                cached_tokens: 4,
              },
            },
          })
        )
      )
    );
    await transformed.text();

    expect(capture.read()).toEqual({
      inputTokens: 50,
      outputTokens: 9,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
    });
  });
});

describe("proxy contract: claude", () => {
  const prepareClaudeUsageRequest = (
    onTokenUsage?: ((usage: TokenUsage) => void) | null
  ) =>
    prepareClaudeProxyRequest({
      requestUrl: new URL("https://kleis.local/v1/messages"),
      headers: new Headers(),
      bodyText: "{}",
      bodyJson: {},
      accessToken: "claude-token",
      metadata: null,
      onTokenUsage,
    });

  test("merges beta headers and rewrites payload tool names", () => {
    const headers = new Headers({
      "anthropic-beta": `custom-beta,${CLAUDE_REQUIRED_BETA_HEADERS[0]}`,
    });
    const requestBody = {
      system:
        "You are OpenCode, the best coding agent on the planet.\n\n" +
        "If the user asks for help or wants to give feedback inform them of the following:\n" +
        "- ctrl+p to list available actions\n" +
        "- To give feedback, users should report the issue at\n" +
        "  https://github.com/anomalyco/opencode\n\n" +
        "<directories>\n" +
        "  src/\n" +
        "</directories>\n\n" +
        "<env>\n" +
        "  Working directory: /tmp/project\n" +
        "</env>",
      tools: [{ name: "shell", description: "run shell commands" }],
      tool_choice: { type: "tool", name: "shell" },
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", name: "shell", id: "t-1", input: {} }],
        },
      ],
    };

    const result = prepareClaudeProxyRequest({
      requestUrl: new URL("https://kleis.local/v1/messages"),
      headers,
      bodyText: JSON.stringify(requestBody),
      bodyJson: requestBody,
      accessToken: "claude-token",
      metadata: null,
    });

    const transformed = JSON.parse(result.bodyText) as {
      system: Array<{ type: string; text: string }>;
      tools: Array<{ name: string }>;
      tool_choice: { type: string; name: string };
      messages: Array<{ content: Array<{ type: string; name?: string }> }>;
    };

    expect(headers.get("authorization")).toBe("Bearer claude-token");
    expect(headers.get("anthropic-beta")).toBe(
      [...CLAUDE_REQUIRED_BETA_HEADERS, "custom-beta"].join(",")
    );
    expect(headers.get("x-app")).toBe("cli");
    expect(result.upstreamUrl).toContain(
      "https://api.anthropic.com/v1/messages"
    );
    expect(result.upstreamUrl).toContain("beta=true");
    expect(transformed.system).toHaveLength(2);
    expect(transformed.system[0]?.text).toBe(CLAUDE_SYSTEM_IDENTITY);
    expect(transformed.system[1]?.text).toContain(
      "You are OpenCode, the best coding agent on the planet."
    );
    expect(transformed.system[1]?.text).toContain(
      "If the user asks for help or wants to give feedback inform them of the following:"
    );
    expect(transformed.system[1]?.text).not.toContain(
      "https://github.com/anomalyco/opencode"
    );
    expect(transformed.system[1]?.text).toContain(
      "https://github.com/anomalyco/project"
    );
    expect(transformed.system[1]?.text).toContain("Directories");
    expect(transformed.system[1]?.text).toContain("src/");
    expect(transformed.system[1]?.text).toContain(
      "Working directory: /tmp/project"
    );
    expect(transformed.system[1]?.text).toContain("<env>");
    expect(transformed.system[1]?.text).toContain("</env>");
    expect(transformed.system[1]?.text).not.toContain("<directories>");
    expect(transformed.tools[0]?.name).toBe("mcp_Shell");
    expect(transformed.tool_choice.name).toBe("mcp_Shell");
    expect(transformed.messages[0]?.content[0]?.name).toBe("mcp_Shell");
  });

  test("rewrites repo path and directories in non-OpenCode Claude system prompts", () => {
    const requestBody = {
      system:
        "Custom system prompt\n\n" +
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
          "Feedback lives at\n" +
          "  https://github.com/anomalyco/project\n\n" +
          "Directories\n" +
          "src/\n" +
          "</directories>",
      },
    ]);
  });

  test("rewrites the feedback repo path in OpenCode system prompts", () => {
    const requestBody = {
      system:
        "You are OpenCode, the best coding agent on the planet.\n\n" +
        "Feedback lives at\n" +
        "  https://github.com/anomalyco/opencode",
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

    expect(transformed.system[1]?.text).toContain(
      "You are OpenCode, the best coding agent on the planet."
    );
    expect(transformed.system[1]?.text).toContain(
      "https://github.com/anomalyco/project"
    );
  });

  test("normalizes only the opening directories tag in OpenCode system prompts", () => {
    const requestBody = {
      system:
        "You are OpenCode, the best coding agent on the planet.\n\n" +
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

    expect(transformed.system[1]?.text).toContain("Directories");
    expect(transformed.system[1]?.text).toContain("src/");
    expect(transformed.system[1]?.text).not.toContain("<directories>");
    expect(transformed.system[1]?.text).toContain("</directories>");
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
      content: [{ type: "tool_use", name: "mcp_shell", id: "t-1", input: {} }],
    });

    const transformedResponse = await result.transformResponse(sourceResponse);
    const transformed = (await transformedResponse.json()) as {
      content: Array<{ type: string; name: string }>;
    };

    expect(transformed.content[0]?.name).toBe("shell");
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
            encoder.encode('data: {"type":"tool_use","name":"mcp_')
          );
          controller.enqueue(encoder.encode('shell"}\n'));
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

    const transformedText = await transformedResponse.text();
    expect(transformedText).toContain('"name":"shell"');
  });

  test("rewrites fragmented multiline SSE events at event boundaries", async () => {
    const result = prepareClaudeUsageRequest();
    const encoder = new TextEncoder();

    const sourceResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(encoder.encode("event: message\n"));
          controller.enqueue(encoder.encode('data: {"type":"tool_use",\n'));
          controller.enqueue(encoder.encode('data: "name":"mcp_shell"}\n\n'));
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
      'event: message\ndata: {"type":"tool_use","name":"shell"}\n\n'
    );
  });

  test("rewrites CRLF-delimited SSE events without buffering until EOF", async () => {
    const result = prepareClaudeUsageRequest();
    const encoder = new TextEncoder();

    const sourceResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(
            encoder.encode(
              'event: message\r\ndata: {"type":"tool_use","name":"mcp_shell"}\r\n\r\n'
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
      'event: message\r\ndata: {"type":"tool_use","name":"shell"}\r\n\r\n'
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
              'event: message\ndata: {"type":"tool_use","name":"mcp_shell"}\n\r\n'
            )
          );
          controller.enqueue(
            encoder.encode(
              'event: message\r\ndata: {"type":"tool_use","name":"mcp_browser"}\r\n\n'
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
      'event: message\ndata: {"type":"tool_use","name":"shell"}\n\r\n' +
        'event: message\r\ndata: {"type":"tool_use","name":"browser"}\r\n\n'
    );
  });

  test("rewrites fragmented SSE events with mixed internal newlines", async () => {
    const result = prepareClaudeUsageRequest();
    const encoder = new TextEncoder();

    const sourceResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(encoder.encode("event: message\r\n"));
          controller.enqueue(encoder.encode('data: {"type":"tool_use",\n'));
          controller.enqueue(encoder.encode('data: "name":"mcp_shell"}\n\r\n'));
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
      'event: message\r\ndata: {"type":"tool_use","name":"shell"}\n\r\n'
    );
  });

  test("rewrites multiple SSE events delivered in one chunk", async () => {
    const result = prepareClaudeUsageRequest();
    const encoder = new TextEncoder();

    const sourceResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(
            encoder.encode(
              'event: message\ndata: {"type":"tool_use","name":"mcp_shell"}\n\n' +
                'event: message\ndata: {"type":"tool_use","name":"mcp_browser"}\n\n'
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
      'event: message\ndata: {"type":"tool_use","name":"shell"}\n\n' +
        'event: message\ndata: {"type":"tool_use","name":"browser"}\n\n'
    );
  });

  const claudeStreamUsageCases = [
    {
      name: "extracts usage from claude streaming message events",
      events: [
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 55,
              cache_read_input_tokens: 11,
              cache_creation_input_tokens: 5,
            },
          },
        },
        {
          type: "message_delta",
          usage: {
            output_tokens: 13,
          },
        },
      ],
      expected: {
        inputTokens: 55,
        outputTokens: 13,
        cacheReadTokens: 11,
        cacheWriteTokens: 5,
      },
    },
    {
      name: "updates claude streaming usage when message_delta includes usage fields",
      events: [
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 40,
              cache_read_input_tokens: 4,
              cache_creation_input_tokens: 2,
            },
          },
        },
        {
          type: "message_delta",
          usage: {
            input_tokens: 41,
            output_tokens: 9,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 3,
          },
        },
      ],
      expected: {
        inputTokens: 41,
        outputTokens: 9,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
      },
    },
  ] as const;

  for (const testCase of claudeStreamUsageCases) {
    test(testCase.name, async () => {
      const capture = createUsageCapture();
      const result = prepareClaudeUsageRequest(capture.onTokenUsage);

      const transformedResponse = await result.transformResponse(
        createSseResponse(testCase.events)
      );
      await transformedResponse.text();

      expect(capture.read()).toEqual(testCase.expected);
    });
  }

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
            encoder.encode('"output_tokens":13,"cache_creation_input_tokens":7')
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
      inputTokens: 55,
      outputTokens: 13,
      cacheReadTokens: 11,
      cacheWriteTokens: 7,
    });
  });

  test("does not rewrite non-tool SSE name fields", async () => {
    const result = prepareClaudeUsageRequest();

    const transformedResponse = await result.transformResponse(
      createSseResponse([{ type: "status", name: "mcp_shell" }])
    );

    const transformedText = await transformedResponse.text();
    expect(transformedText).toContain('"name":"mcp_shell"');
  });
});
