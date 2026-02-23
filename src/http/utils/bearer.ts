const BEARER_PREFIX = "Bearer ";

export const parseBearerToken = (
  authorizationHeader: string | undefined
): string | null => {
  if (!authorizationHeader?.startsWith(BEARER_PREFIX)) {
    return null;
  }

  const token = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  return token || null;
};
