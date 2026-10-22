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

const session = { "x-claude-code-session-id": "s1", "session-id": "s1" };
const subagent = { ...session, "x-claude-code-agent-id": "fake-agent" };
const auxiliary = { ...session, "x-claude-code-request-class": "auxiliary" };
const mainClass = { ...session, "x-claude-code-request-class": "main" };
const compactionClass = {
  ...session,
  "x-claude-code-request-class": "compaction",
};
const codexSubagent = { ...session, "x-openai-subagent": "collab_spawn" };
const warm = claudeUsage(12_000, 8000);
const cold = claudeUsage(0, 20_000);
const compaction = { type: "compaction", input_tokens: 132 };
const compactionBilled = claudeUsage(0, 20_000, {
  iterations: [
    { ...compaction, cache_read_input_tokens: 90_000 },
    { input_tokens: 500, cache_creation_input_tokens: 20_000 },
  ],
});
const promoted = (agent: string) => ({
  instructions: undefined,
  input: [
    { role: "developer", content: agent },
    { type: "message", role: "user", content: "task" },
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
      {
        reason: "unknown",
        isMain: true,
        contextTokens: 20_500,
        expectedCachedTokens: 20_000,
        repaidTokens: 20_000,
      },
    ],
    [
      "another account",
      [claude(warm), claude(cold, {}, { account: "account-2" })],
      { reason: "account_changed", previousProviderAccountId: "account-1" },
    ],
    [
      "a gap past the 1h Claude TTL the proxy sends",
      [claude(warm), claude(cold, {}, { minute: 70 })],
      { reason: "idle_expired", expiry: "certain", ttlMs: 3_600_000 },
    ],
    [
      "a Claude gap of ten minutes, inside the 1h TTL the proxy sends",
      [claude(warm), claude(cold, {}, { minute: 10 })],
      { reason: "unknown", expiry: null },
    ],
    [
      "a subagent gap past an hour",
      [
        claude(warm, {}, { headers: subagent }),
        claude(cold, {}, { headers: subagent, minute: 70 }),
      ],
      { reason: "idle_expired", isMain: false },
    ],
    [
      "two side requests ten minutes apart",
      [
        claude(warm, {}, { headers: auxiliary }),
        claude(cold, {}, { headers: auxiliary, minute: 10 }),
      ],
      { reason: "unknown", isMain: false },
    ],
    [
      "a gap past the shortest Codex TTL",
      [codex(codexUsage(20_000)), codex(codexUsage(0), {}, { minute: 7 })],
      { reason: "idle_expired", expiry: "possible" },
    ],
    [
      "appended history",
      [claude(warm, { messages: history.slice(0, 1) }), claude(cold)],
      { reason: "unknown" },
    ],
    [
      "a subagent in the parent's session",
      [
        claude(warm),
        claude(
          cold,
          { system: "You are a fake subagent." },
          { headers: subagent }
        ),
      ],
      null,
    ],
    [
      "a model change in the session",
      [claude(warm), claude(cold, {}, { model: "claude-other" })],
      { reason: "model_changed", repaidTokens: 20_000 },
    ],
    [
      "a system prompt change in the session",
      [claude(warm), claude(cold, { system: "You are another assistant." })],
      { reason: "system_changed" },
    ],
    [
      "a tools change in the session",
      [claude(warm), claude(cold, { tools: [{ name: "write" }] })],
      { reason: "tools_changed" },
    ],
    [
      "a removed tool that shrinks the context",
      [claude(warm), claude(claudeUsage(0, 18_000), { tools: [] })],
      { reason: "tools_changed", repaidTokens: 18_500 },
    ],
    [
      "a model change after an unclassified title request",
      [
        claude(warm),
        claude(claudeUsage(0, 4600), { tools: [] }, { model: "claude-small" }),
        claude(cold, {}, { model: "claude-other" }),
      ],
      { reason: "model_changed", repaidTokens: 20_000 },
    ],
    [
      "a classified main turn that drops tools and changes model",
      [
        claude(warm, {}, { headers: mainClass }),
        claude(
          claudeUsage(0, 9000),
          { tools: [] },
          { model: "claude-other", headers: mainClass }
        ),
      ],
      { reason: "model_changed", repaidTokens: 9500 },
    ],
    [
      "a new task after a classified compaction",
      [
        claude(warm),
        claude(
          claudeUsage(0, 0, { input_tokens: 0, iterations: [compaction] }),
          {},
          { headers: compactionClass }
        ),
        claude(cold, { messages: [{ content: "summary" }] }),
      ],
      null,
    ],
    [
      "a new task in the session",
      [claude(warm), claude(cold, { messages: [{ content: "other task" }] })],
      { reason: "session_unknown" },
    ],
    [
      "a Claude Code side request in the session",
      [
        claude(warm),
        claude(
          cold,
          {},
          {
            model: "claude-small",
            headers: { ...session, "x-claude-code-request-class": "auxiliary" },
          }
        ),
      ],
      null,
    ],
    [
      "a model change that re-pays under 4096 tokens",
      [
        claude(claudeUsage(1000, 5000)),
        claude(claudeUsage(2500, 3500), {}, { model: "claude-other" }),
      ],
      null,
    ],
    [
      "a model change running alongside the previous turn",
      [claude(warm), claude(cold, {}, { model: "claude-other" })],
      null,
      { concurrent: true },
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
      "a compaction during the turn",
      [
        claude(warm),
        claude(
          claudeUsage(0, 20_000, {
            iterations: [
              compaction,
              { input_tokens: 500, cache_creation_input_tokens: 20_000 },
            ],
          })
        ),
      ],
      { reason: "compacted" },
    ],
    [
      "the turn after on-demand compaction",
      [
        claude(warm),
        claude(
          claudeUsage(0, 0, { input_tokens: 0, iterations: [compaction] })
        ),
        claude(cold, {
          messages: [{ role: "assistant", content: [{ type: "compaction" }] }],
        }),
      ],
      null,
    ],
    [
      "a sibling task in the parent's session",
      [
        claude(warm),
        claude(
          cold,
          { messages: [{ content: "other task" }] },
          { headers: subagent }
        ),
      ],
      null,
    ],
    [
      "a sibling Codex agent whose instructions are promoted",
      [
        codex(codexUsage(20_000), promoted("Agent A")),
        codex(codexUsage(0), promoted("Agent B"), { headers: codexSubagent }),
      ],
      null,
    ],
    [
      "a sibling Codex task sent as string input",
      [
        codex(codexUsage(20_000), { input: "task A" }),
        codex(codexUsage(0), { input: "task B" }, { headers: codexSubagent }),
      ],
      null,
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
        const headers = new Headers(turn.headers ?? session);
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
