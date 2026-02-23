import { z } from "zod";

import {
  deleteOAuthState,
  findOAuthState,
  createOAuthState,
} from "../db/repositories/oauth-states";
import type { ProviderAccountRecord } from "../db/repositories/provider-accounts";
import type { CopilotAccountMetadata } from "./metadata";
import type {
  ProviderAdapter,
  ProviderOAuthCompleteInput,
  ProviderOAuthStartInput,
  ProviderOAuthStartResult,
  ProviderTokenResult,
} from "./types";

const COPILOT_CLIENT_ID = "Ov23li8tweQw6odWQebz";
const POLLING_SAFETY_MARGIN_MS = 3000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

const copilotHeaders = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
} as const;

const copilotStateMetadataSchema = z
  .object({
    domain: z.string().min(1),
    enterpriseDomain: z.string().nullable(),
    deviceCode: z.string().min(1),
    interval: z.number().int().positive(),
    expiresIn: z.number().int().positive(),
  })
  .strict();

type DeviceCodeResponse = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  interval?: number;
  expires_in?: number;
};

type DeviceTokenResponse = {
  access_token?: string;
  error?: string;
  interval?: number;
};

type CopilotTokenResponse = {
  token?: string;
  expires_at?: number;
  refresh_in?: number;
};

type GithubUserResponse = {
  id?: number;
  login?: string;
  email?: string;
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const normalizeDomain = (input: string): string | null => {
  const value = input.trim();
  if (!value) {
    return null;
  }

  try {
    const url = value.includes("://")
      ? new URL(value)
      : new URL(`https://${value}`);
    return url.hostname;
  } catch {
    return null;
  }
};

const resolveCopilotUrls = (domain: string) => ({
  deviceCodeUrl: `https://${domain}/login/device/code`,
  accessTokenUrl: `https://${domain}/login/oauth/access_token`,
  copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
  userUrl: `https://api.${domain}/user`,
});

const generateState = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const parseCopilotApiBaseUrl = (token: string): string | null => {
  const proxyMatch = token.match(/proxy-ep=([^;]+)/);
  if (!proxyMatch?.[1]) {
    return null;
  }

  const apiHost = proxyMatch[1].replace(/^proxy\./, "api.");
  return `https://${apiHost}`;
};

const requestDeviceCode = async (
  domain: string
): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}> => {
  const urls = resolveCopilotUrls(domain);
  const response = await fetch(urls.deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "GitHubCopilotChat/0.35.0",
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Copilot device flow start failed (${response.status}): ${errorText}`
    );
  }

  const body = (await response.json()) as DeviceCodeResponse;
  if (
    !body.device_code ||
    !body.user_code ||
    !body.verification_uri ||
    typeof body.interval !== "number" ||
    typeof body.expires_in !== "number"
  ) {
    throw new Error("Copilot device flow response is malformed");
  }

  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    interval: body.interval,
    expiresIn: body.expires_in,
  };
};

const pollGithubAccessToken = async (input: {
  domain: string;
  deviceCode: string;
  interval: number;
  expiresAt: number;
}): Promise<string> => {
  const urls = resolveCopilotUrls(input.domain);
  let intervalMilliseconds = input.interval * 1000;

  while (Date.now() < input.expiresAt) {
    const response = await fetch(urls.accessTokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "GitHubCopilotChat/0.35.0",
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: input.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Copilot device token poll failed (${response.status}): ${errorText}`
      );
    }

    const body = (await response.json()) as DeviceTokenResponse;
    if (body.access_token) {
      return body.access_token;
    }

    if (body.error === "authorization_pending") {
      await sleep(intervalMilliseconds + POLLING_SAFETY_MARGIN_MS);
      continue;
    }

    if (body.error === "slow_down") {
      intervalMilliseconds = (body.interval ?? input.interval + 5) * 1000;
      await sleep(intervalMilliseconds + POLLING_SAFETY_MARGIN_MS);
      continue;
    }

    if (body.error) {
      throw new Error(`Copilot device flow failed: ${body.error}`);
    }

    await sleep(intervalMilliseconds + POLLING_SAFETY_MARGIN_MS);
  }

  throw new Error("Copilot device flow timed out");
};

const requestCopilotAccessToken = async (
  domain: string,
  githubAccessToken: string
) => {
  const urls = resolveCopilotUrls(domain);
  const response = await fetch(urls.copilotTokenUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${githubAccessToken}`,
      ...copilotHeaders,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Copilot token request failed (${response.status}): ${errorText}`
    );
  }

  const body = (await response.json()) as CopilotTokenResponse;
  if (!body.token || typeof body.expires_at !== "number") {
    throw new Error("Copilot token response is malformed");
  }

  return {
    accessToken: body.token,
    expiresAt: body.expires_at * 1000 - TOKEN_REFRESH_BUFFER_MS,
  };
};

