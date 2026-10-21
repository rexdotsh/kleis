import type { Provider } from "../db/schema";
import type { ProxyOperation } from "../providers/proxy-endpoints";
import { logInfo } from "../utils/log";
import { isObjectRecord } from "../utils/object";
import type { TokenUsage } from "./token-usage";

export type PromptCacheMissReason =
  | "account_changed"
  | "model_changed"
  | "prefix_changed"
  | "idle_expired"
  | "compacted"
  | "first_request_after_restart"
  | "unknown";

type PrefixPart = "system" | "tools" | "messages" | "instructions" | "input";

const MINUTE_MS = 60_000;
// Below this many reusable tokens a drop is too small to report.
const MIN_REUSABLE_TOKENS = 4096;
const MAX_CONVERSATIONS = 5000;
const MAX_RECENT_MISSES = 100;
// Without state, only requests this soon after start count as misses.
const RESTART_WINDOW_MS = 60 * MINUTE_MS;
const HEAD_ITEMS = 2;
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

export type PromptCacheRequest = {
  conversation: bigint;
  provider: Provider;
  // Hashes in the provider's cache order; the last covers the first turns.
  parts: readonly [PrefixPart, PrefixPart, PrefixPart];
  prefix: readonly [bigint, bigint, bigint];
  ttlMs: number;
  compaction: boolean;
  compactedHead: boolean;
  hasHistory: boolean;
};

export type PromptCacheMiss = {
  at: number;
  provider: Provider;
  apiKeyId: string;
  providerAccountId: string;
  previousProviderAccountId: string | null;
  model: string;
  previousModel: string | null;
  reason: PromptCacheMissReason;
  changed: PrefixPart[];
  idleMs: number | null;
  ttlMs: number;
  expiry: "certain" | "possible" | null;
  inputTokens: number;
  cachedTokens: number;
  expectedCachedTokens: number;
  repaidTokens: number;
  conversationHash: string;
};

type ConversationState = {
  providerAccountId: string;
  model: string;
  prefix: PromptCacheRequest["prefix"];
  inputTokens: number;
  cachedTokens: number;
  ttlMs: number;
  compaction: boolean;
  at: number;
};

const hashText = (text: string | undefined): bigint =>
  Bun.hash.wyhash(text ?? "");

// cache_control moves between turns without changing the cached prefix.
const CACHE_CONTROL = /,"cache_control":\{[^}]*\}|"cache_control":\{[^}]*\},?/g;

const conversationKey = (
  apiKeyId: string,
  provider: Provider,
  session: string
): bigint => hashText(`${apiKeyId}\u0000${provider}\u0000${session}`);

const readHeaderText = (headers: Headers, name: string): string =>
  headers.get(name)?.trim() ?? "";

// Claude Code 2.1.86+ and OpenCode send a session header; older Claude Code
// only embeds the session in metadata.user_id.
// https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#2186
// https://github.com/anomalyco/opencode/blob/a517687fde98a7329ada3ae644a01a9fc6c4e99e/packages/core/src/session/model-request.ts#L282-L291
const readClaudeSession = (body: Record<string, unknown>, headers: Headers) =>
  readHeaderText(headers, "x-claude-code-session-id") ||
  readHeaderText(headers, "x-opencode-session-id") ||
  readHeaderText(headers, "x-session-affinity") ||
  readHeaderText(headers, "x-session-id") ||
  (isObjectRecord(body.metadata) && typeof body.metadata.user_id === "string"
    ? body.metadata.user_id.trim()
    : "");

