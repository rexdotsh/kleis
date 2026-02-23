import type { Provider } from "../db/schema";
import { codexAdapter } from "./codex";
import type { ProviderAdapter } from "./types";
import { createClaudeAdapter, createCopilotAdapter } from "./stub-adapter";

const providerAdapters: Record<Provider, ProviderAdapter> = {
  copilot: createCopilotAdapter(),
  codex: codexAdapter,
  claude: createClaudeAdapter(),
};

export const getProviderAdapter = (provider: Provider): ProviderAdapter =>
  providerAdapters[provider];
