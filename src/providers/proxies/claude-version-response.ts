import { isObjectRecord } from "../../utils/object";
import { logError } from "../../utils/log";
import { CLAUDE_CLI_USER_AGENT } from "../constants";
import { createProxyResponseHeaders } from "./response";

export const EMULATED_CLAUDE_CODE_VERSION =
  /^claude-cli\/(\S+) /.exec(CLAUDE_CLI_USER_AGENT)?.[1] ?? null;

const VERSION_TOO_OLD = "claude_code_version_too_old";
// Claude Code 2.1.310 matches this message when the error code is missing.
const VERSION_TOO_OLD_MESSAGE =
  /\bClaude Code \S+ (?:does not support this model; version (\S+) or newer is required|is older than the minimum version required by your organization's policy)/;

export const rewriteClaudeVersionTooOldResponse = (input: {
  response: Response;
  errorPayload: unknown;
  providerAccountId: string;
}): Response | null => {
  const payload = isObjectRecord(input.errorPayload)
    ? input.errorPayload
    : null;
  const error = isObjectRecord(payload?.error) ? payload.error : null;
  const details = isObjectRecord(error?.details) ? error.details : null;
  const upstreamMessage =
    typeof error?.message === "string" ? error.message : "";
  const match = VERSION_TOO_OLD_MESSAGE.exec(upstreamMessage);
  if (
    details?.error_code !== VERSION_TOO_OLD &&
    !(input.response.status === 400 && match)
  ) {
    return null;
  }

  const requiredVersion = match?.[1] ?? null;
  logError("claude_code_version_too_old", {
    providerAccountId: input.providerAccountId,
    status: input.response.status,
    emulatedVersion: EMULATED_CLAUDE_CODE_VERSION,
    requiredVersion,
  });
  const requirement = requiredVersion
    ? ` (Anthropic requires ${requiredVersion} or newer)`
    : "";
  const message = `Kleis emulates Claude Code ${EMULATED_CLAUDE_CODE_VERSION ?? "(unknown version)"}, which Anthropic rejected as too old${requirement}. Bump the emulated Claude Code version in Kleis (CLAUDE_CLI_USER_AGENT in src/providers/constants.ts) and redeploy.`;
  const headers = createProxyResponseHeaders(input.response.headers);
  headers.set("content-type", "application/json");
  input.response.body?.cancel().catch(() => undefined);
  return Response.json(
    {
      type: "error",
      error: {
        type:
          typeof error?.type === "string"
            ? error.type
            : "invalid_request_error",
        message,
        details: { error_code: VERSION_TOO_OLD },
      },
    },
    { status: input.response.status, headers }
  );
};
