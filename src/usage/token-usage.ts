import { toNonNegativeInteger } from "../utils/number";
import { isObjectRecord } from "../utils/object";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  totalTokens?: number;
};

export const isTokenUsagePopulated = (
  usage: TokenUsage | null
): usage is TokenUsage =>
  Boolean(
    usage &&
    (usage.inputTokens > 0 ||
      usage.outputTokens > 0 ||
      usage.cacheReadTokens > 0 ||
      usage.cacheWriteTokens > 0)
  );

// The top-level fields cover only the message iterations; usage.iterations
// also lists server-side compaction calls, so its sum is the billed total.
// https://platform.claude.com/docs/en/build-with-claude/compaction-threshold#understanding-usage
export const readAnthropicUsageToken = (
  usage: Record<string, unknown>,
  field: string,
  fallback = 0
): number => {
  const value = usage[field];
  const topLevel =
    value === null || value === undefined
      ? fallback
      : toNonNegativeInteger(value);
  if (!Array.isArray(usage.iterations)) {
    return topLevel;
  }

  let iterationsTotal = 0;
  for (const iteration of usage.iterations) {
    if (isObjectRecord(iteration)) {
      iterationsTotal += toNonNegativeInteger(iteration[field]);
    }
  }
  return Math.max(topLevel, iterationsTotal);
};

export const readAnthropicUsageObject = (usage: unknown): TokenUsage | null => {
  if (!isObjectRecord(usage)) {
    return null;
  }

  return {
    inputTokens: readAnthropicUsageToken(usage, "input_tokens"),
    outputTokens: readAnthropicUsageToken(usage, "output_tokens"),
    cacheReadTokens: readAnthropicUsageToken(usage, "cache_read_input_tokens"),
    cacheWriteTokens: readAnthropicUsageToken(
      usage,
      "cache_creation_input_tokens"
    ),
  };
};

export const readAnthropicUsageFromResponse = (
  responseBody: unknown
): TokenUsage | null => {
  if (!isObjectRecord(responseBody)) {
    return null;
  }

  return readAnthropicUsageObject(responseBody.usage);
};

const readOpenAiResponsesUsageObject = (usage: unknown): TokenUsage | null => {
  if (!isObjectRecord(usage)) {
    return null;
  }

  const details = isObjectRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : null;
  const cachedTokens = toNonNegativeInteger(details?.cached_tokens);
  const cacheWriteTokens = toNonNegativeInteger(details?.cache_write_tokens);
  const totalInputTokens = toNonNegativeInteger(usage.input_tokens);
  const outputDetails = isObjectRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : null;

  return {
    inputTokens: Math.max(
      0,
      totalInputTokens - cachedTokens - cacheWriteTokens
    ),
    outputTokens: toNonNegativeInteger(usage.output_tokens),
    cacheReadTokens: cachedTokens,
    cacheWriteTokens,
    ...(typeof outputDetails?.reasoning_tokens === "number" &&
    Number.isFinite(outputDetails.reasoning_tokens)
      ? {
          reasoningTokens: toNonNegativeInteger(outputDetails.reasoning_tokens),
        }
      : {}),
    ...(typeof usage.total_tokens === "number" &&
    Number.isFinite(usage.total_tokens)
      ? { totalTokens: toNonNegativeInteger(usage.total_tokens) }
      : {}),
  };
};

export const readOpenAiResponsesUsageFromResponse = (
  responseBody: unknown
): TokenUsage | null => {
  if (!isObjectRecord(responseBody)) {
    return null;
  }

  return readOpenAiResponsesUsageObject(responseBody.usage);
};

export const readOpenAiResponsesUsageFromSseEvent = (
  payload: unknown
): TokenUsage | null => {
  if (!isObjectRecord(payload)) {
    return null;
  }

  if (
    payload.type !== "response.completed" &&
    payload.type !== "response.done" &&
    payload.type !== "response.incomplete" &&
    payload.type !== "response.failed"
  ) {
    return null;
  }

  return readOpenAiResponsesUsageFromResponse(payload.response);
};
