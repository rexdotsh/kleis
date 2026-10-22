import type { Provider } from "../db/schema";
import {
  readCodexSessionHeader,
  transformCodexRequestBody,
} from "../providers/proxies/codex-proxy";
import type { ProxyOperation } from "../providers/proxy-endpoints";
import { logInfo } from "../utils/log";
import { isObjectRecord } from "../utils/object";
import type { TokenUsage } from "./token-usage";

export type PromptCacheMissReason =
  | "account_changed"
  | "compacted"
  | "idle_expired"
  | "unknown"
  | "model_changed"
  | "system_changed"
  | "tools_changed"
  | "session_unknown";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// Below this many reusable tokens a drop is too small to report.
const MIN_REUSABLE_TOKENS = 4096;
const MAX_CONVERSATIONS = 5000;
// The Claude proxy sends every breakpoint with the 1h TTL.
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration
const CLAUDE_TTL_MS = HOUR_MS;
// OpenAI keeps prefixes for at least 5 minutes, often far longer, so a Codex
// gap past the TTL only possibly expired the cache.
// https://platform.openai.com/docs/guides/prompt-caching#cache-lifetime
const CODEX_TTL_MS: Record<string, number> = {
  "30m": 30 * MINUTE_MS,
  "12h": 720 * MINUTE_MS,
  "24h": 1440 * MINUTE_MS,
};
const CODEX_DEFAULT_TTL_MS = 5 * MINUTE_MS;
// Claude Code 2.1.86+ and OpenCode send a session header.
// https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#2186
// https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/core/src/session/model-request.ts#L282-L291
const CLAUDE_SESSION_HEADERS = [
  "x-claude-code-session-id",
  "x-opencode-session-id",
  "x-session-affinity",
  "x-session-id",
] as const;
// Subagents in OpenCode, Claude Code and Codex send one of these. Claude Code
// also sends a request class, which is "main" only for main-thread turns.
// https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs
const SUBAGENT_HEADERS = [
  "x-opencode-parent-session-id",
  "x-parent-session-id",
  "x-claude-code-agent-id",
  "x-claude-code-parent-agent-id",
  "x-openai-subagent",
  "x-codex-parent-thread-id",
] as const;
const CLAUDE_CODE_REQUEST_CLASS_HEADER = "x-claude-code-request-class";

export type PromptCacheRequest = {
  conversation: bigint;
  session: bigint;
  provider: Provider;
  apiKeyId: string;
  model: string;
  system: bigint;
  tools: bigint;
  ttlMs: number;
  isMain: boolean;
  isClassifiedMain: boolean;
};

type ConversationState = {
  providerAccountId: string;
  cachedTokens: number;
  ttlMs: number;
  compacted: boolean;
  at: number;
};

type SessionState = ConversationState &
  Pick<PromptCacheRequest, "conversation" | "model" | "system" | "tools">;

export type PromptCacheTurn = PromptCacheRequest & {
  startedAt: number;
  previous: ConversationState | undefined;
  previousSession: SessionState | undefined;
};

export type PromptCacheMiss = {
  at: number;
  provider: Provider;
  apiKeyId: string;
  providerAccountId: string;
  previousProviderAccountId: string;
  model: string;
  reason: PromptCacheMissReason;
  isMain: boolean;
  idleMs: number;
  ttlMs: number;
  expiry: "certain" | "possible" | null;
  contextTokens: number;
  cachedTokens: number;
  expectedCachedTokens: number;
  repaidTokens: number;
  conversationHash: string;
  sessionHash: string;
};

type PromptCacheMissTotal = Pick<
  PromptCacheMiss,
  "provider" | "reason" | "isMain" | "repaidTokens"
> & { misses: number };

const hashJson = (value: unknown): bigint =>
  Bun.hash.wyhash(JSON.stringify(value) ?? "");

const codexTtlMs = (body: Record<string, unknown>): number => {
  const ttl = isObjectRecord(body.prompt_cache_options)
    ? body.prompt_cache_options.ttl
    : body.prompt_cache_retention;
  return (
    (typeof ttl === "string" ? CODEX_TTL_MS[ttl] : undefined) ??
    CODEX_DEFAULT_TTL_MS
  );
};

