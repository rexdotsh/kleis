import type { CodexAccountMetadata } from "./metadata";

const DEFAULT_CODEX_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_ACCOUNT_ID_HEADER = "ChatGPT-Account-Id";

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
      input.metadata?.requestProfile.accountIdHeader ??
        DEFAULT_ACCOUNT_ID_HEADER,
      accountId
    );
  }

  return {
    upstreamUrl:
      input.metadata?.requestProfile.endpoint ?? DEFAULT_CODEX_ENDPOINT,
  };
};
