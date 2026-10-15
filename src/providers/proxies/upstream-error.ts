import { isObjectRecord } from "../../utils/object";

const ERROR_CODES = new Set([
  "api_error",
  "authentication_error",
  "billing_error",
  "content_filter",
  "context_length_exceeded",
  "insufficient_quota",
  "internal_error",
  "invalid_api_key",
  "invalid_request_error",
  "model_not_found",
  "not_found_error",
  "overloaded_error",
  "permission_error",
  "rate_limit_error",
  "rate_limit_exceeded",
  "request_too_large",
  "server_error",
  "usage_limit_reached",
  "usage_not_included",
  "websocket_connection_limit_reached",
]);

const readErrorCode = (value: unknown): string | null =>
  typeof value === "string" && ERROR_CODES.has(value) ? value : null;

export const readUpstreamErrorFields = (
  payload: unknown
): { errorType: string | null; errorCode: string | null } => {
  const body = isObjectRecord(payload) ? payload : null;
  const response = isObjectRecord(body?.response) ? body.response : null;
  const error = isObjectRecord(body?.error)
    ? body.error
    : isObjectRecord(response?.error)
      ? response.error
      : null;
  return {
    errorType: readErrorCode(error?.type),
    errorCode: readErrorCode(error?.code ?? body?.code),
  };
};

const MAX_ERROR_BYTES = 8192;
const ERROR_READ_TIMEOUT_MS = 100;

export const readUpstreamResponseError = async (
  response: Response
): Promise<ReturnType<typeof readUpstreamErrorFields>> => {
  const empty = readUpstreamErrorFields(null);
  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  if (
    !response.body ||
    (contentType && !contentType.includes("application/json"))
  ) {
    return empty;
  }
  const reader = response.clone().body?.getReader();
  if (!reader) {
    return empty;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ERROR_READ_TIMEOUT_MS);
  });
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const result = await Promise.race([reader.read(), timeout]);
      if (!result) {
        return empty;
      }
      if (result.done) {
        return readUpstreamErrorFields(JSON.parse(text + decoder.decode()));
      }
      bytes += result.value.byteLength;
      if (bytes > MAX_ERROR_BYTES) {
        return empty;
      }
      text += decoder.decode(result.value, { stream: true });
    }
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
    // Cancelling one tee branch waits for the other branch to finish.
    reader.cancel().catch(() => undefined);
  }
};
