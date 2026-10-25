import { constants as zlibConstants, unzipSync } from "node:zlib";

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
import { OAuthError, requireOkResponse } from "./http";
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
// Claude Code 2.1.310 refreshes inference grants with these scopes plus
// user:plugins (GAt()), using axios 1.15.2's default headers.
const CLAUDE_REFRESH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const;
const CLAUDE_PLUGINS_SCOPE = "user:plugins";
const CLAUDE_TOKEN_USER_AGENT = "axios/1.15.2";
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

// Bun leaves `compress` bodies encoded; axios inflates them with zlib unzip.
const decodeCompressedBody = async (response: Response): Promise<Response> => {
  const encoding = response.headers.get("content-encoding")?.toLowerCase();
  if (encoding !== "compress" && encoding !== "x-compress") {
    return response;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(
    bytes.byteLength > 0
      ? unzipSync(bytes, {
          flush: zlibConstants.Z_SYNC_FLUSH,
          finishFlush: zlibConstants.Z_SYNC_FLUSH,
        })
      : bytes,
    { status: response.status, statusText: response.statusText, headers }
  );
};

const requestClaudeTokens = async (
  body: Record<string, string>
): Promise<ClaudeTokenResponse> => {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": CLAUDE_TOKEN_USER_AGENT,
      "Accept-Encoding": "gzip, compress, deflate, br",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CLAUDE_TOKEN_TIMEOUT_MS),
    redirect: "error",
  });
  const decoded = await decodeCompressedBody(response);
  await requireOkResponse(decoded, "Claude OAuth request failed");
  return readOAuthTokenResponse<ClaudeTokenResponse>(decoded, "Claude");
};

const exchangeCodeForTokens = async (input: {
  code: string;
  state: string;
  verifier: string;
}): Promise<ClaudeTokenResponse> => {
  return requestClaudeTokens({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: CLAUDE_REDIRECT_URI,
    client_id: CLAUDE_CLIENT_ID,
    code_verifier: input.verifier,
    state: input.state,
  });
};

// Without a stored grant that covers Claude Code's scopes, scope is omitted so
// the refresh keeps the original grant.
const readRefreshScope = (grantedScope: string | null): string | null => {
  const granted = new Set(grantedScope?.split(/\s+/));
  if (!CLAUDE_REFRESH_SCOPES.every((scope) => granted.has(scope))) {
    return null;
  }
  return [
    ...CLAUDE_REFRESH_SCOPES,
    ...(granted.has(CLAUDE_PLUGINS_SCOPE) ? [CLAUDE_PLUGINS_SCOPE] : []),
  ].join(" ");
};

const refreshClaudeTokens = async (
  refreshToken: string,
  grantedScope: string | null
): Promise<ClaudeTokenResponse> => {
  const body = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLAUDE_CLIENT_ID,
  };
  const scope = readRefreshScope(grantedScope);
  if (!scope) {
    return requestClaudeTokens(body);
  }
  try {
    return await requestClaudeTokens({ ...body, scope });
  } catch (error) {
    // Claude Code retries the same refresh token after invalid_scope.
    if (
      !(error instanceof OAuthError) ||
      error.status !== 400 ||
      error.code !== "invalid_scope"
    ) {
      throw error;
    }
    return requestClaudeTokens(body);
  }
};

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
    const tokens = await refreshClaudeTokens(
      account.refreshToken,
      existing?.scope ?? null
    );

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