const firstItem = (
  items: unknown,
  include: (item: unknown) => boolean = () => true
): unknown => (Array.isArray(items) ? items.find(include) : items);

const isCodexInstruction = (item: unknown): boolean =>
  isObjectRecord(item) && (item.role === "system" || item.role === "developer");

const isCodexTask = (item: unknown): boolean => !isCodexInstruction(item);

// A conversation is one session's turns with the same model, system prompt,
// tools and first task item, so subagents and side requests in that session
// keep their own. Codex requests are read as sent upstream.
export const readPromptCacheRequest = (
  provider: Provider,
  input: {
    apiKeyId: string;
    model: string;
    headers: Headers;
    body: unknown;
    operation?: ProxyOperation;
  }
): PromptCacheRequest | null => {
  const claude = provider === "claude";
  const session = claude
    ? CLAUDE_SESSION_HEADERS.map((name) =>
        input.headers.get(name)?.trim()
      ).find(Boolean)
    : readCodexSessionHeader(input.headers);
  if (!session) {
    return null;
  }
  const body = claude
    ? input.body
    : transformCodexRequestBody(input.body, input.operation);
  if (!isObjectRecord(body)) {
    return null;
  }

  const sessionHash = hashJson([input.apiKeyId, provider, session]);
  const system = hashJson(
    claude
      ? body.system
      : [
          body.instructions,
          Array.isArray(body.input)
            ? body.input.filter(isCodexInstruction)
            : null,
        ]
  );
  const tools = hashJson(body.tools);
  const requestClass = input.headers.get(CLAUDE_CODE_REQUEST_CLASS_HEADER);
  return {
    conversation: hashJson([
      `${sessionHash}`,
      input.model,
      `${system}`,
      `${tools}`,
      claude ? firstItem(body.messages) : firstItem(body.input, isCodexTask),
    ]),
    session: sessionHash,
    provider,
    apiKeyId: input.apiKeyId,
    model: input.model,
    system,
    tools,
    ttlMs: claude ? CLAUDE_TTL_MS : codexTtlMs(body),
    isClassifiedMain: requestClass === "main",
    isMain:
      (requestClass ?? "main") === "main" &&
      !SUBAGENT_HEADERS.some((name) => input.headers.has(name)),
  };
};

const remember = <State>(
  states: Map<bigint, State>,
  key: bigint,
  state: State
): void => {
  states.delete(key);
  states.set(key, state);
  if (states.size > MAX_CONVERSATIONS) {
    const oldest = states.keys().next();
    if (!oldest.done) states.delete(oldest.value);
  }
};

const sessionMissReason = (
  turn: PromptCacheTurn,
  previous: SessionState,
  providerAccountId: string
): PromptCacheMissReason => {
  if (previous.providerAccountId !== providerAccountId)
    return "account_changed";
  if (previous.model !== turn.model) return "model_changed";
  if (previous.system !== turn.system) return "system_changed";
  if (previous.tools !== turn.tools) return "tools_changed";
  return "session_unknown";
};

