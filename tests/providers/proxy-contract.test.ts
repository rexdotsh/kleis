import { describe, expect, test } from "bun:test";

import {
  CLAUDE_REQUIRED_BETA_HEADERS,
  CLAUDE_SYSTEM_IDENTITY,
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_ORIGINATOR,
  CODEX_RESPONSE_ENDPOINT,
  COPILOT_INITIATOR_HEADER,
  COPILOT_VISION_HEADER,
} from "../../src/providers/constants";
import type {
  CodexAccountMetadata,
  CopilotAccountMetadata,
} from "../../src/providers/metadata";
import { prepareClaudeProxyRequest } from "../../src/providers/proxies/claude-proxy";
import { prepareCodexProxyRequest } from "../../src/providers/proxies/codex-proxy";
import { prepareCopilotProxyRequest } from "../../src/providers/proxies/copilot-proxy";
import type { TokenUsage } from "../../src/usage/token-usage";

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
    expect(headers.get("originator")).toBe(CODEX_ORIGINATOR);
    expect(result.upstreamUrl).toBe(CODEX_RESPONSE_ENDPOINT);
    expect(result.bodyText).toBe(bodyText);
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

  test("removes unsupported token limit params", () => {
    const bodyJson = {
      model: "gpt-5-codex",
      instructions: "Keep responses concise",
      max_output_tokens: 4096,
      max_completion_tokens: 4096,
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
    };
    expect(transformed.max_output_tokens).toBeUndefined();
    expect(transformed.max_completion_tokens).toBeUndefined();
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
      system: "OpenCode and opencode should be rewritten",
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
    expect(transformed.system[1]?.text).toBe(
      "Claude Code and Claude should be rewritten"
    );
    expect(transformed.tools[0]?.name).toBe("mcp_shell");
    expect(transformed.tool_choice.name).toBe("mcp_shell");
    expect(transformed.messages[0]?.content[0]?.name).toBe("mcp_shell");
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

  test("does not rewrite non-tool SSE name fields", async () => {
    const result = prepareClaudeUsageRequest();

    const transformedResponse = await result.transformResponse(
      createSseResponse([{ type: "status", name: "mcp_shell" }])
    );

    const transformedText = await transformedResponse.text();
    expect(transformedText).toContain('"name":"mcp_shell"');
  });
});
