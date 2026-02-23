const BEARER_PATTERN = /^\s*bearer\s+(.+?)\s*$/i;

export const parseBearerToken = (
  authorizationHeader: string | undefined
): string | null => {
  if (!authorizationHeader) {
    return null;
  }

  const match = authorizationHeader.match(BEARER_PATTERN);
  if (!match) {
    return null;
  }

  const token = match[1]?.trim() ?? "";
  return token || null;
};
