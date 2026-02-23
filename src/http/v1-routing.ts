import type { Provider } from "../db/schema";

export const V1_PROVIDER_HEADER = "x-kleis-provider";

export type V1ProxyEndpoint = "chat_completions" | "responses" | "messages";

export const toProvider = (
  value: string | null | undefined
): Provider | null => {
  if (value === "copilot" || value === "codex" || value === "claude") {
    return value;
  }

  return null;
};

export const endpointFromPath = (path: string): V1ProxyEndpoint | null => {
  if (path.endsWith("/chat/completions")) {
    return "chat_completions";
  }

  if (path.endsWith("/responses")) {
    return "responses";
  }

  if (path.endsWith("/messages")) {
    return "messages";
  }

  return null;
};

export const resolveTargetProvider = (
  endpoint: V1ProxyEndpoint,
  preferredProvider: Provider | null
): Provider => {
  if (preferredProvider) {
    return preferredProvider;
  }

  if (endpoint === "messages") {
    return "claude";
  }

  if (endpoint === "chat_completions") {
    return "copilot";
  }

  return "codex";
};
