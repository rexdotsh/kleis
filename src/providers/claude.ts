import { z } from "zod";

import {
  consumeOAuthState,
  createOAuthState,
} from "../db/repositories/oauth-states";
import type { ProviderAccountRecord } from "../db/repositories/provider-accounts";
import {
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_REQUIRED_BETA_HEADERS,
  CLAUDE_SYSTEM_IDENTITY,
  CLAUDE_TOOL_PREFIX,
} from "./constants";
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

const claudeStateMetadataSchema = z.strictObject({
  mode: z.enum(["max", "console"]),
  host: z.enum(["claude.ai", "console.anthropic.com", "platform.claude.com"]),
  replaceAccountId: z.string().uuid().optional(),
});

type ClaudeTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  account?: { uuid?: string };
};

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
    let code: string | null = null;
    try {
      const raw: unknown = await response.json();
      if (raw && typeof raw === "object" && "error" in raw) {
        const value = raw.error;
        const candidate =
          typeof value === "string"
            ? value
            : value && typeof value === "object" && "type" in value
              ? value.type
              : null;
        if (
          typeof candidate === "string" &&
          /^(invalid_grant|invalid_client|invalid_scope|rate_limit_error|temporarily_unavailable)$/u.test(
            candidate
          )
        ) {
          code = candidate;
        }
      }
    } catch {
      // Ignore provider text and preserve only an allowlisted OAuth code.
    }
    throw new ClaudeOAuthError(response.status, code);
  }

  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Claude OAuth response is not an object");
  }
  const tokens = value as ClaudeTokenResponse;
  if (
    typeof tokens.access_token !== "string" ||
    !tokens.access_token.trim() ||
    typeof tokens.expires_in !== "number" ||
    !Number.isFinite(tokens.expires_in) ||
    tokens.expires_in <= 60
  ) {
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

const refreshClaudeTokens = async (
  refreshToken: string
): Promise<ClaudeTokenResponse> => {
  const tokens = await requestClaudeTokens({
    grant_type: "refresh_token",
    client_id: CLAUDE_CLIENT_ID,
    refresh_token: refreshToken,
  });
  if (
    typeof tokens.refresh_token !== "string" ||
    !tokens.refresh_token.trim()
  ) {
    throw new Error("Claude refresh response is missing refresh_token");
  }
  return tokens;
};

const buildClaudeMetadata = (input: {
  tokens: ClaudeTokenResponse;
  mode: "max" | "console";
  host: "claude.ai" | "console.anthropic.com" | "platform.claude.com";
  existing: ClaudeAccountMetadata | null;
}): ClaudeAccountMetadata => ({
  provider: "claude",
  tokenType: input.tokens.token_type ?? input.existing?.tokenType ?? null,
  scope: input.tokens.scope ?? input.existing?.scope ?? null,
  oauthMode: input.mode,
  oauthHost: input.host,
  betaHeaders: [...CLAUDE_REQUIRED_BETA_HEADERS],
  userAgent: CLAUDE_CLI_USER_AGENT,
  systemIdentity: CLAUDE_SYSTEM_IDENTITY,
  toolPrefix: CLAUDE_TOOL_PREFIX,
});

const buildTokenResult = (input: {
  tokens: ClaudeTokenResponse;
  mode: "max" | "console";
  host: "claude.ai" | "console.anthropic.com" | "platform.claude.com";
  existing: ClaudeAccountMetadata | null;
  fallbackRefreshToken: string | null;
  fallbackAccountId?: string | null;
}): ProviderTokenResult => {
  const accessToken = input.tokens.access_token;
  if (!accessToken) {
    throw new Error("Claude OAuth response is missing access_token");
  }

  const metadata = buildClaudeMetadata({
    tokens: input.tokens,
    mode: input.mode,
    host: input.host,
    existing: input.existing,
  });
  const refreshToken = input.tokens.refresh_token ?? input.fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error("Claude OAuth response is missing refresh_token");
  }

  return {
    accessToken,
    refreshToken,
    expiresAt:
      Date.now() +
      (input.tokens.expires_in ?? 0) * 1000 -
      CLAUDE_EXPIRY_SKEW_MS,
    accountId:
      input.tokens.account?.uuid?.trim() || input.fallbackAccountId || null,
    metadata,
    label: metadata.oauthMode === "max" ? "claude-max" : "claude-console",
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
