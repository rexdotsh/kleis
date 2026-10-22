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
  | "unknown";

const MINUTE_MS = 60_000;
// Below this many reusable tokens a drop is too small to report.
const MIN_REUSABLE_TOKENS = 4096;
const MAX_CONVERSATIONS = 5000;
const MAX_RECENT_MISSES = 100;
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration
const CLAUDE_TTL_MS = 5 * MINUTE_MS;
const CLAUDE_LONG_TTL_MS = 60 * MINUTE_MS;
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

export type PromptCacheRequest = {
  conversation: bigint;
  provider: Provider;
  apiKeyId: string;
  model: string;
  ttlMs: number;
};

type ConversationState = {
  providerAccountId: string;
  cachedTokens: number;
  ttlMs: number;
  compacted: boolean;
  at: number;
};

export type PromptCacheTurn = PromptCacheRequest & {
  startedAt: number;
  previous: ConversationState | undefined;
};

export type PromptCacheMiss = {
  at: number;
  provider: Provider;
  apiKeyId: string;
  providerAccountId: string;
  previousProviderAccountId: string;
  model: string;
  reason: PromptCacheMissReason;
  idleMs: number;
  ttlMs: number;
  expiry: "certain" | "possible" | null;
  inputTokens: number;
  cachedTokens: number;
  expectedCachedTokens: number;
  repaidTokens: number;
  conversationHash: string;
};

// Breakpoints sit on the request, system blocks, tools, messages and their
// content blocks.
const hasLongTtl = (value: unknown): boolean =>
  isObjectRecord(value) &&
  ((isObjectRecord(value.cache_control) && value.cache_control.ttl === "1h") ||
    (Array.isArray(value.content) && value.content.some(hasLongTtl)));

const claudeTtlMs = (body: Record<string, unknown>): number =>
  hasLongTtl(body) ||
  [body.system, body.tools, body.messages].some(
    (part) => Array.isArray(part) && part.some(hasLongTtl)
  )
    ? CLAUDE_LONG_TTL_MS
    : CLAUDE_TTL_MS;

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
): unknown => (Array.isArray(items) ? items.find(include) : undefined);

const isCodexTask = (item: unknown): boolean =>
  !(
    isObjectRecord(item) &&
    (item.role === "system" || item.role === "developer")
  );

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

  return {
    conversation: Bun.hash.wyhash(
      JSON.stringify([
        input.apiKeyId,
        provider,
        session,
        input.model,
        claude ? body.system : body.instructions,
        body.tools,
        claude ? firstItem(body.messages) : firstItem(body.input, isCodexTask),
      ])
    ),
    provider,
    apiKeyId: input.apiKeyId,
    model: input.model,
    ttlMs: claude ? claudeTtlMs(body) : codexTtlMs(body),
  };
};

export const createPromptCacheTracker = () => {
  const conversations = new Map<bigint, ConversationState>();
  const misses: PromptCacheMiss[] = [];

  const remember = (key: bigint, state: ConversationState): void => {
    conversations.delete(key);
    conversations.set(key, state);
    if (conversations.size > MAX_CONVERSATIONS) {
      const oldest = conversations.keys().next();
      if (!oldest.done) conversations.delete(oldest.value);
    }
  };

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
    }),

    // Reports a miss when a turn reads under half of what the previous turn
    // left cached.
    observe(
      turn: PromptCacheTurn,
      input: { providerAccountId: string; usage: TokenUsage; now?: number }
    ): PromptCacheMiss | null {
      const now = input.now ?? Date.now();
      const { usage } = input;
      const call = usage.lastCall ?? usage;
      const cachedTokens = call.cacheReadTokens + call.cacheWriteTokens;
      const inputTokens = call.inputTokens + cachedTokens;
      const compacted = usage.compacted === true;
      if (inputTokens >= MIN_REUSABLE_TOKENS) {
        remember(turn.conversation, {
          providerAccountId: input.providerAccountId,
          cachedTokens,
          ttlMs: turn.ttlMs,
          compacted,
          at: now,
        });
      }

      const { previous } = turn;
      const expectedCachedTokens = Math.min(
        previous?.cachedTokens ?? 0,
        inputTokens
      );
      if (
        !previous ||
        expectedCachedTokens < MIN_REUSABLE_TOKENS ||
        call.cacheReadTokens >= expectedCachedTokens / 2
      ) {
        return null;
      }

      const idleMs = turn.startedAt - previous.at;
      let reason: PromptCacheMissReason = "unknown";
      if (previous.providerAccountId !== input.providerAccountId) {
        reason = "account_changed";
      } else if (compacted || previous.compacted) {
        reason = "compacted";
      } else if (idleMs > previous.ttlMs) {
        reason = "idle_expired";
      }
      const miss: PromptCacheMiss = {
        at: now,
        provider: turn.provider,
        apiKeyId: turn.apiKeyId,
        providerAccountId: input.providerAccountId,
        previousProviderAccountId: previous.providerAccountId,
        model: turn.model,
        reason,
        idleMs,
        ttlMs: previous.ttlMs,
        expiry:
          reason !== "idle_expired"
            ? null
            : turn.provider === "claude"
              ? "certain"
              : "possible",
        inputTokens,
        cachedTokens: call.cacheReadTokens,
        expectedCachedTokens,
        repaidTokens: expectedCachedTokens - call.cacheReadTokens,
        conversationHash: turn.conversation.toString(16),
      };
      misses.push(miss);
      if (misses.length > MAX_RECENT_MISSES) misses.shift();
      logInfo("prompt_cache_miss", miss);
      return miss;
    },

    recentMisses: (): PromptCacheMiss[] => [...misses].reverse(),
  };
};
