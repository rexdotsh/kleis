import { isObjectRecord } from "../../utils/object";
import { createProxyResponseHeaders } from "./response";

export type ClaudeExtraUsageError =
  | "third_party"
  | "exhausted"
  | "long_context";

export type ClaudeExtraUsageState = ClaudeExtraUsageError | "in_use";

// Anthropic's error messages for requests that need paid extra usage. The
// "usage credits" wordings are the ones Claude Code 2.1.310 also matches.
// https://github.com/router-for-me/CLIProxyAPI/issues/6004
const EXTRA_USAGE_ERRORS: [prefix: string, error: ClaudeExtraUsageError][] = [
  ["Third-party apps now draw from your extra usage", "third_party"],
  ["You're out of extra usage", "exhausted"],
  ["You're out of usage credits", "exhausted"],
  ["Extra usage is required for long context", "long_context"],
  ["Usage credits are required for long context", "long_context"],
];

const ERROR_LEADS: Record<ClaudeExtraUsageError, string> = {
  third_party:
    "Anthropic counts this request as third-party traffic, which draws from paid extra usage instead of plan limits",
  exhausted: "The Claude account is out of paid extra usage",
  long_context: "Long context requests draw from paid extra usage",
};

const readErrorMessage = (payload: unknown): string | null => {
  const error =
    isObjectRecord(payload) && isObjectRecord(payload.error)
      ? payload.error
      : null;
  return typeof error?.message === "string" ? error.message : null;
};

export const readClaudeExtraUsageError = (
  errorPayload: unknown
): ClaudeExtraUsageError | null => {
  const message = readErrorMessage(errorPayload);
  if (message === null) return null;
  return (
    EXTRA_USAGE_ERRORS.find(([prefix]) => message.startsWith(prefix))?.[1] ??
    null
  );
};

// Whether a successful response was billed to extra usage ("in_use") or to
// plan limits ("plan"), read the way Claude Code reads the unified headers.
// Null when the response reports neither.
export const readClaudeExtraUsageBilling = (
  response: Response
): "in_use" | "plan" | null => {
  if (!response.ok) return null;
  const header = (name: string) =>
    response.headers.get(`anthropic-ratelimit-unified-${name}`);
  const status = header("status");
  if (status === null) return null;
  const overage = header("overage-status");
  const usingOverage =
    status === "rejected" &&
    (overage === "allowed" || overage === "allowed_warning");
  return header("overage-in-use") === "true" || usingOverage
    ? "in_use"
    : "plan";
};

export const createClaudeExtraUsageResponse = (input: {
  response: Response;
  error: ClaudeExtraUsageError;
  errorPayload: unknown;
  accountLabel: string | null;
}): Response => {
  const upstream = isObjectRecord(input.errorPayload)
    ? input.errorPayload.error
    : null;
  const type =
    isObjectRecord(upstream) && typeof upstream.type === "string"
      ? upstream.type
      : "invalid_request_error";
  const account =
    input.accountLabel === null
      ? ""
      : ` (Claude account ${JSON.stringify(input.accountLabel)})`;
  const message = `${ERROR_LEADS[input.error]}${account}. Kleis does not retry or reroute requests that would spend extra usage. Anthropic said: ${readErrorMessage(input.errorPayload)}`;
  const headers = createProxyResponseHeaders(input.response.headers);
  headers.delete("retry-after");
  headers.delete("retry-after-ms");
  headers.set("content-type", "application/json");
  // Anthropic SDKs check this before the status, so a 429 isn't resent.
  headers.set("x-should-retry", "false");
  input.response.body?.cancel().catch(() => undefined);
  return Response.json(
    {
      type: "error",
      error: {
        type,
        code: `extra_usage_${input.error}`,
        message,
        account: input.accountLabel,
      },
    },
    { status: input.response.status, headers }
  );
};
