import { z } from "zod";
import { readResponseJson } from "../utils/response-json";

import {
  consumeOAuthState,
  createOAuthState,
  findOAuthState,
} from "../db/repositories/oauth-states";
import type { ProviderAccountRecord } from "../db/repositories/provider-accounts";
import { CODEX_ORIGINATOR } from "./constants";
import { readOAuthErrorCode, requireOkResponse } from "./http";
import type { CodexAccountMetadata } from "./metadata";
import {
  decodeBase64Url,
  generatePkce,
  generateState,
  readOAuthCallbackCode,
} from "./oauth-utils";
import { parseOAuthStateMetadata } from "./oauth-state";
import { oauthOwnerSchema } from "../domain/owners";
import {
  buildOAuthTokenFields,
  readOAuthText,
  readOAuthTokenResponse,
  type OAuthTokenResponse,
} from "./oauth-tokens";
import { sleep } from "../utils/sleep";
import { toMillisecondsTimestamp } from "../utils/timestamp";
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
const CODEX_SLOW_DOWN_INCREMENT_MS = 5000;

const codexStartOptionsSchema = z.object({
  mode: z.enum(["browser", "headless"]).optional(),
});

const codexOAuthStateMetadataSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("browser"),
    redirectUri: z.url(),
    replaceAccountId: z.string().uuid().optional(),
    owner: oauthOwnerSchema.optional(),
  }),
  z.strictObject({
    mode: z.literal("headless"),
    deviceAuthId: z.string().min(1),
    userCode: z.string().min(1),
    intervalMs: z.number().int().positive(),
    replaceAccountId: z.string().uuid().optional(),
    owner: oauthOwnerSchema.optional(),
  }),
]);

type CodexTokenResponse = OAuthTokenResponse & {
  id_token?: string;
};

