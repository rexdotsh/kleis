const streamingProxyPathPrefixes = [
  "/openai/v1/",
  "/anthropic/v1/",
  "/copilot/v1/",
] as const;

export const resolveRequestIdleTimeout = (pathname: string): number | null => {
  for (const prefix of streamingProxyPathPrefixes) {
    if (pathname.startsWith(prefix)) {
      return 0;
    }
  }

  return null;
};
