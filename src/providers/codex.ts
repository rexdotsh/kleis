import { z } from "zod";

import {
  consumeOAuthState,
  createOAuthState,
  findOAuthState,
} from "../db/repositories/oauth-states";
import type { ProviderAccountRecord } from "../db/repositories/provider-accounts";
import { CODEX_ORIGINATOR } from "./constants";
import { requireOkResponse } from "./http";
import type { CodexAccountMetadata } from "./metadata";
import {
  decodeBase64Url,
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

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;
const CODEX_DEVICE_USER_CODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;
const CODEX_DEVICE_TOKEN_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;
const CODEX_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
const CODEX_POLLING_SAFETY_MARGIN_MS = 3000;

const codexStartOptionsSchema = z.object({
  mode: z.enum(["browser", "headless"]).optional(),
});

const codexOAuthStateMetadataSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("browser"),
    redirectUri: z.url(),
  }),
  z.strictObject({
    mode: z.literal("headless"),
    deviceAuthId: z.string().min(1),
    userCode: z.string().min(1),
    intervalMs: z.number().int().positive(),
  }),
]);

type CodexOAuthStateMetadata = z.infer<typeof codexOAuthStateMetadataSchema>;

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

type CodexDeviceAuthorizationResponse = {
  device_auth_id?: string;
  user_code?: string;
  interval?: string | number;
};

type CodexDeviceTokenResponse = {
  authorization_code?: string;
  code_verifier?: string;
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const resolveCodexOAuthMode = (
  options: Record<string, unknown> | undefined
): "browser" | "headless" => {
  if (!options) {
    return "browser";
  }

  const parsed = codexStartOptionsSchema.safeParse(options);
  if (!parsed.success) {
    return "browser";
  }

  return parsed.data.mode ?? "browser";
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

const exchangeAuthorizationCodeForTokens = async (input: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
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
      code_verifier: input.codeVerifier,
    }).toString(),
  });

  await requireOkResponse(response, "Codex token exchange failed");

  return parseTokenResponse(response);
};

const requestDeviceAuthorization = async (): Promise<{
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}> => {
  const response = await fetch(CODEX_DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
    }),
  });

  await requireOkResponse(response, "Codex device authorization start failed");

  const body = (await response.json()) as CodexDeviceAuthorizationResponse;
  if (!body.device_auth_id || !body.user_code) {
    throw new Error("Codex device authorization response is malformed");
  }

  const rawInterval =
    typeof body.interval === "number"
      ? body.interval
      : Number.parseInt(body.interval ?? "", 10);
  const intervalSeconds =
    Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 5;

  return {
    deviceAuthId: body.device_auth_id,
    userCode: body.user_code,
    intervalMs: intervalSeconds * 1000,
  };
};

const pollDeviceAuthorizationCode = async (input: {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  expiresAt: number;
}): Promise<{ authorizationCode: string; codeVerifier: string }> => {
  while (Date.now() < input.expiresAt) {
    const response = await fetch(CODEX_DEVICE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        device_auth_id: input.deviceAuthId,
        user_code: input.userCode,
      }),
    });

    if (response.ok) {
      const body = (await response.json()) as CodexDeviceTokenResponse;
      if (!body.authorization_code || !body.code_verifier) {
        throw new Error("Codex device authorization response is malformed");
      }

      return {
        authorizationCode: body.authorization_code,
        codeVerifier: body.code_verifier,
      };
    }

    if (response.status === 403 || response.status === 404) {
      await sleep(input.intervalMs + CODEX_POLLING_SAFETY_MARGIN_MS);
      continue;
    }

    await requireOkResponse(response, "Codex device authorization poll failed");
  }

  throw new Error("Codex device authorization timed out");
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
  };
};

const buildFreshOAuthTokenResult = (
  tokens: CodexTokenResponse,
  now: number
): ProviderTokenResult =>
  buildTokenResult({
    tokens,
    now,
    fallbackRefreshToken: null,
    fallbackAccountId: null,
    existingMetadata: null,
  });

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
    const mode = resolveCodexOAuthMode(input.options);
    const state = generateState();

    if (mode === "headless") {
      const deviceAuth = await requestDeviceAuthorization();
      await createOAuthState(input.database, {
        state,
        provider: "codex",
        pkceVerifier: null,
        metadataJson: JSON.stringify({
          mode,
          deviceAuthId: deviceAuth.deviceAuthId,
          userCode: deviceAuth.userCode,
          intervalMs: deviceAuth.intervalMs,
        }),
        expiresAt: input.now + CODEX_OAUTH_STATE_TTL_MS,
      });

      return {
        authorizationUrl: `${CODEX_ISSUER}/codex/device`,
        state,
        method: "auto",
        instructions: `Enter code: ${deviceAuth.userCode}`,
      };
    }

    const redirectUri = CODEX_REDIRECT_URI;
    const pkce = await generatePkce();
    await createOAuthState(input.database, {
      state,
      provider: "codex",
      pkceVerifier: pkce.verifier,
      metadataJson: JSON.stringify({
        mode,
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
    const pendingState = await findOAuthState(
      input.database,
      input.state,
      "codex",
      input.now
    );
    if (!pendingState) {
      throw new Error("Codex OAuth state is missing or expired");
    }

    const metadata: CodexOAuthStateMetadata = parseOAuthStateMetadata(
      "Codex",
      pendingState.metadataJson,
      codexOAuthStateMetadataSchema
    );
    if (metadata.mode === "headless") {
      const deviceAuthorization = await pollDeviceAuthorizationCode({
        deviceAuthId: metadata.deviceAuthId,
        userCode: metadata.userCode,
        intervalMs: metadata.intervalMs,
        expiresAt: pendingState.expiresAt,
      });

      const completedAt = Date.now();

      const consumedState = await consumeOAuthState(
        input.database,
        input.state,
        "codex",
        completedAt
      );
      if (!consumedState) {
        throw new Error("Codex OAuth state is missing or expired");
      }

      const tokens = await exchangeAuthorizationCodeForTokens({
        code: deviceAuthorization.authorizationCode,
        redirectUri: CODEX_DEVICE_REDIRECT_URI,
        codeVerifier: deviceAuthorization.codeVerifier,
      });

      return buildFreshOAuthTokenResult(tokens, completedAt);
    }

    const browserCode = input.code;
    if (!browserCode) {
      throw new Error("Codex OAuth completion requires an authorization code");
    }

    const codeInput = parseAuthorizationCodeInput(
      browserCode,
      "Codex OAuth completion requires an authorization code"
    );
    if (codeInput.state && codeInput.state !== input.state) {
      throw new Error("Codex OAuth callback state mismatch");
    }

    const completedAt = Date.now();

    const stateRecord = await consumeOAuthState(
      input.database,
      input.state,
      "codex",
      completedAt
    );
    if (!stateRecord) {
      throw new Error("Codex OAuth state is missing or expired");
    }

    if (!stateRecord.pkceVerifier) {
      throw new Error("Codex OAuth state is missing PKCE verifier");
    }

    const tokens = await exchangeAuthorizationCodeForTokens({
      code: codeInput.code,
      redirectUri: metadata.redirectUri,
      codeVerifier: stateRecord.pkceVerifier,
    });

    return buildFreshOAuthTokenResult(tokens, completedAt);
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
