import type { Database } from "../db/client";
import type { ProviderAccountRecord } from "../db/repositories/provider-accounts";
import type { Provider } from "../db/schema";
import type { ProviderAccountMetadata } from "./metadata";

export type ProviderOAuthStartInput = {
  database: Database;
  redirectUri: string;
  options?: Record<string, unknown>;
  now: number;
};

export type ProviderOAuthStartResult = {
  authorizationUrl: string;
  state: string;
  method: "auto" | "code";
  instructions?: string;
};

export type ProviderOAuthCompleteInput = {
  database: Database;
  state: string;
  code?: string;
  now: number;
};

export type ProviderTokenResult = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string | null;
  metadata: ProviderAccountMetadata | null;
  label?: string | null;
};

export type ProviderAdapter = {
  provider: Provider;
  startOAuth(input: ProviderOAuthStartInput): Promise<ProviderOAuthStartResult>;
  completeOAuth(
    input: ProviderOAuthCompleteInput
  ): Promise<ProviderTokenResult>;
  refreshAccount(
    account: ProviderAccountRecord,
    now: number
  ): Promise<ProviderTokenResult>;
};