type IdTokenClaims = {
  chatgpt_account_id?: string;
  email?: string;
  "https://api.openai.com/profile"?: { email?: unknown };
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_user_id?: unknown;
    user_id?: unknown;
    chatgpt_plan_type?: unknown;
    chatgpt_subscription_active_start?: unknown;
    chatgpt_subscription_active_until?: unknown;
    chatgpt_subscription_last_checked?: unknown;
    chatgpt_account_is_fedramp?: unknown;
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

const resolveCodexOAuthMode = (
  options: Record<string, unknown> | undefined
): "browser" | "headless" => {
  const parsed = codexStartOptionsSchema.safeParse(options);
  return parsed.success ? (parsed.data.mode ?? "browser") : "browser";
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
): string | null =>
  claims?.chatgpt_account_id ||
  claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ||
  null;

const waitForCodexDevicePoll = async (input: {
  intervalMs: number;
  expiresAt: number;
}): Promise<void> => {
  const remainingMs = input.expiresAt - Date.now();
  if (remainingMs <= 0) {
    return;
  }
  await sleep(
    Math.min(input.intervalMs + CODEX_POLLING_SAFETY_MARGIN_MS, remainingMs)
  );
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

  return readOAuthTokenResponse<CodexTokenResponse>(response, "Codex");
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

  const body = (await readResponseJson(
    response,
    "Codex device authorization response"
  )) as CodexDeviceAuthorizationResponse;
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
  let intervalMs = input.intervalMs;
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
      const body = (await readResponseJson(
        response,
        "Codex device token response"
      )) as CodexDeviceTokenResponse;
      if (!body.authorization_code || !body.code_verifier) {
        throw new Error("Codex device authorization response is malformed");
      }

      return {
        authorizationCode: body.authorization_code,
        codeVerifier: body.code_verifier,
      };
    }

    const errorCode = await readOAuthErrorCode(response);
    if (errorCode === "slow_down") {
      intervalMs += CODEX_SLOW_DOWN_INCREMENT_MS;
    }
    if (
      errorCode === "slow_down" ||
      errorCode === "deviceauth_authorization_pending" ||
      response.status === 403 ||
      response.status === 404
    ) {
      await waitForCodexDevicePoll({ intervalMs, expiresAt: input.expiresAt });
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
    signal: AbortSignal.timeout(15_000),
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

  return readOAuthTokenResponse<CodexTokenResponse>(response, "Codex");
};

// Subscription claims arrive as ISO strings or epoch seconds.
const readClaimTimestamp = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return toMillisecondsTimestamp(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const buildCodexMetadata = (
  tokens: CodexTokenResponse,
  account?: ProviderAccountRecord
): CodexAccountMetadata => {
  const existing =
    account?.metadata?.provider === "codex" ? account.metadata : null;
  const claims =
    (tokens.id_token ? parseJwtClaims(tokens.id_token) : null) ??
    parseJwtClaims(tokens.access_token);
  const chatgptAccountId =
    extractAccountIdFromClaims(claims) ??
    account?.accountId ??
    existing?.chatgptAccountId ??
    null;
  const auth = claims?.["https://api.openai.com/auth"];
  return {
    provider: "codex",
    scope: tokens.scope ?? existing?.scope ?? null,
    chatgptAccountId,
    email:
      readOAuthText(claims?.email) ??
      readOAuthText(claims?.["https://api.openai.com/profile"]?.email) ??
      existing?.email ??
      null,
    chatgptUserId:
      readOAuthText(auth?.chatgpt_user_id) ??
      readOAuthText(auth?.user_id) ??
      existing?.chatgptUserId,
    planTypeClaim:
      readOAuthText(auth?.chatgpt_plan_type) ?? existing?.planTypeClaim,
    subscriptionActiveStart:
      readClaimTimestamp(auth?.chatgpt_subscription_active_start) ??
      existing?.subscriptionActiveStart,
    subscriptionActiveUntil:
      readClaimTimestamp(auth?.chatgpt_subscription_active_until) ??
      existing?.subscriptionActiveUntil,
    subscriptionLastChecked:
      readClaimTimestamp(auth?.chatgpt_subscription_last_checked) ??
      existing?.subscriptionLastChecked,
    isFedramp:
      typeof auth?.chatgpt_account_is_fedramp === "boolean"
        ? auth.chatgpt_account_is_fedramp
        : existing?.isFedramp,
  };
};

const buildTokenResult = (
  tokens: CodexTokenResponse,
  now: number,
  account?: ProviderAccountRecord
): ProviderTokenResult => {
  const metadata = buildCodexMetadata(tokens, account);
  const accountId = metadata.chatgptAccountId;
  return {
    ...buildOAuthTokenFields("Codex", tokens, {
      now,
      fallbackRefreshToken: account?.refreshToken ?? null,
      defaultExpiresIn: 3600,
    }),
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
    const replaceAccountId = input.options?.replaceAccountId;
    const target = {
      ...(typeof replaceAccountId === "string" ? { replaceAccountId } : {}),
      ...(input.owner ? { owner: input.owner } : {}),
    };

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
          ...target,
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
        ...target,
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

    const metadata = parseOAuthStateMetadata(
      "Codex",
      pendingState.metadataJson,
      codexOAuthStateMetadataSchema
    );
    let code: string;
    let deviceVerifier: string | null = null;
    if (metadata.mode === "headless") {
      const deviceAuthorization = await pollDeviceAuthorizationCode({
        deviceAuthId: metadata.deviceAuthId,
        userCode: metadata.userCode,
        intervalMs: metadata.intervalMs,
        expiresAt: pendingState.expiresAt,
      });

      code = deviceAuthorization.authorizationCode;
      deviceVerifier = deviceAuthorization.codeVerifier;
    } else {
      code = readOAuthCallbackCode(input, "Codex").code;
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

    const codeVerifier = deviceVerifier ?? stateRecord.pkceVerifier;
    if (!codeVerifier) {
      throw new Error("Codex OAuth state is missing PKCE verifier");
    }

    const tokens = await exchangeAuthorizationCodeForTokens({
      code,
      redirectUri:
        metadata.mode === "headless"
          ? CODEX_DEVICE_REDIRECT_URI
          : metadata.redirectUri,
      codeVerifier,
    });

    return {
      ...buildTokenResult(tokens, completedAt),
      ...(metadata.replaceAccountId
        ? { replaceAccountId: metadata.replaceAccountId }
        : {}),
      ...(metadata.owner ? { owner: metadata.owner } : {}),
    };
  },
  async refreshAccount(
    account: ProviderAccountRecord,
    now: number
  ): Promise<ProviderTokenResult> {
    const tokens = await refreshCodexTokens(account.refreshToken);
    return buildTokenResult(tokens, now, account);
  },
};
