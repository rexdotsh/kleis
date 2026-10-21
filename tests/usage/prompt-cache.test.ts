import { expect, spyOn, test } from "bun:test";

import type { ProxyOperation } from "../../src/providers/proxy-endpoints";
import {
  createPromptCacheTracker,
  readClaudePromptCacheRequest,
  readCodexPromptCacheRequest,
  type PromptCacheMiss,
} from "../../src/usage/prompt-cache";
import type { TokenUsage } from "../../src/usage/token-usage";

const MINUTE_MS = 60_000;
const startedAt = Date.parse("2026-10-21T12:00:00Z");
const firstAt = startedAt + 2 * 60 * MINUTE_MS;

const claudeBody = (fields: Record<string, unknown> = {}) => ({
  model: "claude-fake",
  system: [{ type: "text", text: "You are a fake assistant." }],
  tools: [{ name: "read", input_schema: { type: "object" } }],
  messages: [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: "ok" },
    { role: "user", content: "next" },
  ],
  ...fields,
});
const codexBody = (fields: Record<string, unknown> = {}) => ({
  model: "gpt-fake",
  instructions: "Fake instructions.",
  tools: [{ type: "function", name: "read" }],
  input: [
    { type: "message", role: "user", content: "first" },
    { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
  ],
  ...fields,
});

const warm: TokenUsage = {
  inputTokens: 500,
  outputTokens: 50,
  cacheReadTokens: 12_000,
  cacheWriteTokens: 8000,
};
const hit: TokenUsage = {
  ...warm,
  cacheReadTokens: 20_000,
  cacheWriteTokens: 0,
};
const cold: TokenUsage = {
  inputTokens: 20_500,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

type Turn = {
  body: Record<string, unknown>;
  operation?: ProxyOperation;
  account?: string;
  model?: string;
  afterMs?: number;
  usage?: TokenUsage;
};

const longTtlSystem = [
  {
    type: "text",
    text: "You are a fake assistant.",
    cache_control: { type: "ephemeral", ttl: "1h" },
  },
];
const compactionBlock = {
  role: "assistant",
  content: [{ type: "compaction", content: "summary", signature: "sig" }],
};

test("a large cache drop in a known conversation is reported with its likeliest reason", () => {
  const rows: {
    name: string;
    provider: "claude" | "codex";
    first?: Turn;
    second: Turn;
    expected: Partial<PromptCacheMiss> | null;
  }[] = [
    {
      name: "a turn that reads its prefix",
      provider: "claude",
      first: { body: claudeBody() },
      second: { body: claudeBody(), usage: hit },
      expected: null,
    },
    {
      name: "changed tools",
      provider: "claude",
      first: { body: claudeBody() },
      second: { body: claudeBody({ tools: [{ name: "write" }] }) },
      expected: {
        reason: "prefix_changed",
        changed: ["tools"],
        expectedCachedTokens: 20_000,
        repaidTokens: 20_000,
      },
    },
    {
      name: "a moved cache breakpoint",
      provider: "claude",
      first: {
        body: claudeBody({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "first",
                  cache_control: { type: "ephemeral" },
                },
              ],
            },
            { role: "assistant", content: "ok" },
          ],
        }),
      },
      second: { body: claudeBody() },
      expected: { reason: "unknown", changed: [] },
    },
    {
      name: "another account",
      provider: "claude",
      first: { body: claudeBody() },
      second: { body: claudeBody(), account: "account-2" },
      expected: {
        reason: "account_changed",
        previousProviderAccountId: "account-1",
      },
    },
    {
      name: "another model",
      provider: "codex",
      first: { body: codexBody() },
      second: { body: codexBody(), model: "gpt-other" },
      expected: { reason: "model_changed", previousModel: "fake-model" },
    },
    {
      name: "a gap past the Claude TTL",
      provider: "claude",
      first: { body: claudeBody() },
      second: { body: claudeBody(), afterMs: 6 * MINUTE_MS },
      expected: { reason: "idle_expired", expiry: "certain" },
    },
    {
      name: "a gap inside a 1h Claude TTL",
      provider: "claude",
      first: { body: claudeBody({ system: longTtlSystem }) },
      second: {
        body: claudeBody({ system: longTtlSystem }),
        afterMs: 6 * MINUTE_MS,
      },
      expected: { reason: "unknown" },
    },
    {
      name: "a gap past the shortest Codex TTL",
      provider: "codex",
      first: { body: codexBody() },
      second: { body: codexBody(), afterMs: 6 * MINUTE_MS },
      expected: { reason: "idle_expired", expiry: "possible" },
    },
    {
      name: "changed Codex instructions",
      provider: "codex",
      first: { body: codexBody() },
      second: { body: codexBody({ instructions: "Other instructions." }) },
      expected: { reason: "prefix_changed", changed: ["instructions"] },
    },
    {
      name: "Claude on-demand compaction",
      provider: "claude",
      first: { body: claudeBody({ compaction: { type: "summarize" } }) },
      second: {
        body: claudeBody({
          messages: [compactionBlock, { role: "user", content: "next" }],
        }),
      },
      expected: { reason: "compacted" },
    },
    {
      name: "Codex remote compaction",
      provider: "codex",
      first: { body: codexBody(), operation: "compact" },
      second: {
        body: codexBody({
          input: [{ type: "compaction", encrypted_content: "fake" }],
        }),
      },
      expected: { reason: "compacted" },
    },
    {
      name: "a resumed conversation right after start",
      provider: "codex",
      second: { body: codexBody(), afterMs: -110 * MINUTE_MS },
      expected: { reason: "first_request_after_restart" },
    },
  ];

  const info = spyOn(console, "info").mockImplementation(() => undefined);
  try {
    for (const row of rows) {
      const tracker = createPromptCacheTracker(startedAt);
      const observe = (turn: Turn, usage: TokenUsage) => {
        const request =
          row.provider === "claude"
            ? readClaudePromptCacheRequest(
                "fake-key",
                turn.body,
                new Headers({ "x-claude-code-session-id": "session-1" })
              )
            : readCodexPromptCacheRequest(
                "fake-key",
                turn.body,
                "session-1",
                turn.operation
              );
        if (!request) throw new Error(`${row.name}: no conversation`);
        return tracker.observe(request, {
          apiKeyId: "fake-key",
          providerAccountId: turn.account ?? "account-1",
          model: turn.model ?? "fake-model",
          usage,
          now: firstAt + (turn.afterMs ?? MINUTE_MS),
        });
      };
      if (row.first) observe({ ...row.first, afterMs: 0 }, warm);
      const miss = observe(row.second, row.second.usage ?? cold);
      expect({ row: row.name, miss }).toMatchObject({
        row: row.name,
        miss: row.expected,
      });
    }
  } finally {
    info.mockRestore();
  }
});
