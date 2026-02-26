import type { CodexAccountMetadata } from "../metadata";
import { isObjectRecord } from "../../utils/object";
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
} from "../constants";

const trimString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const transformCodexBody = (bodyJson: unknown, bodyText: string): string => {
  if (!isObjectRecord(bodyJson)) {
    return bodyText;
  }

  // Codex's chatgpt.com backend endpoint behaves differently from generic OpenAI Responses:
  // - OpenCode only sets top-level `instructions` in native Codex/OAuth mode.
  //   https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/session/llm.ts#L65-L112
  // - Codex-native clients include `instructions` explicitly in the request body.
  //   https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/openai-codex-responses.ts#L286-L291
  // - Codex-native clients also omit `max_output_tokens` / `max_completion_tokens`.
  //   https://github.com/badlogic/pi-mono/blob/5c0ec26c28c918c5301f218e8c13fcc540d8e3a4/packages/ai/src/providers/openai-codex-responses.ts#L286-L315
  const {
    max_output_tokens: _maxOutputTokens,
    max_completion_tokens: _maxCompletionTokens,
    ...nextBody
  } = bodyJson;

  // OpenCode injects instructions internally in its Codex/OAuth path:
  // https://github.com/anomalyco/opencode/blob/d848c9b6a32f408e8b9bf6448b83af05629454d0/packages/opencode/src/session/llm.ts#L110-L112
  // Non-Codex clients won't — fall back to the default Codex system prompt.
  const instructions =
    trimString(nextBody.instructions) || CODEX_DEFAULT_INSTRUCTIONS;

  return JSON.stringify({
    ...nextBody,
    instructions,
  });
};

const transformCodexResponse = (
  response: Response,
  onTokenUsage?: ((usage: TokenUsage) => void) | null
): Promise<Response> =>
  transformOpenAiUsageResponse({
    response,
    extractSseUsage: readOpenAiResponsesUsageFromSseEvent,
    extractJsonUsage: readOpenAiResponsesUsageFromResponse,
    onTokenUsage,
  });

type CodexProxyPreparationInput = {
  headers: Headers;
  accessToken: string;
  accountId: string | null;
  metadata: CodexAccountMetadata | null;
  bodyText: string;
  bodyJson: unknown;
  onTokenUsage?: ((usage: TokenUsage) => void) | null;
};

type CodexProxyPreparationResult = {
  upstreamUrl: string;
  bodyText: string;
  transformResponse(response: Response): Promise<Response>;
};

export const prepareCodexProxyRequest = (
  input: CodexProxyPreparationInput
): CodexProxyPreparationResult => {
  input.headers.set("authorization", `Bearer ${input.accessToken}`);
  if (!input.headers.get("originator")) {
    input.headers.set("originator", CODEX_ORIGINATOR);
  }

  const accountId = input.metadata?.chatgptAccountId ?? input.accountId;
  if (accountId) {
    input.headers.set(CODEX_ACCOUNT_ID_HEADER, accountId);
  }

  return {
    upstreamUrl: CODEX_RESPONSE_ENDPOINT,
    bodyText: transformCodexBody(input.bodyJson, input.bodyText),
    transformResponse: (response: Response): Promise<Response> =>
      transformCodexResponse(response, input.onTokenUsage),
  };
};
