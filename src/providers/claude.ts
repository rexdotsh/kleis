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
import { requireOkResponse } from "./http";
import type { ClaudeAccountMetadata } from "./metadata";
import { generatePkce, generateState } from "./oauth-utils";
import { parseOAuthStateMetadata } from "./oauth-state";
import type {
  ProviderAdapter,
  ProviderOAuthCompleteInput,
  ProviderOAuthStartInput,
  ProviderOAuthStartResult,
  ProviderTokenResult,
} from "./types";

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const CLAUDE_SCOPE = "org:create_api_key user:profile user:inference";
const CLAUDE_STATE_TTL_MS = 15 * 60 * 1000;

const claudeStateMetadataSchema = z.strictObject({
  mode: z.enum(["max", "console"]),
  host: z.enum(["claude.ai", "console.anthropic.com"]),
});

type ClaudeTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
};

const parseAuthorizationCodeInput = (
  input: string
): { code: string; state?: string } => {
  const value = input.trim();
  if (!value) {
    throw new Error("Claude OAuth completion requires a code");
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

const exchangeCodeForTokens = async (input: {
  code: string;
  state: string;
  verifier: string;
}): Promise<ClaudeTokenResponse> => {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: input.code,
      state: input.state,
      grant_type: "authorization_code",
      client_id: CLAUDE_CLIENT_ID,
      redirect_uri: CLAUDE_REDIRECT_URI,
      code_verifier: input.verifier,
    }),
  });

  await requireOkResponse(response, "Claude token exchange failed");

  const body = (await response.json()) as ClaudeTokenResponse;
  if (!body.access_token || !body.refresh_token) {
    throw new Error("Claude OAuth response is missing tokens");
  }

  return body;
};

const refreshClaudeTokens = async (
  refreshToken: string
): Promise<ClaudeTokenResponse> => {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLAUDE_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  await requireOkResponse(response, "Claude token refresh failed");

  const body = (await response.json()) as ClaudeTokenResponse;
  if (!body.access_token || !body.refresh_token) {
    throw new Error("Claude refresh response is missing tokens");
  }

  return body;
};

const buildClaudeMetadata = (input: {
  tokens: ClaudeTokenResponse;
  mode: "max" | "console";
  host: "claude.ai" | "console.anthropic.com";
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
  now: number;
  mode: "max" | "console";
  host: "claude.ai" | "console.anthropic.com";
  existing: ClaudeAccountMetadata | null;
  fallbackRefreshToken: string | null;
}): ProviderTokenResult => {
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
    accessToken: input.tokens.access_token ?? "",
    refreshToken,
    expiresAt: input.now + (input.tokens.expires_in ?? 3600) * 1000,
    accountId: null,
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
    const host = mode === "console" ? "console.anthropic.com" : "claude.ai";
    const pkce = await generatePkce();
    const state = generateState();

    await createOAuthState(input.database, {
      state,
      provider: "claude",
      pkceVerifier: pkce.verifier,
      metadataJson: JSON.stringify({
        mode,
        host,
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

    const codeInput = parseAuthorizationCodeInput(input.code);
    if (codeInput.state && codeInput.state !== input.state) {
      throw new Error("Claude OAuth callback state mismatch");
    }

    const tokens = await exchangeCodeForTokens({
      code: codeInput.code,
      state: codeInput.state ?? input.state,
      verifier: stateRecord.pkceVerifier,
    });

    return buildTokenResult({
      tokens,
      now: input.now,
      mode: stateMetadata.mode,
      host: stateMetadata.host,
      existing: null,
      fallbackRefreshToken: null,
    });
  },
  async refreshAccount(
    account: ProviderAccountRecord,
    now: number
  ): Promise<ProviderTokenResult> {
    const existing =
      account.metadata?.provider === "claude" ? account.metadata : null;
    const tokens = await refreshClaudeTokens(account.refreshToken);

    return buildTokenResult({
      tokens,
      now,
      mode: existing?.oauthMode ?? "max",
      host: existing?.oauthHost ?? "claude.ai",
      existing,
      fallbackRefreshToken: account.refreshToken,
    });
  },
};
