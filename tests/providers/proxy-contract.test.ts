import { describe, expect, test } from "bun:test";

import {
  CLAUDE_REQUIRED_BETA_HEADERS,
  CLAUDE_SYSTEM_IDENTITY,
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_REQUEST_PROFILE,
  CODEX_RESPONSE_ENDPOINT,
  COPILOT_INITIATOR_HEADER,
  COPILOT_REQUEST_PROFILE,
  COPILOT_VISION_HEADER,
} from "../../src/providers/constants";
import type {
  CodexAccountMetadata,
  CopilotAccountMetadata,
} from "../../src/providers/metadata";
import { prepareClaudeProxyRequest } from "../../src/providers/proxies/claude-proxy";
import { prepareCodexProxyRequest } from "../../src/providers/proxies/codex-proxy";
import { prepareCopilotProxyRequest } from "../../src/providers/proxies/copilot-proxy";

describe("proxy contract: codex", () => {
  test("applies auth, account-id, and endpoint from metadata", () => {
    const headers = new Headers();
    const metadata: CodexAccountMetadata = {
      provider: "codex",
      tokenType: null,
      scope: null,
      idToken: null,
      chatgptAccountId: "acct-meta",
      organizationIds: [],
      email: null,
      requestProfile: CODEX_REQUEST_PROFILE,
    };

    const result = prepareCodexProxyRequest({
      headers,
      accessToken: "codex-access",
      accountId: "acct-fallback",
      metadata,
    });

    expect(headers.get("authorization")).toBe("Bearer codex-access");
    expect(headers.get(CODEX_ACCOUNT_ID_HEADER)).toBe("acct-meta");
    expect(result.upstreamUrl).toBe(CODEX_RESPONSE_ENDPOINT);
  });

  test("uses account id when metadata is absent", () => {
    const headers = new Headers();

    prepareCodexProxyRequest({
      headers,
      accessToken: "codex-access",
      accountId: "acct-fallback",
      metadata: null,
    });

    expect(headers.get(CODEX_ACCOUNT_ID_HEADER)).toBe("acct-fallback");
  });
});

describe("proxy contract: copilot", () => {
  test("derives user + vision headers for chat completions", () => {
    const headers = new Headers();

    const result = prepareCopilotProxyRequest({
      endpoint: "chat_completions",
      requestUrl: new URL(
        "https://kleis.local/v1/chat/completions?stream=true"
      ),
      headers,
      bodyJson: {
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
      },
      githubAccessToken: "gh-token",
      metadata: null,
    });

    expect(headers.get("authorization")).toBe("Bearer gh-token");
    expect(headers.get(COPILOT_INITIATOR_HEADER)).toBe("user");
    expect(headers.get(COPILOT_VISION_HEADER)).toBe("true");
    expect(result.upstreamUrl).toBe(
      "https://api.githubcopilot.com/v1/chat/completions?stream=true"
    );
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
      requestProfile: COPILOT_REQUEST_PROFILE,
    };

    const result = prepareCopilotProxyRequest({
      endpoint: "responses",
      requestUrl: new URL("https://kleis.local/v1/responses"),
      headers,
      bodyJson: {
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
      },
      githubAccessToken: "gh-token",
      metadata,
    });

    expect(headers.get(COPILOT_INITIATOR_HEADER)).toBe("agent");
    expect(headers.get(COPILOT_VISION_HEADER)).toBeNull();
    expect(result.upstreamUrl).toBe("https://copilot.internal/v1/responses");
  });
});

describe("proxy contract: claude", () => {
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
    const result = prepareClaudeProxyRequest({
      requestUrl: new URL("https://kleis.local/v1/messages"),
      headers: new Headers(),
      bodyText: "{}",
      bodyJson: {},
      accessToken: "claude-token",
      metadata: null,
    });

    const sourceResponse = Response.json({
      content: [{ type: "tool_use", name: "mcp_shell", id: "t-1", input: {} }],
    });

    const transformedResponse = await result.transformResponse(sourceResponse);
    const transformed = (await transformedResponse.json()) as {
      content: Array<{ type: string; name: string }>;
    };

    expect(transformed.content[0]?.name).toBe("shell");
  });

  test("strips tool prefix in streaming response payload", async () => {
    const result = prepareClaudeProxyRequest({
      requestUrl: new URL("https://kleis.local/v1/messages"),
      headers: new Headers(),
      bodyText: "{}",
      bodyJson: {},
      accessToken: "claude-token",
      metadata: null,
    });

    const encoder = new TextEncoder();
    const sourceResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(encoder.encode('data: {"name":"mcp_'));
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
    expect(transformedText).toContain('"name": "shell"');
  });
});
