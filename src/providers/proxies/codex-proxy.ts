import type { CodexAccountMetadata } from "../metadata";

import { CODEX_ACCOUNT_ID_HEADER, CODEX_RESPONSE_ENDPOINT } from "../constants";

export type CodexProxyPreparationInput = {
  headers: Headers;
  accessToken: string;
  fallbackAccountId: string | null;
  metadata: CodexAccountMetadata | null;
};

export type CodexProxyPreparationResult = {
  upstreamUrl: string;
};

export const prepareCodexProxyRequest = (
  input: CodexProxyPreparationInput
): CodexProxyPreparationResult => {
  input.headers.set("authorization", `Bearer ${input.accessToken}`);

  const accountId = input.metadata?.chatgptAccountId ?? input.fallbackAccountId;
  if (accountId) {
    input.headers.set(
      input.metadata?.requestProfile.accountIdHeader ?? CODEX_ACCOUNT_ID_HEADER,
      accountId
    );
  }

  return {
    upstreamUrl:
      input.metadata?.requestProfile.endpoint ?? CODEX_RESPONSE_ENDPOINT,
  };
};
