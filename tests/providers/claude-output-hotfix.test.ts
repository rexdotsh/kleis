import { describe, expect, test } from "bun:test";

import { prepareClaudeProxyRequest } from "../../src/providers/proxies/claude-proxy";
import { applyOpenCode2018ClaudeOutputHotfix } from "../../src/providers/proxies/opencode-2018-claude-output-hotfix";

const affectedRequest = {
  model: "claude-opus-5-5",
  max_tokens: 32_000,
  stream: true,
  thinking: { type: "adaptive" },
  output_config: { effort: "max" },
  system: [
    {
      type: "text",
      text: "Keep the existing instructions and cache boundary",
      cache_control: { type: "ephemeral" },
    },
  ],
  messages: [{ role: "user", content: "Explain this code" }],
};

describe("temporary OpenCode 2.0.18 Claude output hotfix", () => {
  test("raises the affected Opus adaptive-thinking output limit without changing input", () => {
    const result = applyOpenCode2018ClaudeOutputHotfix(affectedRequest);

    expect(result).toEqual({ ...affectedRequest, max_tokens: 128_000 });
    expect(affectedRequest.max_tokens).toBe(32_000);
    expect(applyOpenCode2018ClaudeOutputHotfix(result)).toBe(result);
  });

  test("passes through requests outside the exact affected shape", () => {
    const otherRequests: unknown[] = [
      { ...affectedRequest, model: "claude-sonnet-4-5" },
      { ...affectedRequest, max_tokens: 64_000 },
      { ...affectedRequest, max_tokens: "32000" },
      { ...affectedRequest, stream: false },
      { ...affectedRequest, thinking: { type: "disabled" } },
      {
        ...affectedRequest,
        thinking: { type: "enabled", budget_tokens: 31_000 },
      },
      null,
      [],
    ];
    for (const request of otherRequests) {
      expect(applyOpenCode2018ClaudeOutputHotfix(request)).toBe(request);
    }
  });

  test("also matches sessions whose effort is carried in message updates", () => {
    const request = { ...affectedRequest, output_config: undefined };
    expect(applyOpenCode2018ClaudeOutputHotfix(request)).toEqual({
      ...request,
      max_tokens: 128_000,
    });
  });

  test("forwards the raised limit through the existing Claude request transformation", () => {
    const result = prepareClaudeProxyRequest({
      requestUrl: new URL("https://kleis.example/anthropic/v1/messages"),
      headers: new Headers(),
      bodyText: JSON.stringify(affectedRequest),
      bodyJson: affectedRequest,
      accessToken: "fixture-access-token",
      metadata: null,
    });
    const forwarded = JSON.parse(result.bodyText) as {
      max_tokens: number;
      thinking: { type: string };
      output_config: { effort: string };
      system: Array<{ cache_control?: { type: string } }>;
    };

    expect(forwarded.max_tokens).toBe(128_000);
    expect(forwarded.thinking).toEqual(affectedRequest.thinking);
    expect(forwarded.output_config).toEqual(affectedRequest.output_config);
    expect(forwarded.system[1]?.cache_control).toEqual({ type: "ephemeral" });
  });
});
