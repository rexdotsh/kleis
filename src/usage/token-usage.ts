import { isObjectRecord } from "../utils/object";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

const toNonNegativeInteger = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.trunc(parsed));
};

const fromUsage = (
  inputTokens: unknown,
  outputTokens: unknown,
  cacheReadTokens: unknown,
  cacheWriteTokens: unknown
): TokenUsage => ({
  inputTokens: toNonNegativeInteger(inputTokens),
  outputTokens: toNonNegativeInteger(outputTokens),
  cacheReadTokens: toNonNegativeInteger(cacheReadTokens),
  cacheWriteTokens: toNonNegativeInteger(cacheWriteTokens),
});

const subtractCachedTokens = (
  inputTokens: number,
  cachedTokens: number
): number => Math.max(0, inputTokens - cachedTokens);

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

export const readAnthropicUsageObject = (usage: unknown): TokenUsage | null => {
  if (!isObjectRecord(usage)) {
    return null;
  }

  return fromUsage(
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens
  );
};

export const readAnthropicUsageFromResponse = (
  responseBody: unknown
): TokenUsage | null => {
  if (!isObjectRecord(responseBody)) {
    return null;
  }

  return readAnthropicUsageObject(responseBody.usage);
};

export const readOpenAiResponsesUsageObject = (
  usage: unknown
): TokenUsage | null => {
  if (!isObjectRecord(usage)) {
    return null;
  }

  const details = isObjectRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : null;
  const cachedTokens = toNonNegativeInteger(details?.cached_tokens);
  const totalInputTokens = toNonNegativeInteger(usage.input_tokens);

  return {
    inputTokens: subtractCachedTokens(totalInputTokens, cachedTokens),
    outputTokens: toNonNegativeInteger(usage.output_tokens),
    cacheReadTokens: cachedTokens,
    cacheWriteTokens: 0,
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
    payload.type !== "response.done"
  ) {
    return null;
  }

  const responseBody = isObjectRecord(payload.response)
    ? payload.response
    : null;
  if (!responseBody) {
    return null;
  }

  return readOpenAiResponsesUsageObject(responseBody.usage);
};

export const readOpenAiChatUsageObject = (
  usage: unknown
): TokenUsage | null => {
  if (!isObjectRecord(usage)) {
    return null;
  }

  const promptDetails = isObjectRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : null;
  const cachedTokens = toNonNegativeInteger(promptDetails?.cached_tokens);
  const totalPromptTokens = toNonNegativeInteger(usage.prompt_tokens);

  return {
    inputTokens: subtractCachedTokens(totalPromptTokens, cachedTokens),
    outputTokens: toNonNegativeInteger(usage.completion_tokens),
    cacheReadTokens: cachedTokens,
    cacheWriteTokens: 0,
  };
};

export const readOpenAiChatUsageFromResponse = (
  responseBody: unknown
): TokenUsage | null => {
  if (!isObjectRecord(responseBody)) {
    return null;
  }

  return readOpenAiChatUsageObject(responseBody.usage);
};

export const readOpenAiChatUsageFromSseEvent = (
  payload: unknown
): TokenUsage | null => {
  if (!isObjectRecord(payload)) {
    return null;
  }

  return readOpenAiChatUsageObject(payload.usage);
};