const requestGithubUser = async (
  domain: string,
  githubAccessToken: string
): Promise<GithubUserResponse | null> => {
  const urls = resolveCopilotUrls(domain);
  const response = await fetch(urls.userUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${githubAccessToken}`,
      "User-Agent": "GitHubCopilotChat/0.35.0",
    },
  });

  if (!response.ok) {
    return null;
  }

  return (await response.json()) as GithubUserResponse;
};

const buildCopilotMetadata = (input: {
  tokenType: string | null;
  scope: string | null;
  enterpriseDomain: string | null;
  accessToken: string;
  user: GithubUserResponse | null;
  existing: CopilotAccountMetadata | null;
}): CopilotAccountMetadata => ({
  provider: "copilot",
  tokenType: input.tokenType ?? input.existing?.tokenType ?? null,
  scope: input.scope ?? input.existing?.scope ?? null,
  enterpriseDomain: input.enterpriseDomain,
  copilotApiBaseUrl:
    parseCopilotApiBaseUrl(input.accessToken) ??
    input.existing?.copilotApiBaseUrl ??
    null,
  githubUserId:
    typeof input.user?.id === "number"
      ? String(input.user.id)
      : (input.existing?.githubUserId ?? null),
  githubLogin: input.user?.login ?? input.existing?.githubLogin ?? null,
  githubEmail: input.user?.email ?? input.existing?.githubEmail ?? null,
  requestProfile: {
    openaiIntent: "conversation-edits",
    initiatorHeader: "x-initiator",
    visionHeader: "Copilot-Vision-Request",
  },
});

const buildTokenResult = (input: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string | null;
  scope: string | null;
  enterpriseDomain: string | null;
  user: GithubUserResponse | null;
  existing: CopilotAccountMetadata | null;
  fallbackAccountId: string | null;
  fallbackLabel: string | null;
}): ProviderTokenResult => {
  const metadata = buildCopilotMetadata({
    tokenType: input.tokenType,
    scope: input.scope,
    enterpriseDomain: input.enterpriseDomain,
    accessToken: input.accessToken,
    user: input.user,
    existing: input.existing,
  });
  const accountId = metadata.githubUserId ?? input.fallbackAccountId;
  const label =
    metadata.githubEmail ??
    metadata.githubLogin ??
    input.fallbackLabel ??
    (accountId ? `github:${accountId}` : "copilot-account");

  return {
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    accountId,
    metadata,
    label,
  };
};

export const copilotAdapter: ProviderAdapter = {
  provider: "copilot",
  async startOAuth(
    input: ProviderOAuthStartInput
  ): Promise<ProviderOAuthStartResult> {
    const enterpriseDomainInput =
      typeof input.options?.enterpriseDomain === "string"
        ? input.options.enterpriseDomain
        : "";
    const enterpriseDomain = normalizeDomain(enterpriseDomainInput);
    const domain = enterpriseDomain ?? "github.com";

    const deviceFlow = await requestDeviceCode(domain);
    const state = generateState();
    await createOAuthState(input.database, {
      state,
      provider: "copilot",
      pkceVerifier: null,
      metadataJson: JSON.stringify({
        domain,
        enterpriseDomain,
        deviceCode: deviceFlow.deviceCode,
        interval: deviceFlow.interval,
        expiresIn: deviceFlow.expiresIn,
      }),
      expiresAt: input.now + deviceFlow.expiresIn * 1000,
      createdAt: input.now,
    });

    return {
      authorizationUrl: deviceFlow.verificationUri,
      state,
      method: "auto",
      instructions: `Enter code: ${deviceFlow.userCode}`,
    };
  },
  async completeOAuth(
    input: ProviderOAuthCompleteInput
  ): Promise<ProviderTokenResult> {
    const stateRecord = await findOAuthState(
      input.database,
      input.state,
      "copilot",
      input.now
    );
    if (!stateRecord) {
      throw new Error("Copilot OAuth state is missing or expired");
    }

    let parsedMetadata: unknown;
    try {
      parsedMetadata = JSON.parse(stateRecord.metadataJson ?? "{}");
    } catch {
      throw new Error("Copilot OAuth state metadata is malformed");
    }

    const metadataResult = copilotStateMetadataSchema.safeParse(parsedMetadata);
    if (!metadataResult.success) {
      throw new Error("Copilot OAuth state metadata is invalid");
    }

    const metadata = metadataResult.data;
    const githubAccessToken = await pollGithubAccessToken({
      domain: metadata.domain,
      deviceCode: metadata.deviceCode,
      interval: metadata.interval,
      expiresAt: stateRecord.expiresAt,
    });

    const copilotToken = await requestCopilotAccessToken(
      metadata.domain,
      githubAccessToken
    );
    const user = await requestGithubUser(metadata.domain, githubAccessToken);
    await deleteOAuthState(input.database, input.state, "copilot");

    return buildTokenResult({
      accessToken: copilotToken.accessToken,
      refreshToken: githubAccessToken,
      expiresAt: copilotToken.expiresAt,
      tokenType: null,
      scope: null,
      enterpriseDomain: metadata.enterpriseDomain,
      user,
      existing: null,
      fallbackAccountId: null,
      fallbackLabel: null,
    });
  },
  async refreshAccount(
    account: ProviderAccountRecord,
    _now: number
  ): Promise<ProviderTokenResult> {
    const existing =
      account.metadata?.provider === "copilot" ? account.metadata : null;
    const domain = existing?.enterpriseDomain ?? "github.com";
    const copilotToken = await requestCopilotAccessToken(
      domain,
      account.refreshToken
    );
    const existingUser: GithubUserResponse | null =
      existing?.githubUserId || existing?.githubLogin || existing?.githubEmail
        ? {
            ...(existing?.githubUserId
              ? { id: Number(existing.githubUserId) }
              : {}),
            ...(existing?.githubLogin ? { login: existing.githubLogin } : {}),
            ...(existing?.githubEmail ? { email: existing.githubEmail } : {}),
          }
        : null;

    return buildTokenResult({
      accessToken: copilotToken.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: copilotToken.expiresAt,
      tokenType: existing?.tokenType ?? null,
      scope: existing?.scope ?? null,
      enterpriseDomain: existing?.enterpriseDomain ?? null,
      user: existingUser,
      existing,
      fallbackAccountId: account.accountId,
      fallbackLabel: account.label,
    });
  },
};
