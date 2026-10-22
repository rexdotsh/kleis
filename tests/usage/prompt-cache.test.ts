import { expect, spyOn, test } from "bun:test";

import {
  createPromptCacheTracker,
  readPromptCacheRequest,
  type PromptCacheMiss,
} from "../../src/usage/prompt-cache";
import {
  readAnthropicUsageFromResponse,
  readOpenAiResponsesUsageFromResponse,
} from "../../src/usage/token-usage";

type Turn = {
  provider: "claude" | "codex";
  body: Record<string, unknown>;
  response: unknown;
  headers?: Record<string, string>;
  model?: string;
  account?: string;
  minute?: number;
};

const history = [
  { role: "user", content: "first" },
  { role: "assistant", content: "ok" },
  { role: "user", content: "next" },
];
const claude = (
  response: unknown,
  fields: Record<string, unknown> = {},
  turn: Partial<Turn> = {}
): Turn => ({
  provider: "claude",
  body: {
    system: "You are a fake assistant.",
    tools: [{ name: "read" }],
    messages: history,
    ...fields,
  },
  response,
  ...turn,
});
const codex = (
  response: unknown,
  fields: Record<string, unknown> = {},
  turn: Partial<Turn> = {}
): Turn => ({
  provider: "codex",
  body: {
    instructions: "Fake instructions.",
    tools: [{ type: "function", name: "read" }],
    input: [{ type: "function_call", call_id: "c1", name: "read" }],
    ...fields,
  },
  response,
  ...turn,
});
const claudeUsage = (
  read: number,
  write: number,
  fields: Record<string, unknown> = {}
) => ({
  usage: {
    input_tokens: 500,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    ...fields,
  },
});
const codexUsage = (cached: number, output: unknown[] = []) => ({
  output,
  usage: {
    input_tokens: 20_500,
    input_tokens_details: { cached_tokens: cached },
  },
});

const warm = claudeUsage(12_000, 8000);
const cold = claudeUsage(0, 20_000);
const longTtl = [
  ...history,
  { role: "user", content: [{ type: "text", cache_control: { ttl: "1h" } }] },
];
const compaction = { type: "compaction", input_tokens: 132 };
const compactionBilled = claudeUsage(0, 20_000, {
  iterations: [
    { ...compaction, cache_read_input_tokens: 90_000 },
    { input_tokens: 500, cache_creation_input_tokens: 20_000 },
  ],
});
const afterCompaction = {
  usage: { input_tokens: 40_000, cache_read_input_tokens: 20_000 },
};

test("a turn that reads far less than the previous turn cached is reported only with evidence for its reason", () => {
  const rows: [
    string,
    Turn[],
    Partial<PromptCacheMiss> | null,
    { concurrent?: boolean }?,
  ][] = [
    [
      "a turn that reads its prefix",
      [claude(warm), claude(claudeUsage(20_000, 300))],
      null,
    ],
    [
      "a drop with no evidence",
      [claude(warm), claude(cold)],
      { reason: "unknown", expectedCachedTokens: 20_000, repaidTokens: 20_000 },
    ],
    [
      "another account",
      [claude(warm), claude(cold, {}, { account: "account-2" })],
      { reason: "account_changed", previousProviderAccountId: "account-1" },
    ],
    [
      "a gap past the Claude TTL",
      [claude(warm), claude(cold, {}, { minute: 7 })],
      { reason: "idle_expired", expiry: "certain" },
    ],
    [
      "a gap past the shortest Codex TTL",
      [codex(codexUsage(20_000)), codex(codexUsage(0), {}, { minute: 7 })],
      { reason: "idle_expired", expiry: "possible" },
    ],
    [
      "a gap inside a later 1h breakpoint",
      [
        claude(warm, { messages: longTtl }),
        claude(cold, { messages: longTtl }, { minute: 7 }),
      ],
      { reason: "unknown" },
    ],
    [
      "appended history",
      [claude(warm, { messages: history.slice(0, 1) }), claude(cold)],
      { reason: "unknown" },
    ],
    [
      "a subagent in the parent's session",
      [claude(warm), claude(cold, { system: "You are a fake subagent." })],
      null,
    ],
    [
      "a title request in the parent's session",
      [
        claude(warm),
        claude(claudeUsage(0, 4600), { tools: [] }, { model: "claude-small" }),
      ],
      null,
    ],
    [
      "conversations sharing only metadata.user_id",
      [
        claude(warm, { metadata: { user_id: "fake" } }, { headers: {} }),
        claude(cold, { metadata: { user_id: "fake" } }, { headers: {} }),
      ],
      null,
    ],
    [
      "conversations sharing only a prompt_cache_key",
      [
        codex(
          codexUsage(20_000),
          { prompt_cache_key: "fake" },
          { headers: {} }
        ),
        codex(codexUsage(0), { prompt_cache_key: "fake" }, { headers: {} }),
      ],
      null,
    ],
    [
      "two first turns running at the same time",
      [claude(cold), claude(cold)],
      null,
      { concurrent: true },
    ],
    [
      "a request that asked for compaction without getting one",
      [claude(warm, { compaction: {} }), claude(cold)],
      { reason: "unknown" },
    ],
    [
      "a Claude compaction response",
      [
        claude(warm),
        claude(
          claudeUsage(0, 0, { input_tokens: 0, iterations: [compaction] })
        ),
        claude(cold),
      ],
      { reason: "compacted" },
    ],
    [
      "a Codex compaction response",
      [
        codex(codexUsage(20_000, [{ type: "compaction" }])),
        codex(codexUsage(0)),
      ],
      { reason: "compacted" },
    ],
    [
      "a turn after compaction billed more than the last call cached",
      [claude(compactionBilled), claude(afterCompaction)],
      null,
    ],
    ["a conversation with no state", [codex(codexUsage(0))], null],
  ];

  const info = spyOn(console, "info").mockImplementation(() => undefined);
  try {
    for (const [name, turns, expected, options] of rows) {
      const tracker = createPromptCacheTracker();
      const begin = (turn: Turn, index: number) => {
        const headers = new Headers(
          turn.headers ?? {
            "x-claude-code-session-id": "s1",
            "session-id": "s1",
          }
        );
        const request = readPromptCacheRequest(turn.provider, {
          apiKeyId: "fake-key",
          model: turn.model ?? "fake-model",
          headers,
          body: turn.body,
        });
        const at = Date.UTC(2026, 9, 21) + (turn.minute ?? index) * 60_000;
        return request && { turn, at, started: tracker.begin(request, at) };
      };
      const finish = (begun: ReturnType<typeof begin>) => {
        if (!begun) return null;
        const { turn } = begun;
        const usage =
          turn.provider === "claude"
            ? readAnthropicUsageFromResponse(turn.response)
            : readOpenAiResponsesUsageFromResponse(turn.response);
        if (!usage) throw new Error(`${name}: no usage`);
        return tracker.observe(begun.started, {
          providerAccountId: turn.account ?? "account-1",
          usage,
          now: begun.at + 30_000,
        });
      };

      let miss: PromptCacheMiss | null = null;
      const begun = options?.concurrent ? turns.map(begin) : null;
      for (const [index, turn] of turns.entries()) {
        miss = finish(begun ? begun[index] : begin(turn, index));
      }
      expect({ name, miss }).toMatchObject({ name, miss: expected });
    }
  } finally {
    info.mockRestore();
  }
});
