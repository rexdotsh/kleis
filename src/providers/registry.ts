import type { Provider } from "../db/schema";
import { claudeAdapter } from "./claude";
import { copilotAdapter } from "./copilot";
import { codexAdapter } from "./codex";
import type { ProviderAdapter } from "./types";

const providerAdapters: Record<Provider, ProviderAdapter> = {
  copilot: copilotAdapter,
  codex: codexAdapter,
  claude: claudeAdapter,
};

export const getProviderAdapter = (provider: Provider): ProviderAdapter =>
  providerAdapters[provider];
