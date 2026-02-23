import { z } from "zod";

import {
  consumeOAuthState,
  createOAuthState,
} from "../db/repositories/oauth-states";
import type { ProviderAccountRecord } from "../db/repositories/provider-accounts";
import type { CodexAccountMetadata } from "./metadata";
import type {
  ProviderAdapter,
  ProviderOAuthCompleteInput,
  ProviderOAuthStartInput,
  ProviderOAuthStartResult,
  ProviderTokenResult,
} from "./types";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
const CODEX_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

const codexOAuthStateMetadataSchema = z
  .object({
    redirectUri: z.string().url(),
  })
  .strict();

type CodexTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  id_token?: string;
};

type IdTokenClaims = {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
};

const encodeBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded =
    padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
  return atob(padded);
};

const generateState = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return encodeBase64Url(bytes);
};

const generatePkce = async (): Promise<{
  verifier: string;
  challenge: string;
}> => {
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return {
    verifier,
    challenge: encodeBase64Url(new Uint8Array(digest)),
  };
};

const buildAuthorizeUrl = (input: {
  redirectUri: string;
  state: string;
  challenge: string;
}): string => {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: input.state,
    originator: "opencode",
  });

  return `${CODEX_AUTHORIZE_URL}?${query.toString()}`;
};

const parseJwtClaims = (token: string): IdTokenClaims | null => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const payload = decodeBase64Url(parts[1] ?? "");
    return JSON.parse(payload) as IdTokenClaims;
  } catch {
    return null;
  }
};

const extractAccountIdFromClaims = (
  claims: IdTokenClaims | null
): string | null => {
  if (!claims) {
    return null;
  }

  if (claims.chatgpt_account_id) {
    return claims.chatgpt_account_id;
  }

  if (claims["https://api.openai.com/auth"]?.chatgpt_account_id) {
    return claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
  }

  if (claims.organizations?.[0]?.id) {
    return claims.organizations[0].id;
  }

  return null;
};

const parseTokenResponse = async (
  response: Response
): Promise<CodexTokenResponse> => {
  const body = (await response.json()) as CodexTokenResponse;
  if (!body.access_token) {
    throw new Error("Codex OAuth response is missing access_token");
  }

  return body;
};

const exchangeCodeForTokens = async (input: {
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<CodexTokenResponse> => {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: CODEX_CLIENT_ID,
      code_verifier: input.verifier,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Codex token exchange failed (${response.status}): ${errorText}`
    );
  }

  return parseTokenResponse(response);
};

const refreshCodexTokens = async (
  refreshToken: string
): Promise<CodexTokenResponse> => {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Codex token refresh failed (${response.status}): ${errorText}`
    );
  }

  return parseTokenResponse(response);
};

const buildCodexMetadata = (input: {
  tokens: CodexTokenResponse;
  fallbackAccountId: string | null;
  existing: CodexAccountMetadata | null;
}): CodexAccountMetadata => {
  const claims =
    parseJwtClaims(input.tokens.id_token ?? "") ??
    parseJwtClaims(input.tokens.access_token ?? "");
  const chatgptAccountId =
    extractAccountIdFromClaims(claims) ??
    input.fallbackAccountId ??
    input.existing?.chatgptAccountId ??
    null;
  const organizationIds =
    claims?.organizations?.map((organization) => organization.id) ?? [];

  return {
    provider: "codex",
    tokenType: input.tokens.token_type ?? input.existing?.tokenType ?? null,
    scope: input.tokens.scope ?? input.existing?.scope ?? null,
    idToken: input.tokens.id_token ?? input.existing?.idToken ?? null,
    chatgptAccountId,
    organizationIds:
      organizationIds.length > 0
        ? organizationIds
        : (input.existing?.organizationIds ?? []),
    email: claims?.email ?? input.existing?.email ?? null,
    requestProfile: {
      originator: "opencode",
      accountIdHeader: "ChatGPT-Account-Id",
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
    },
  };
};

const buildTokenResult = (input: {
  tokens: CodexTokenResponse;
  now: number;
  fallbackRefreshToken: string | null;
  fallbackAccountId: string | null;
  existingMetadata: CodexAccountMetadata | null;
}): ProviderTokenResult => {
  const metadata = buildCodexMetadata({
    tokens: input.tokens,
    fallbackAccountId: input.fallbackAccountId,
    existing: input.existingMetadata,
  });
  const accountId = metadata.chatgptAccountId;
  const expiresAt = input.now + (input.tokens.expires_in ?? 3600) * 1000;
  const refreshToken = input.tokens.refresh_token ?? input.fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error("Codex OAuth response is missing refresh_token");
  }

  return {
    accessToken: input.tokens.access_token ?? "",
    refreshToken,
    expiresAt,
    accountId,
    metadata,
    label:
      metadata.email ?? (accountId ? `chatgpt:${accountId}` : "codex-account"),
  };
};

export const codexAdapter: ProviderAdapter = {
  provider: "codex",
  async startOAuth(
    input: ProviderOAuthStartInput
  ): Promise<ProviderOAuthStartResult> {
    const pkce = await generatePkce();
    const state = generateState();
    await createOAuthState(input.database, {
      state,
      provider: "codex",
      pkceVerifier: pkce.verifier,
      metadataJson: JSON.stringify({
        redirectUri: input.redirectUri,
      }),
      expiresAt: input.now + CODEX_OAUTH_STATE_TTL_MS,
      createdAt: input.now,
    });

    return {
      authorizationUrl: buildAuthorizeUrl({
        redirectUri: input.redirectUri,
        state,
        challenge: pkce.challenge,
      }),
      state,
      method: "code",
      instructions:
        "After completing login, pass the callback code into oauth/complete.",
    };
  },
  async completeOAuth(
    input: ProviderOAuthCompleteInput
  ): Promise<ProviderTokenResult> {
    if (!input.code) {
      throw new Error("Codex OAuth completion requires an authorization code");
    }

    const stateRecord = await consumeOAuthState(
      input.database,
      input.state,
      "codex",
      input.now
    );
    if (!stateRecord) {
      throw new Error("Codex OAuth state is missing or expired");
    }

    let stateMetadata: unknown = {};
    if (stateRecord.metadataJson) {
      try {
        stateMetadata = JSON.parse(stateRecord.metadataJson);
      } catch {
        throw new Error("Codex OAuth state metadata is malformed");
      }
    }

    const metadataResult =
      codexOAuthStateMetadataSchema.safeParse(stateMetadata);
    if (!metadataResult.success) {
      throw new Error("Codex OAuth state metadata is invalid");
    }

    if (!stateRecord.pkceVerifier) {
      throw new Error("Codex OAuth state is missing PKCE verifier");
    }

    const tokens = await exchangeCodeForTokens({
      code: input.code,
      redirectUri: metadataResult.data.redirectUri,
      verifier: stateRecord.pkceVerifier,
    });

    return buildTokenResult({
      tokens,
      now: input.now,
      fallbackRefreshToken: null,
      fallbackAccountId: null,
      existingMetadata: null,
    });
  },
  async refreshAccount(
    account: ProviderAccountRecord,
    now: number
  ): Promise<ProviderTokenResult> {
    const tokens = await refreshCodexTokens(account.refreshToken);
    const existingMetadata =
      account.metadata?.provider === "codex" ? account.metadata : null;
    return buildTokenResult({
      tokens,
      now,
      fallbackRefreshToken: account.refreshToken,
      fallbackAccountId: account.accountId,
      existingMetadata,
    });
  },
};
