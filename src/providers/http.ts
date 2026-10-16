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
  "rate_limit_error",
  "deviceauth_authorization_pending",
]);

export const CLAUDE_ACCOUNT_ON_HOLD = "account_on_hold";

export class OAuthError extends Error {
  constructor(
    messagePrefix: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(`${messagePrefix} (HTTP ${status}${code ? `, ${code}` : ""})`);
    this.name = "OAuthError";
  }
}

// Provider error bodies can echo request details, so only an allowlisted code
// from `error`, `error.code` or `error.type` is kept.
export const readOAuthErrorCode = async (
  response: Response
): Promise<string | null> => {
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  // Anthropic reports a suspended account through error_uri.
  if (text.includes(CLAUDE_ACCOUNT_ON_HOLD)) {
    return CLAUDE_ACCOUNT_ON_HOLD;
  }
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
  const candidates =
    error && typeof error === "object"
      ? [
          "code" in error ? error.code : null,
          "type" in error ? error.type : null,
        ]
      : [error];
  return (
    candidates.find(
      (code): code is string =>
        typeof code === "string" && OAUTH_ERROR_CODES.has(code)
    ) ?? null
  );
};

export const classifyOAuthRefreshError = (
  error: unknown,
  unknownFailureStatus: "indeterminate" | "failed"
) => {
  if (!(error instanceof OAuthError)) {
    return unknownFailureStatus;
  }
  if (
    error.code === "invalid_grant" ||
    error.code === "expired_token" ||
    error.code === "refresh_token_expired" ||
    error.code === "refresh_token_reused" ||
    error.code === "refresh_token_invalidated"
  ) {
    return "reauthorize";
  }
  if (error.code === CLAUDE_ACCOUNT_ON_HOLD) {
    return CLAUDE_ACCOUNT_ON_HOLD;
  }
  return error.status === 429 ? "rate_limited" : "transient";
};

export const requireOkResponse = async (
  response: Response,
  messagePrefix: string
): Promise<void> => {
  if (response.ok) {
    return;
  }

  throw new OAuthError(
    messagePrefix,
    response.status,
    await readOAuthErrorCode(response)
  );
};
