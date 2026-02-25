const encodeBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const decodeBase64Url = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded =
    padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
  return atob(padded);
};

export const parseAuthorizationCodeInput = (
  input: string,
  missingCodeMessage: string
): { code: string; state?: string } => {
  const value = input.trim();
  if (!value) {
    throw new Error(missingCodeMessage);
  }

  try {
    const url = new URL(value);
    const code = url.searchParams.get("code");
    if (code) {
      const state = url.searchParams.get("state");
      if (state) {
        return { code, state };
      }

      return { code };
    }
  } catch {
    // ignore non-url values
  }

  if (value.includes("#")) {
    const split = value.split("#", 2);
    if (split[0]) {
      if (split[1]) {
        return {
          code: split[0],
          state: split[1],
        };
      }

      return {
        code: split[0],
      };
    }
  }

  return { code: value };
};

export const generateState = (): string =>
  encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));

export const generatePkce = async (): Promise<{
  verifier: string;
  challenge: string;
}> => {
  const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return {
    verifier,
    challenge: encodeBase64Url(new Uint8Array(digest)),
  };
};
