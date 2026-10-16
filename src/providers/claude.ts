import { z } from "zod";

import {
  consumeOAuthState,
  createOAuthState,
} from "../db/repositories/oauth-states";
import type { ProviderAccountRecord } from "../db/repositories/provider-accounts";
import type { ClaudeAccountMetadata } from "./metadata";
import {
  generatePkce,
  generateState,
  readOAuthCallbackCode,
} from "./oauth-utils";
import { parseOAuthStateMetadata } from "./oauth-state";
import { requireOkResponse } from "./http";
import {
  buildOAuthTokenFields,
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
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_SCOPE =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CLAUDE_STATE_TTL_MS = 15 * 60 * 1000;
const CLAUDE_TOKEN_TIMEOUT_MS = 15_000;
const CLAUDE_EXPIRY_SKEW_MS = 60_000;

const claudeStateMetadataSchema = z.strictObject({
  mode: z.enum(["max", "console"]),
  host: z.enum(["claude.ai", "console.anthropic.com", "platform.claude.com"]),
  replaceAccountId: z.string().uuid().optional(),
});

type ClaudeTokenResponse = OAuthTokenResponse & {
  refresh_token_expires_in?: number;
  account?: { uuid?: unknown; email_address?: unknown };
  organization?: { uuid?: unknown; name?: unknown };
  workspace?: { id?: unknown; name?: unknown };
};

const requestClaudeTokens = async (
  body: Record<string, string>
): Promise<ClaudeTokenResponse> => {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CLAUDE_TOKEN_TIMEOUT_MS),
    redirect: "error",
  });
  await requireOkResponse(response, "Claude OAuth request failed");
  return readOAuthTokenResponse<ClaudeTokenResponse>(response, "Claude");
};

const exchangeCodeForTokens = async (input: {
  code: string;
  state: string;
  verifier: string;
}): Promise<ClaudeTokenResponse> => {
  return requestClaudeTokens({
    code: input.code,
    state: input.state,
    grant_type: "authorization_code",
    client_id: CLAUDE_CLIENT_ID,
    redirect_uri: CLAUDE_REDIRECT_URI,
    code_verifier: input.verifier,
  });
};

const refreshClaudeTokens = (
  refreshToken: string
): Promise<ClaudeTokenResponse> =>
  requestClaudeTokens({
    grant_type: "refresh_token",
    client_id: CLAUDE_CLIENT_ID,
    refresh_token: refreshToken,
  });

const buildTokenResult = (input: {
  tokens: ClaudeTokenResponse;
  mode: "max" | "console";
  host: "claude.ai" | "console.anthropic.com" | "platform.claude.com";
  existing: ClaudeAccountMetadata | null;
  fallbackRefreshToken: string | null;
  fallbackAccountId?: string | null;
}): ProviderTokenResult => {
  const { tokens, existing } = input;
  const now = Date.now();
  const refreshLifetime = tokens.refresh_token_expires_in;
  // Refresh responses may omit identity fields without erasing known values.
  const metadata: ClaudeAccountMetadata = {
    provider: "claude",
    scope: tokens.scope ?? existing?.scope ?? null,
    oauthMode: input.mode,
    oauthHost: input.host,
    accountUuid: readOAuthText(tokens.account?.uuid) ?? existing?.accountUuid,
    email: readOAuthText(tokens.account?.email_address) ?? existing?.email,
    organizationUuid:
      readOAuthText(tokens.organization?.uuid) ?? existing?.organizationUuid,
    organizationName:
      readOAuthText(tokens.organization?.name) ?? existing?.organizationName,
    workspaceId: readOAuthText(tokens.workspace?.id) ?? existing?.workspaceId,
    workspaceName:
      readOAuthText(tokens.workspace?.name) ?? existing?.workspaceName,
    refreshTokenExpiresAt:
      typeof refreshLifetime === "number" &&
      Number.isFinite(refreshLifetime) &&
      refreshLifetime > 0
        ? now + refreshLifetime * 1000
        : existing?.refreshTokenExpiresAt,
  };
  return {
    ...buildOAuthTokenFields("Claude", tokens, {
      now,
      fallbackRefreshToken: input.fallbackRefreshToken,
      expirySkewMs: CLAUDE_EXPIRY_SKEW_MS,
      minimumLifetimeMs: 60_000,
    }),
    // A Claude user UUID is shared across Max/Console and organizations. It
    // cannot be used as the unique provider account identity in our schema.
    accountId: input.fallbackAccountId || null,
    metadata,
    label:
      metadata.email ??
      (metadata.oauthMode === "max" ? "claude-max" : "claude-console"),
  };
};

export const claudeAdapter: ProviderAdapter = {
  provider: "claude",
  async startOAuth(
    input: ProviderOAuthStartInput
  ): Promise<ProviderOAuthStartResult> {
    const mode = input.options?.mode === "console" ? "console" : "max";
    const host = mode === "console" ? "platform.claude.com" : "claude.ai";
    const pkce = await generatePkce();
    const state = generateState();

    await createOAuthState(input.database, {
      state,
      provider: "claude",
      pkceVerifier: pkce.verifier,
      metadataJson: JSON.stringify({
        mode,
        host,
        ...(typeof input.options?.replaceAccountId === "string"
          ? { replaceAccountId: input.options.replaceAccountId }
          : {}),
      }),
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
      authorizationUrl: `https://${host}/oauth/authorize?${query.toString()}`,
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
      ...buildTokenResult({
        tokens,
        mode: stateMetadata.mode,
        host: stateMetadata.host,
        existing: null,
        fallbackRefreshToken: null,
      }),
      ...(stateMetadata.replaceAccountId
        ? { replaceAccountId: stateMetadata.replaceAccountId }
        : {}),
    };
  },
  async refreshAccount(
    account: ProviderAccountRecord,
    _now: number
  ): Promise<ProviderTokenResult> {
    const existing =
      account.metadata?.provider === "claude" ? account.metadata : null;
    const tokens = await refreshClaudeTokens(account.refreshToken);

    return buildTokenResult({
      tokens,
      mode: existing?.oauthMode ?? "max",
      host: existing?.oauthHost ?? "claude.ai",
      existing,
      fallbackRefreshToken: account.refreshToken,
      fallbackAccountId: account.accountId,
    });
  },
};
