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

export const readStreamErrorStatus = (payload: unknown): number => {
  const { errorType, errorCode } = readUpstreamErrorFields(payload);
  if (
    [errorType, errorCode].some(
      (code) =>
        code === "rate_limit_error" ||
        code === "rate_limit_exceeded" ||
        code === "usage_limit_reached" ||
        code === "insufficient_quota"
    )
  ) {
    return 429;
  }
  // 529 is Anthropic's overloaded status.
  return errorType === "overloaded_error" || errorCode === "overloaded_error"
    ? 529
    : 502;
};

const MAX_ERROR_BYTES = 8192;
const ERROR_READ_TIMEOUT_MS = 100;

export const readUpstreamErrorPayload = async (
  response: Response,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<unknown> => {
  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  if (
    !response.body ||
    (contentType && !contentType.includes("application/json"))
  ) {
    return null;
  }
  const reader = response.clone().body?.getReader();
  if (!reader) {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(
      () => resolve(null),
      options.timeoutMs ?? ERROR_READ_TIMEOUT_MS
    );
  });
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    if (options.signal?.aborted) resolve(null);
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const result = await Promise.race([reader.read(), timeout, aborted]);
      if (!result) {
        return null;
      }
      if (result.done) {
        return JSON.parse(text + decoder.decode()) as unknown;
      }
      bytes += result.value.byteLength;
      if (bytes > MAX_ERROR_BYTES) {
        return null;
      }
      text += decoder.decode(result.value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    // Cancelling one tee branch waits for the other branch to finish.
    reader.cancel().catch(() => undefined);
  }
};

export const readUpstreamResponseError = async (
  response: Response
): Promise<ReturnType<typeof readUpstreamErrorFields>> =>
  readUpstreamErrorFields(await readUpstreamErrorPayload(response));
