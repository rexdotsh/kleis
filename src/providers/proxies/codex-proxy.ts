import type { CodexAccountMetadata } from "../metadata";
import {
  type JsonObject,
  isObjectRecord,
  readBooleanField,
} from "../../utils/object";
import {
  readOpenAiResponsesUsageFromResponse,
  readOpenAiResponsesUsageFromSseEvent,
  type TokenUsage,
} from "../../usage/token-usage";
import CODEX_DEFAULT_INSTRUCTIONS from "../codex-default-instructions.txt";
import { transformOpenAiUsageResponse } from "./openai-usage-response";

import {
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_ORIGINATOR,
  CODEX_RESPONSE_ENDPOINT,
  CODEX_USER_AGENT,
} from "../constants";

const trimString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const readCodexSessionId = (
  body: unknown,
  headers: Headers
): string | null => {
  const bodySessionId = isObjectRecord(body)
    ? trimString(body.prompt_cache_key)
    : "";
  return (
    bodySessionId ||
    trimString(headers.get("session_id")) ||
    trimString(headers.get("session-id")) ||
    trimString(headers.get("x-session-affinity")) ||
    null
  );
};

export const deriveCodexSessionId = async (
  accountKey: string,
  sessionId: string
): Promise<string> => {
  const data = new TextEncoder().encode(`${accountKey}:${sessionId}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `kleis_${toHex(new Uint8Array(digest)).slice(0, 48)}`;
};

export const applyCodexSessionHeaders = (
  headers: Headers,
  sessionId: string
): void => {
  clearCodexSessionHeaders(headers);
  headers.set("session-id", sessionId);
  headers.set("x-client-request-id", sessionId);
};

export const clearCodexSessionHeaders = (headers: Headers): void => {
  headers.delete("session_id");
  headers.delete("session-id");
  headers.delete("x-session-affinity");
  headers.delete("x-client-request-id");
};

export const transformCodexBodyJson = (
  bodyJson: unknown,
  sessionId?: string | null
): JsonObject | null => {
  if (!isObjectRecord(bodyJson)) {
    return null;
  }

  // Codex's chatgpt.com backend endpoint behaves differently from generic OpenAI Responses:
  // - OpenCode only sets top-level `instructions` in native Codex/OAuth mode.
  //   https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/session/llm.ts#L65-L112
  // - Codex-native clients include `instructions` explicitly in the request body.
  //   https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/openai-codex-responses.ts#L286-L291
  // - Codex-native clients also omit `max_output_tokens` / `max_completion_tokens`
  //   and force `store: false`.
  //   https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/openai-codex-responses.ts#L286-L315
  const {
    max_output_tokens: _maxOutputTokens,
    max_completion_tokens: _maxCompletionTokens,
    ...nextBody
  } = bodyJson;

  // OpenCode injects instructions internally in its Codex/OAuth path:
  // https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/session/llm.ts#L110-L112
  // Non-Codex clients won't, so we fall back to OpenCode's default instructions for Codex.
  // https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/session/prompt/codex_header.txt
  const instructions =
    trimString(nextBody.instructions) || CODEX_DEFAULT_INSTRUCTIONS;

  return {
    ...nextBody,
    instructions,
    store: false,
    ...(sessionId ? { prompt_cache_key: sessionId } : {}),
  };
};

const transformCodexResponse = (
  response: Response,
  onTokenUsage: ((usage: TokenUsage) => void) | null | undefined,
  isStreamingRequest: boolean
): Promise<Response> =>
  transformOpenAiUsageResponse({
    response,
    extractSseUsage: readOpenAiResponsesUsageFromSseEvent,
    extractJsonUsage: readOpenAiResponsesUsageFromResponse,
    onTokenUsage,
    isStreamingRequest,
  });

type CodexProxyPreparationInput = {
  headers: Headers;
  accessToken: string;
  accountId: string | null;
  metadata: CodexAccountMetadata | null;
  bodyText: string;
  bodyJson: unknown;
  sessionId?: string | null;
  onTokenUsage?: ((usage: TokenUsage) => void) | null;
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
    readBooleanField(input.bodyJson, "stream") === true;
  const bodyJson = transformCodexBodyJson(input.bodyJson, input.sessionId);

  input.headers.set("authorization", `Bearer ${input.accessToken}`);
  input.headers.set("content-type", "application/json");
  input.headers.set("User-Agent", CODEX_USER_AGENT);
  if (isStreamingRequest) {
    input.headers.set("accept", "text/event-stream");
  }
  if (!input.headers.get("originator")) {
    input.headers.set("originator", CODEX_ORIGINATOR);
  }

  const accountId = input.metadata?.chatgptAccountId ?? input.accountId;
  if (accountId) {
    input.headers.set(CODEX_ACCOUNT_ID_HEADER, accountId);
  }
  clearCodexSessionHeaders(input.headers);
  if (input.sessionId) {
    applyCodexSessionHeaders(input.headers, input.sessionId);
  }

  return {
    upstreamUrl: CODEX_RESPONSE_ENDPOINT,
    bodyJson,
    bodyText: bodyJson ? JSON.stringify(bodyJson) : input.bodyText,
    transformResponse: (response: Response): Promise<Response> =>
      transformCodexResponse(response, input.onTokenUsage, isStreamingRequest),
  };
};
