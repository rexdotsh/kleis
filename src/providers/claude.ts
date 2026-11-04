import { z } from "zod";

import {
  consumeOAuthState,
  createOAuthState,
} from "../db/repositories/oauth-states";
import type { ClaudeAccountMetadata } from "./metadata";
import {
  generatePkce,
  generateState,
  readOAuthCallbackCode,
} from "./oauth-utils";
import { parseOAuthStateMetadata } from "./oauth-state";
import { requireOkResponse } from "./http";
import {
  readOAuthText,
  readOAuthTokenResponse,
  type OAuthTokenResponse,
} from "./oauth-tokens";
import type {
  ProviderAdapter,
  ProviderOAuthCompleteInput,
  ProviderOAuthStartInput,
  ProviderOAuthStartResult,
  ProviderTokenResult,
} from "./types";

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
// The scope and lifetime `claude setup-token` asks for, plus user:profile so
// the limits and plan can be read.
const CLAUDE_SCOPE = "user:profile user:inference";
const CLAUDE_SIGN_IN_LIFETIME_SECONDS = 365 * 24 * 60 * 60;
// Anthropic could cap the lifetime without failing the exchange; a short
// sign-in would quietly stop working, since Kleis never refreshes Claude.
const CLAUDE_MIN_SIGN_IN_LIFETIME_SECONDS = 300 * 24 * 60 * 60;
const CLAUDE_STATE_TTL_MS = 15 * 60 * 1000;
const CLAUDE_TOKEN_TIMEOUT_MS = 15_000;
const CLAUDE_EXPIRY_SKEW_MS = 60_000;

const claudeStateMetadataSchema = z.strictObject({
  replaceAccountId: z.string().uuid().optional(),
});

type ClaudeTokenResponse = OAuthTokenResponse & {
  account?: { uuid?: unknown; email_address?: unknown };
  organization?: { uuid?: unknown; name?: unknown };
  workspace?: { id?: unknown; name?: unknown };
};

const exchangeCodeForTokens = async (input: {
  code: string;
  state: string;
  verifier: string;
}): Promise<ClaudeTokenResponse> => {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: CLAUDE_REDIRECT_URI,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: input.verifier,
      state: input.state,
      expires_in: CLAUDE_SIGN_IN_LIFETIME_SECONDS,
    }),
    signal: AbortSignal.timeout(CLAUDE_TOKEN_TIMEOUT_MS),
    redirect: "error",
  });
  await requireOkResponse(response, "Claude OAuth request failed");
  return readOAuthTokenResponse<ClaudeTokenResponse>(response, "Claude");
};

const readSignInExpiry = (tokens: ClaudeTokenResponse, now: number): number => {
  const expiresIn = tokens.expires_in;
  if (
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn < CLAUDE_MIN_SIGN_IN_LIFETIME_SECONDS
  ) {
    const granted =
      typeof expiresIn === "number" && Number.isFinite(expiresIn)
        ? `${Math.floor(expiresIn / 86_400)} days`
        : "no expiry";
    throw new Error(
      `Claude granted a sign-in of ${granted} instead of one year, so the account was not saved. Start the sign-in again.`
    );
  }
  return now + expiresIn * 1000 - CLAUDE_EXPIRY_SKEW_MS;
};

// The refresh token is dropped: refreshing replaces the year-long access
// token with an 8-hour one and revokes the old token.
const buildTokenResult = (
  tokens: ClaudeTokenResponse,
  now: number
): ProviderTokenResult => {
  const metadata: ClaudeAccountMetadata = {
    provider: "claude",
    scope: tokens.scope ?? null,
    accountUuid: readOAuthText(tokens.account?.uuid),
    email: readOAuthText(tokens.account?.email_address),
    organizationUuid: readOAuthText(tokens.organization?.uuid),
    organizationName: readOAuthText(tokens.organization?.name),
    workspaceId: readOAuthText(tokens.workspace?.id),
    workspaceName: readOAuthText(tokens.workspace?.name),
  };
  return {
    accessToken: tokens.access_token,
    refreshToken: null,
    expiresAt: readSignInExpiry(tokens, now),
    // A Claude user UUID is shared across organizations, so it cannot be the
    // unique provider account identity in our schema.
    accountId: null,
    metadata,
    label: metadata.email ?? "claude-account",
  };
};

export const claudeAdapter: ProviderAdapter = {
  provider: "claude",
  async startOAuth(
    input: ProviderOAuthStartInput
  ): Promise<ProviderOAuthStartResult> {
    const pkce = await generatePkce();
    const state = generateState();

    await createOAuthState(input.database, {
      state,
      provider: "claude",
      pkceVerifier: pkce.verifier,
      metadataJson: JSON.stringify(
        typeof input.options?.replaceAccountId === "string"
          ? { replaceAccountId: input.options.replaceAccountId }
          : {}
      ),
      expiresAt: input.now + CLAUDE_STATE_TTL_MS,
    });

    const query = new URLSearchParams({
      code: "true",
      client_id: CLAUDE_CLIENT_ID,
      response_type: "code",
      redirect_uri: CLAUDE_REDIRECT_URI,
      scope: CLAUDE_SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
    });

    return {
      authorizationUrl: `${CLAUDE_AUTHORIZE_URL}?${query.toString()}`,
      state,
      method: "code",
      instructions:
        "Complete login and submit the returned authorization code.",
    };
  },
  async completeOAuth(
    input: ProviderOAuthCompleteInput
  ): Promise<ProviderTokenResult> {
    const codeInput = readOAuthCallbackCode(input, "Claude");
    const stateRecord = await consumeOAuthState(
      input.database,
      input.state,
      "claude",
      input.now
    );
    if (!stateRecord) {
      throw new Error("Claude OAuth state is missing or expired");
    }

    const stateMetadata = parseOAuthStateMetadata(
      "Claude",
      stateRecord.metadataJson,
      claudeStateMetadataSchema
    );

    if (!stateRecord.pkceVerifier) {
      throw new Error("Claude OAuth state is missing PKCE verifier");
    }

    const tokens = await exchangeCodeForTokens({
      code: codeInput.code,
      state: codeInput.state ?? input.state,
      verifier: stateRecord.pkceVerifier,
    });

    return {
      ...buildTokenResult(tokens, Date.now()),
      ...(stateMetadata.replaceAccountId
        ? { replaceAccountId: stateMetadata.replaceAccountId }
        : {}),
    };
  },
};
