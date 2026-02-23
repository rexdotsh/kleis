import type { Provider } from "../db/schema";
import { ProviderNotImplementedError } from "./errors";
import type {
  ProviderAdapter,
  ProviderOAuthCompleteInput,
  ProviderOAuthStartInput,
  ProviderOAuthStartResult,
  ProviderTokenResult,
} from "./types";

const fail = <T>(provider: Provider, operation: string): Promise<T> =>
  Promise.reject(new ProviderNotImplementedError(provider, operation));

const createNotImplementedAdapter = (provider: Provider): ProviderAdapter => ({
  provider,
  startOAuth(
    _input: ProviderOAuthStartInput
  ): Promise<ProviderOAuthStartResult> {
    return fail(provider, "startOAuth");
  },
  completeOAuth(
    _input: ProviderOAuthCompleteInput
  ): Promise<ProviderTokenResult> {
    return fail(provider, "completeOAuth");
  },
  refreshAccount(_account, _now): Promise<ProviderTokenResult> {
    return fail(provider, "refreshAccount");
  },
});

export const createCopilotAdapter = (): ProviderAdapter =>
  createNotImplementedAdapter("copilot");

export const createClaudeAdapter = (): ProviderAdapter =>
  createNotImplementedAdapter("claude");
