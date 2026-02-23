import { z } from "zod";

import {
  consumeOAuthState,
  createOAuthState,
} from "../db/repositories/oauth-states";
import type { ProviderAccountRecord } from "../db/repositories/provider-accounts";
import { CODEX_ORIGINATOR, CODEX_REQUEST_PROFILE } from "./constants";
import { requireOkResponse } from "./http";
import type { CodexAccountMetadata } from "./metadata";
import { decodeBase64Url, generatePkce, generateState } from "./oauth-utils";
import { parseOAuthStateMetadata } from "./oauth-state";
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
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

const codexOAuthStateMetadataSchema = z.strictObject({
  redirectUri: z.url(),
});

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

const parseAuthorizationCodeInput = (
  input: string
): { code: string; state?: string } => {
  const value = input.trim();
  if (!value) {
    throw new Error("Codex OAuth completion requires an authorization code");
  }

  try {
    const url = new URL(value);
    const code = url.searchParams.get("code");
    if (code) {
      const state = url.searchParams.get("state");
      if (state) {
        return { code, state };
      }

      return { code };
    }
  } catch {
    // ignore non-url values
  }

  if (value.includes("#")) {
    const split = value.split("#", 2);
    if (split[0]) {
      if (split[1]) {
        return {
          code: split[0],
          state: split[1],
        };
      }

      return {
        code: split[0],
      };
    }
  }

  return { code: value };
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
    originator: CODEX_ORIGINATOR,
  });

  return `${CODEX_AUTHORIZE_URL}?${query.toString()}`;
};

const parseJwtClaims = (token: string): IdTokenClaims | null => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const payloadPart = parts[1];
  if (!payloadPart) {
    return null;
  }

  try {
    const payload = decodeBase64Url(payloadPart);
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

  await requireOkResponse(response, "Codex token exchange failed");

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

  await requireOkResponse(response, "Codex token refresh failed");

  return parseTokenResponse(response);
};

const buildCodexMetadata = (input: {
  tokens: CodexTokenResponse;
  fallbackAccountId: string | null;
  existing: CodexAccountMetadata | null;
}): CodexAccountMetadata => {
  const claims =
    (input.tokens.id_token ? parseJwtClaims(input.tokens.id_token) : null) ??
    (input.tokens.access_token
      ? parseJwtClaims(input.tokens.access_token)
      : null);
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
    requestProfile: CODEX_REQUEST_PROFILE,
  };
};

const buildTokenResult = (input: {
  tokens: CodexTokenResponse;
  now: number;
  fallbackRefreshToken: string | null;
  fallbackAccountId: string | null;
  existingMetadata: CodexAccountMetadata | null;
}): ProviderTokenResult => {
  const accessToken = input.tokens.access_token;
  if (!accessToken) {
    throw new Error("Codex OAuth response is missing access_token");
  }

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
    accessToken,
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
    const redirectUri = CODEX_REDIRECT_URI;

    const pkce = await generatePkce();
    const state = generateState();
    await createOAuthState(input.database, {
      state,
      provider: "codex",
      pkceVerifier: pkce.verifier,
      metadataJson: JSON.stringify({
        redirectUri,
      }),
      expiresAt: input.now + CODEX_OAUTH_STATE_TTL_MS,
    });

    return {
      authorizationUrl: buildAuthorizeUrl({
        redirectUri,
        state,
        challenge: pkce.challenge,
      }),
      state,
      method: "code",
      instructions:
        "After login, paste either the callback code or the full callback URL.",
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

    const stateMetadata = parseOAuthStateMetadata(
      "Codex",
      stateRecord.metadataJson,
      codexOAuthStateMetadataSchema
    );

    if (!stateRecord.pkceVerifier) {
      throw new Error("Codex OAuth state is missing PKCE verifier");
    }

    const codeInput = parseAuthorizationCodeInput(input.code);
    if (codeInput.state && codeInput.state !== input.state) {
      throw new Error("Codex OAuth callback state mismatch");
    }

    const tokens = await exchangeCodeForTokens({
      code: codeInput.code,
      redirectUri: stateMetadata.redirectUri,
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