export const createPromptCacheTracker = () => {
  const conversations = new Map<bigint, ConversationState>();
  const sessions = new Map<bigint, SessionState>();
  const totals = new Map<string, PromptCacheMissTotal>();
  const since = Date.now();

  return {
    // The baseline is the state when the request starts, so requests that
    // run at the same time never count as reuse for each other.
    begin: (
      request: PromptCacheRequest,
      now = Date.now()
    ): PromptCacheTurn => ({
      ...request,
      startedAt: now,
      previous: conversations.get(request.conversation),
      previousSession: request.isMain
        ? sessions.get(request.session)
        : undefined,
    }),

    // Reports a miss when a turn reads under half of what the previous turn
    // of its conversation left cached. A main turn that starts a new
    // conversation is compared with the session's previous main turn. Without
    // a request class, a turn carrying under half that turn's cached context
    // is taken for a title or side request and skipped.
    observe(
      turn: PromptCacheTurn,
      input: { providerAccountId: string; usage: TokenUsage; now?: number }
    ): PromptCacheMiss | null {
      const now = input.now ?? Date.now();
      const { usage } = input;
      const call = usage.lastCall ?? usage;
      const cachedTokens = call.cacheReadTokens + call.cacheWriteTokens;
      const contextTokens = call.inputTokens + cachedTokens;
      const compacted = usage.compacted === true;
      const state: ConversationState = {
        providerAccountId: input.providerAccountId,
        cachedTokens,
        ttlMs: turn.ttlMs,
        compacted,
        at: now,
      };
      if (contextTokens >= MIN_REUSABLE_TOKENS) {
        remember(conversations, turn.conversation, state);
      }
      const { previous, previousSession } = turn;
      const continuesSession =
        turn.isMain &&
        contextTokens >= MIN_REUSABLE_TOKENS &&
        (!previousSession ||
          turn.isClassifiedMain ||
          contextTokens * 2 >= previousSession.cachedTokens);
      if (compacted) {
        sessions.delete(turn.session);
      } else if (continuesSession) {
        remember(sessions, turn.session, {
          ...state,
          conversation: turn.conversation,
          model: turn.model,
          system: turn.system,
          tools: turn.tools,
        });
      }

      let baseline: ConversationState;
      let expectedCachedTokens: number;
      let reason: PromptCacheMissReason = "unknown";
      if (previous) {
        baseline = previous;
        expectedCachedTokens = Math.min(previous.cachedTokens, contextTokens);
        if (previous.providerAccountId !== input.providerAccountId) {
          reason = "account_changed";
        } else if (compacted || previous.compacted) {
          reason = "compacted";
        } else if (turn.startedAt - previous.at > previous.ttlMs) {
          reason = "idle_expired";
        }
      } else if (previousSession && continuesSession && !compacted) {
        baseline = previousSession;
        expectedCachedTokens = Math.min(
          previousSession.cachedTokens,
          contextTokens
        );
        reason = sessionMissReason(
          turn,
          previousSession,
          input.providerAccountId
        );
      } else {
        return null;
      }
      const repaidTokens = expectedCachedTokens - call.cacheReadTokens;
      if (
        expectedCachedTokens < MIN_REUSABLE_TOKENS ||
        call.cacheReadTokens >= expectedCachedTokens / 2 ||
        (!previous && repaidTokens < MIN_REUSABLE_TOKENS)
      ) {
        return null;
      }

      const idleMs = turn.startedAt - baseline.at;
      const miss: PromptCacheMiss = {
        at: now,
        provider: turn.provider,
        apiKeyId: turn.apiKeyId,
        providerAccountId: input.providerAccountId,
        previousProviderAccountId: baseline.providerAccountId,
        model: turn.model,
        reason,
        isMain: turn.isMain,
        idleMs,
        ttlMs: baseline.ttlMs,
        expiry:
          reason !== "idle_expired"
            ? null
            : turn.provider === "claude"
              ? "certain"
              : "possible",
        contextTokens,
        cachedTokens: call.cacheReadTokens,
        expectedCachedTokens,
        repaidTokens,
        conversationHash: turn.conversation.toString(16),
        sessionHash: turn.session.toString(16),
      };
      logInfo("prompt_cache_miss", miss);
      const totalKey = `${miss.provider}:${reason}:${miss.isMain}`;
      const total = totals.get(totalKey);
      if (total) {
        total.misses += 1;
        total.repaidTokens += repaidTokens;
      } else {
        totals.set(totalKey, {
          provider: miss.provider,
          reason,
          isMain: miss.isMain,
          misses: 1,
          repaidTokens,
        });
      }
      return miss;
    },

    // Re-paid tokens since this process started, by provider, reason and
    // main turn.
    missTotals: () => ({
      since,
      totals: Array.from(totals.values(), (total) => ({ ...total })),
    }),
  };
};
