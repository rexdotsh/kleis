// OAuth error codes from RFC 6749, RFC 8628 and the Codex refresh errors in
// openai/codex codex-rs/login/src/auth/manager.rs.
const OAUTH_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
  "authorization_pending",
  "slow_down",
  "expired_token",
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
]);

// Provider error bodies can echo request details, so only an allowlisted code
// from `error` or `error.code` is kept.
const readOAuthErrorCode = (text: string): string | null => {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || !("error" in body)) {
    return null;
  }
  const { error } = body;
  const code =
    error && typeof error === "object" && "code" in error ? error.code : error;
  return typeof code === "string" && OAUTH_ERROR_CODES.has(code) ? code : null;
};

export const requireOkResponse = async (
  response: Response,
  messagePrefix: string
): Promise<void> => {
  if (response.ok) {
    return;
  }

  const code = readOAuthErrorCode(await response.text().catch(() => ""));
  throw new Error(
    `${messagePrefix} (HTTP ${response.status}${code ? `, ${code}` : ""})`
  );
};
