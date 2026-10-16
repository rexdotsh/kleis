import { z } from "zod";
import { readResponseJson } from "../utils/response-json";

import {
  consumeOAuthState,
  createOAuthState,
} from "../db/repositories/oauth-states";
import type { ProviderAccountRecord } from "../db/repositories/provider-accounts";
import type { ClaudeAccountMetadata } from "./metadata";
import {
  generatePkce,
  generateState,
  parseAuthorizationCodeInput,
} from "./oauth-utils";
import { parseOAuthStateMetadata } from "./oauth-state";
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
const CLAUDE_MIN_TOKEN_LIFETIME_MS = 60_000;

const claudeStateMetadataSchema = z.strictObject({
  mode: z.enum(["max", "console"]),
  host: z.enum(["claude.ai", "console.anthropic.com", "platform.claude.com"]),
  replaceAccountId: z.string().uuid().optional(),
});

type ClaudeTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  account?: { uuid?: unknown; email_address?: unknown };
  organization?: { uuid?: unknown; name?: unknown };
  workspace?: { id?: unknown; name?: unknown };
};

export const CLAUDE_ACCOUNT_ON_HOLD = "account_on_hold";

export class ClaudeOAuthError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(
      `Claude OAuth request failed (HTTP ${status}${code ? `, ${code}` : ""})`
    );
    this.name = "ClaudeOAuthError";
    this.status = status;
    this.code = code;
  }
}

// Only allowlisted codes leave this function; the rest of the provider text is
// dropped. A suspended account is reported only through error_uri.
const readClaudeOAuthErrorCode = (text: string): string | null => {
  if (text.includes(CLAUDE_ACCOUNT_ON_HOLD)) {
    return CLAUDE_ACCOUNT_ON_HOLD;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || !("error" in raw)) {
    return null;
  }
  const value = raw.error;
  const candidate =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "type" in value
        ? value.type
        : null;
  return typeof candidate === "string" &&
    /^(invalid_grant|invalid_client|invalid_scope|rate_limit_error|temporarily_unavailable)$/u.test(
      candidate
    )
    ? candidate
    : null;
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
  if (!response.ok) {
    throw new ClaudeOAuthError(
      response.status,
      readClaudeOAuthErrorCode(await response.text().catch(() => ""))
    );
  }

  const value = await readResponseJson(response, "Claude token response");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claude OAuth response is not an object");
  }
  const tokens = value as ClaudeTokenResponse;
  if (typeof tokens.access_token !== "string" || !tokens.access_token.trim()) {
    throw new Error("Claude OAuth response has invalid token fields");
  }
  return tokens;
};

const exchangeCodeForTokens = async (input: {
  code: string;
  state: string;
  verifier: string;
}): Promise<ClaudeTokenResponse> => {
  const tokens = await requestClaudeTokens({
    code: input.code,
    state: input.state,
    grant_type: "authorization_code",
    client_id: CLAUDE_CLIENT_ID,
    redirect_uri: CLAUDE_REDIRECT_URI,
    code_verifier: input.verifier,
  });
  if (!tokens.refresh_token) {
    throw new Error("Claude OAuth response is missing tokens");
  }
  return tokens;
};

const refreshClaudeTokens = (
  refreshToken: string
): Promise<ClaudeTokenResponse> =>
  requestClaudeTokens({
    grant_type: "refresh_token",
    client_id: CLAUDE_CLIENT_ID,
    refresh_token: refreshToken,
  });

const readText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

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
    accountUuid: readText(tokens.account?.uuid) ?? existing?.accountUuid,
    email: readText(tokens.account?.email_address) ?? existing?.email,
    organizationUuid:
      readText(tokens.organization?.uuid) ?? existing?.organizationUuid,
    organizationName:
      readText(tokens.organization?.name) ?? existing?.organizationName,
    workspaceId: readText(tokens.workspace?.id) ?? existing?.workspaceId,
    workspaceName: readText(tokens.workspace?.name) ?? existing?.workspaceName,
    refreshTokenExpiresAt:
      typeof refreshLifetime === "number" &&
      Number.isFinite(refreshLifetime) &&
      refreshLifetime > 0
        ? now + refreshLifetime * 1000
        : existing?.refreshTokenExpiresAt,
  };
  // Claude Code 2.1.299 keeps the current refresh token when a refresh
  // response omits it, and derives expiry from expires_in without validating it.
  // An unusable expiry gets a short lifetime so a rotated token is still kept.
  const refreshToken =
    readText(input.tokens.refresh_token) ?? input.fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error("Claude OAuth response is missing refresh_token");
  }
  const expiresIn = input.tokens.expires_in;
  const lifetimeMs =
    typeof expiresIn === "number" && Number.isFinite(expiresIn)
      ? expiresIn * 1000
      : 0;

  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt:
      now +
      Math.max(
        lifetimeMs - CLAUDE_EXPIRY_SKEW_MS,
        CLAUDE_MIN_TOKEN_LIFETIME_MS
      ),
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
    if (!input.code) {
      throw new Error("Claude OAuth completion requires a code");
    }

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

    const codeInput = parseAuthorizationCodeInput(
      input.code,
      "Claude OAuth completion requires a code"
    );
    if (codeInput.state && codeInput.state !== input.state) {
      throw new Error("Claude OAuth callback state mismatch");
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
