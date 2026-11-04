import { readResponseJson } from "../utils/response-json";
import type { ProviderTokenResult } from "./types";

export type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

export const readOAuthText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

export const readOAuthTokenResponse = async <T extends OAuthTokenResponse>(
  response: Response,
  providerLabel: string
): Promise<T> => {
  const value = await readResponseJson(
    response,
    `${providerLabel} token response`
  );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${providerLabel} OAuth response is not an object`);
  }
  if (!("access_token" in value) || !readOAuthText(value.access_token)) {
    throw new Error(`${providerLabel} OAuth response has invalid token fields`);
  }
  return value as T;
};

export const buildOAuthTokenFields = (
  providerLabel: string,
  tokens: OAuthTokenResponse,
  input: {
    now: number;
    fallbackRefreshToken?: string | null;
    defaultExpiresIn?: number;
  }
): Pick<ProviderTokenResult, "accessToken" | "expiresAt"> & {
  refreshToken: string;
} => {
  const refreshToken =
    readOAuthText(tokens.refresh_token) ?? input.fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error(`${providerLabel} OAuth response is missing refresh_token`);
  }
  const expiresIn = tokens.expires_in ?? input.defaultExpiresIn;
  const lifetimeMs = typeof expiresIn === "number" ? expiresIn * 1000 : 0;
  // Keep rotated credentials even when the upstream lifetime is unusable.
  const expiresAt =
    input.now +
    (lifetimeMs > 0 && Number.isFinite(input.now + lifetimeMs)
      ? lifetimeMs
      : 60_000);
  return { accessToken: tokens.access_token, refreshToken, expiresAt };
};