export const readClaudePromptCacheRequest = (
  apiKeyId: string,
  body: unknown,
  headers: Headers
): PromptCacheRequest | null => {
  if (!isObjectRecord(body)) {
    return null;
  }
  const session = readClaudeSession(body, headers);
  if (!session) {
    return null;
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  let longTtl =
    isObjectRecord(body.cache_control) && body.cache_control.ttl === "1h";
  const hashPart = (value: unknown): bigint => {
    const text = JSON.stringify(value);
    if (text?.includes('"ttl":"1h"')) {
      longTtl = true;
    }
    return hashText(text?.replace(CACHE_CONTROL, ""));
  };
  const head = messages.slice(0, HEAD_ITEMS);
  const firstContent = isObjectRecord(head[0]) ? head[0].content : null;
  return {
    conversation: conversationKey(apiKeyId, "claude", session),
    provider: "claude",
    parts: ["tools", "system", "messages"],
    prefix: [hashPart(body.tools), hashPart(body.system), hashPart(head)],
    ttlMs: longTtl ? CLAUDE_LONG_TTL_MS : CLAUDE_TTL_MS,
    compaction: isObjectRecord(body.compaction),
    compactedHead:
      Array.isArray(firstContent) &&
      isObjectRecord(firstContent[0]) &&
      firstContent[0].type === "compaction",
    hasHistory: messages.length > 1,
  };
};

const isCodexHistoryItem = (item: unknown): boolean =>
  isObjectRecord(item) &&
  (item.role === "assistant" ||
    (typeof item.type === "string" && item.type !== "message"));

export const readCodexPromptCacheRequest = (
  apiKeyId: string,
  body: unknown,
  session: string | null,
  operation?: ProxyOperation
): PromptCacheRequest | null => {
  if (!(session && isObjectRecord(body))) {
    return null;
  }

  const input = Array.isArray(body.input) ? body.input : [];
  const head = input.slice(0, HEAD_ITEMS);
  const ttl = isObjectRecord(body.prompt_cache_options)
    ? body.prompt_cache_options.ttl
    : body.prompt_cache_retention;
  return {
    conversation: conversationKey(apiKeyId, "codex", session),
    provider: "codex",
    parts: ["instructions", "tools", "input"],
    prefix: [
      hashText(
        typeof body.instructions === "string" ? body.instructions : undefined
      ),
      hashText(JSON.stringify(body.tools)),
      hashText(JSON.stringify(head)),
    ],
    ttlMs:
      (typeof ttl === "string" ? CODEX_TTL_MS[ttl] : undefined) ??
      CODEX_DEFAULT_TTL_MS,
    compaction: operation === "compact",
    compactedHead: head.some(
      (item) =>
        isObjectRecord(item) &&
        (item.type === "compaction" || item.type === "compaction_summary")
    ),
    hasHistory: input.some(isCodexHistoryItem),
  };
};

const explainMiss = (
  previous: ConversationState | undefined,
  request: PromptCacheRequest,
  providerAccountId: string,
  model: string,
  now: number
): { reason: PromptCacheMissReason; changed: PrefixPart[] } => {
  if (!previous) {
    return { reason: "first_request_after_restart", changed: [] };
  }
  if (previous.providerAccountId !== providerAccountId) {
    return { reason: "account_changed", changed: [] };
  }
  if (previous.model !== model) {
    return { reason: "model_changed", changed: [] };
  }
  const changed = request.parts.filter(
    (_, index) => previous.prefix[index] !== request.prefix[index]
  );
  const headChanged = previous.prefix[2] !== request.prefix[2];
  if (previous.compaction || (request.compactedHead && headChanged)) {
    return { reason: "compacted", changed: [] };
  }
  if (changed.length) {
    return { reason: "prefix_changed", changed };
  }
  return {
    reason: now - previous.at > previous.ttlMs ? "idle_expired" : "unknown",
    changed: [],
  };
};

export const createPromptCacheTracker = (startedAt = Date.now()) => {
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
    // Compares a finished request with the previous turn of its conversation
    // and reports a miss when it read under half of the cached prefix.
    observe(
      request: PromptCacheRequest,
      input: {
        apiKeyId: string;
        providerAccountId: string;
        model: string;
        usage: TokenUsage;
        now?: number;
      }
    ): PromptCacheMiss | null {
      const now = input.now ?? Date.now();
      const { usage } = input;
      const inputTokens =
        usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      const previous = conversations.get(request.conversation);
      const expectedCachedTokens = previous
        ? Math.min(previous.cachedTokens, inputTokens)
        : request.hasHistory && now - startedAt < RESTART_WINDOW_MS
          ? inputTokens
          : 0;

      if (inputTokens >= MIN_REUSABLE_TOKENS) {
        remember(request.conversation, {
          providerAccountId: input.providerAccountId,
          model: input.model,
          prefix: request.prefix,
          inputTokens,
          cachedTokens: usage.cacheReadTokens + usage.cacheWriteTokens,
          ttlMs: request.ttlMs,
          compaction: request.compaction,
          at: now,
        });
      }
      if (
        expectedCachedTokens < MIN_REUSABLE_TOKENS ||
        usage.cacheReadTokens >= expectedCachedTokens / 2
      ) {
        return null;
      }

      const explained = explainMiss(
        previous,
        request,
        input.providerAccountId,
        input.model,
        now
      );
      const miss: PromptCacheMiss = {
        at: now,
        provider: request.provider,
        apiKeyId: input.apiKeyId,
        providerAccountId: input.providerAccountId,
        previousProviderAccountId: previous?.providerAccountId ?? null,
        model: input.model,
        previousModel: previous?.model ?? null,
        ...explained,
        expiry:
          explained.reason !== "idle_expired"
            ? null
            : request.provider === "claude"
              ? "certain"
              : "possible",
        idleMs: previous ? now - previous.at : null,
        ttlMs: previous?.ttlMs ?? request.ttlMs,
        inputTokens,
        cachedTokens: usage.cacheReadTokens,
        expectedCachedTokens,
        repaidTokens: expectedCachedTokens - usage.cacheReadTokens,
        conversationHash: request.conversation.toString(16),
      };
      misses.push(miss);
      if (misses.length > MAX_RECENT_MISSES) misses.shift();
      logInfo("prompt_cache_miss", {
        ...miss,
        prefixHashes: request.prefix.map((hash) => hash.toString(16)),
        previousPrefixHashes:
          previous?.prefix.map((hash) => hash.toString(16)) ?? null,
        previousInputTokens: previous?.inputTokens ?? null,
        previousCachedTokens: previous?.cachedTokens ?? null,
      });
      return miss;
    },
    recentMisses: (): PromptCacheMiss[] => [...misses].reverse(),
  };
};
