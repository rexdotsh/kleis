const streamingProxyPathPrefixes = ["/openai/v1/", "/anthropic/v1/"] as const;
const CODEX_DEVICE_OAUTH_COMPLETE_PATH = "/admin/accounts/codex/oauth/complete";

export const resolveRequestIdleTimeout = (pathname: string): number | null => {
  // A headless Codex device flow can poll for 15 minutes before responding;
  // Bun's default 255-second idle timeout would close the admin request first.
  if (pathname === CODEX_DEVICE_OAUTH_COMPLETE_PATH) {
    return 0;
  }

  for (const prefix of streamingProxyPathPrefixes) {
    if (pathname.startsWith(prefix)) {
      return 0;
    }
  }

  return null;
};
