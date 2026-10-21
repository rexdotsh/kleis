import type { CodexAccountMetadata } from "../metadata";
import {
  type JsonObject,
  isObjectRecord,
  readBooleanField,
} from "../../utils/object";
import {
  readOpenAiResponsesUsageFromResponse,
  type TokenUsage,
} from "../../usage/token-usage";
import CODEX_DEFAULT_INSTRUCTIONS from "../codex-default-instructions.txt";
import { createOpenAiSseUsagePassthrough } from "./openai-sse-passthrough";
import {
  isEventStreamResponse,
  passthroughProxyResponse,
  transformJsonResponse,
} from "./response";

import {
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_BETA_FEATURES,
  CODEX_BETA_FEATURES_HEADER,
  CODEX_COMPACTION_ENDPOINT,
  CODEX_ORIGINATOR,
  CODEX_RESPONSE_ENDPOINT,
  CODEX_USER_AGENT,
} from "../constants";
import type { ProxyOperation } from "../proxy-endpoints";

const trimString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const readCodexPromptCacheKey = (body: unknown): string | null =>
  (isObjectRecord(body) && trimString(body.prompt_cache_key)) || null;

export const readCodexSessionId = (
  body: unknown,
  headers: Headers
): string | null =>
  trimString(headers.get("session_id")) ||
  trimString(headers.get("session-id")) ||
  trimString(headers.get("x-session-affinity")) ||
  readCodexPromptCacheKey(body);

