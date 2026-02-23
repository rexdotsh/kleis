import type { CodexAccountMetadata } from "../metadata";
import { isObjectRecord } from "../../utils/object";
import CODEX_DEFAULT_INSTRUCTIONS from "../codex-default-instructions.txt";

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
  //   https://github.com/sst/opencode/blob/dev/packages/opencode/src/session/llm.ts#L65-L112
  // - Codex-native clients include `instructions` explicitly in the request body.
  //   https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/providers/openai-codex-responses.ts#L286-L291
  // - Codex-native clients also omit `max_output_tokens` / `max_completion_tokens`.
  //   https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/providers/openai-codex-responses.ts#L286-L315
  const {
    max_output_tokens: _maxOutputTokens,
    max_completion_tokens: _maxCompletionTokens,
    ...nextBody
  } = bodyJson;

  const instructions =
    trimString(nextBody.instructions) || CODEX_DEFAULT_INSTRUCTIONS;

  return JSON.stringify({
    ...nextBody,
    instructions,
  });
};

type CodexProxyPreparationInput = {
  headers: Headers;
  accessToken: string;
  accountId: string | null;
  metadata: CodexAccountMetadata | null;
  bodyText: string;
  bodyJson: unknown;
};

type CodexProxyPreparationResult = {
  upstreamUrl: string;
  bodyText: string;
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
  };
};