export const namespaceCodexKey = async (
  accountKey: string,
  key: string
): Promise<string> => {
  const data = new TextEncoder().encode(`${accountKey}:${key}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `kleis_${toHex(new Uint8Array(digest)).slice(0, 48)}`;
};

export const applyCodexSessionHeaders = (
  headers: Headers,
  sessionId: string
): void => {
  clearCodexSessionHeaders(headers);
  headers.set("session-id", sessionId);
  headers.set("x-session-affinity", sessionId);
  headers.set("x-session-id", sessionId);
};

export const clearCodexSessionHeaders = (headers: Headers): void => {
  headers.delete("session_id");
  headers.delete("session-id");
  headers.delete("x-session-affinity");
  headers.delete("x-session-id");
};

export const mergeHeaderValue = (
  headers: Headers,
  name: string,
  value: string
): void => {
  const values = (headers.get(name) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!values.includes(value)) {
    values.push(value);
  }
  headers.set(name, values.join(","));
};

export const transformCodexBodyJson = (
  bodyJson: unknown,
  promptCacheKey?: string | null
): JsonObject | null => {
  if (!isObjectRecord(bodyJson)) {
    return null;
  }

  // ChatGPT rejects output limits and requires instructions and stateless storage.
  // https://github.com/anomalyco/opencode/blob/d9987ef9c896383eb47b9103f6c93fa772a44b83/packages/core/src/plugin/provider/openai.ts#L311-L317
  const {
    max_completion_tokens: _maxCompletionTokens,
    max_output_tokens: _maxOutputTokens,
    ...body
  } = bodyJson;

  const incomingInstructions = trimString(body.instructions);
  const input = Array.isArray(body.input) ? body.input : [];
  const firstInput = input[0];
  const promotedInstructions =
    !incomingInstructions &&
    isObjectRecord(firstInput) &&
    (firstInput.role === "system" || firstInput.role === "developer")
      ? trimString(firstInput.content)
      : "";
  const instructions =
    incomingInstructions || promotedInstructions || CODEX_DEFAULT_INSTRUCTIONS;

  return {
    ...body,
    ...(promotedInstructions ? { input: input.slice(1) } : {}),
    instructions,
    store: false,
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
  };
};

const transformCodexCompactionBodyJson = (
  bodyJson: unknown,
  promptCacheKey?: string | null
): JsonObject | null => {
  if (!isObjectRecord(bodyJson)) {
    return null;
  }

  // https://github.com/anomalyco/opencode/blob/c3712e0c7a2d7f8d288f8b9875ae026146910a4c/packages/ai/src/protocols/utils/responses-compaction.ts#L93-L103
  const allowedFields = [
    "model",
    "input",
    "instructions",
    "previous_response_id",
    "service_tier",
    "reasoning",
    "text",
    "include",
    "parallel_tool_calls",
    "tools",
    "prompt_cache_key",
    "prompt_cache_retention",
    "prompt_cache_options",
  ] as const;
  const compactBody: JsonObject = {};
  for (const field of allowedFields) {
    if (field in bodyJson) {
      compactBody[field] = bodyJson[field];
    }
  }

  if (promptCacheKey) {
    compactBody.prompt_cache_key = promptCacheKey;
  }
  return compactBody;
};

const transformCodexResponse = async (
  response: Response,
  onTokenUsage: ((usage: TokenUsage) => void) | null | undefined,
  isStreamingRequest: boolean,
  providerAccountId: string | undefined,
  onStreamEnd: ((statusCode: number) => void) | null | undefined
): Promise<Response> => {
  if (!response.body) {
    return response;
  }
  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  // Codex can omit content-type on successful SSE responses.
  if (
    isEventStreamResponse(response) ||
    (isStreamingRequest && response.ok && !contentType)
  ) {
    return createOpenAiSseUsagePassthrough({
      response,
      providerAccountId,
      onTokenUsage,
      onStreamEnd,
    });
  }
  if (isStreamingRequest && !contentType.includes("application/json")) {
    return passthroughProxyResponse(response);
  }

  return transformJsonResponse({
    response,
    readUsage: readOpenAiResponsesUsageFromResponse,
    onTokenUsage,
  });
};

// The ChatGPT backend rejects uncompressed bodies over about 1 MiB.
// https://github.com/openai/codex/blob/d138398cef7d49e46fe33f1d0ddbd2ca0ed16aa4/codex-rs/core/src/client.rs#L1769-L1777
const CODEX_ZSTD_MIN_BODY_LENGTH = 256 * 1024;

export const encodeCodexRequestBody = (
  headers: Headers,
  bodyText: string,
  clientSentZstd: boolean
): BodyInit => {
  if (!clientSentZstd && bodyText.length < CODEX_ZSTD_MIN_BODY_LENGTH) {
    return bodyText;
  }
  headers.set("content-encoding", "zstd");
  return Bun.zstdCompressSync(bodyText) as Uint8Array<ArrayBuffer>;
};

type CodexProxyPreparationInput = {
  operation?: ProxyOperation;
  headers: Headers;
  accessToken: string;
  accountId: string | null;
  providerAccountId?: string;
  metadata: CodexAccountMetadata | null;
  bodyText: string;
  bodyJson: unknown;
  sessionId?: string | null;
  promptCacheKey?: string | null;
  onTokenUsage?: ((usage: TokenUsage) => void) | null;
  onStreamEnd?: ((statusCode: number) => void) | null;
};

type CodexProxyPreparationResult = {
  upstreamUrl: string;
  bodyText: string;
  bodyJson: JsonObject | null;
  transformResponse(response: Response): Promise<Response>;
};

export const prepareCodexProxyRequest = (
  input: CodexProxyPreparationInput
): CodexProxyPreparationResult => {
  const isStreamingRequest =
    input.operation !== "compact" &&
    readBooleanField(input.bodyJson, "stream") === true;
  const bodyJson =
    input.operation === "compact"
      ? transformCodexCompactionBodyJson(input.bodyJson, input.promptCacheKey)
      : transformCodexBodyJson(input.bodyJson, input.promptCacheKey);

  input.headers.set("authorization", `Bearer ${input.accessToken}`);
  input.headers.set("content-type", "application/json");
  if (!input.headers.get("user-agent")) {
    input.headers.set("user-agent", CODEX_USER_AGENT);
  }
  mergeHeaderValue(
    input.headers,
    CODEX_BETA_FEATURES_HEADER,
    CODEX_BETA_FEATURES
  );
  if (isStreamingRequest) {
    input.headers.set("accept", "text/event-stream");
  } else if (input.operation === "compact") {
    input.headers.set("accept", "application/json");
  }
  if (!input.headers.get("originator")) {
    input.headers.set("originator", CODEX_ORIGINATOR);
  }

  const accountId =
    trimString(input.metadata?.chatgptAccountId) || trimString(input.accountId);
  input.headers.delete(CODEX_ACCOUNT_ID_HEADER);
  if (accountId) {
    input.headers.set(CODEX_ACCOUNT_ID_HEADER, accountId);
  }
  if (input.sessionId) {
    applyCodexSessionHeaders(input.headers, input.sessionId);
  } else {
    clearCodexSessionHeaders(input.headers);
  }

  return {
    upstreamUrl:
      input.operation === "compact"
        ? CODEX_COMPACTION_ENDPOINT
        : CODEX_RESPONSE_ENDPOINT,
    bodyJson,
    bodyText: bodyJson ? JSON.stringify(bodyJson) : input.bodyText,
    transformResponse: (response: Response): Promise<Response> =>
      transformCodexResponse(
        response,
        input.onTokenUsage,
        isStreamingRequest,
        input.providerAccountId,
        input.onStreamEnd
      ),
  };
};
