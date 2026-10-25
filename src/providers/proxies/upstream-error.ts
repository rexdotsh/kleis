import { isObjectRecord } from "../../utils/object";
import { tryParseJson } from "./response";

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
const MAX_BUFFERED_ERROR_BYTES = 64 * 1024;
const BUFFERED_ERROR_DEADLINE_MS = 3000;

const isJsonContent = (response: Response): boolean => {
  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  return !contentType || contentType.includes("application/json");
};

export const readUpstreamErrorPayload = async (
  response: Response
): Promise<unknown> => {
  if (!response.body || !isJsonContent(response)) {
    return null;
  }
  const reader = response.clone().body?.getReader();
  if (!reader) {
    return null;
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
    // Cancelling one tee branch waits for the other branch to finish.
    reader.cancel().catch(() => undefined);
  }
};

// Reads an error body to the end, bounded by size, a deadline and the
// request's abort signal; upstream reads have no timeout of their own. The
// returned response replays the same bytes. A body over the size bound is
// passed on unparsed, and one that stalls is cut off at the deadline and
// passed on unparsed with the bytes that arrived.
export const bufferUpstreamError = async (
  response: Response,
  signal: AbortSignal
): Promise<{ response: Response; payload: unknown }> => {
  signal.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) {
    return { response, payload: null };
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  let stalled = false;
  const cancel = (): void => {
    reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), BUFFERED_ERROR_DEADLINE_MS);
  });
  try {
    while (bytes <= MAX_BUFFERED_ERROR_BYTES) {
      const result = await Promise.race([reader.read(), deadline]);
      if (!result) {
        stalled = true;
        reader.cancel().catch(() => undefined);
        break;
      }
      if (result.done) {
        complete = true;
        break;
      }
      chunks.push(result.value);
      bytes += result.value.byteLength;
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
  signal.throwIfAborted();
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };
  if (!complete && !stalled) {
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        for (const chunk of chunks) controller.enqueue(chunk);
      },
      async pull(controller): Promise<void> {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    return { response: new Response(body, init), payload: null };
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    response: new Response(body, init),
    payload:
      complete && isJsonContent(response)
        ? tryParseJson(new TextDecoder().decode(body))
        : null,
  };
};

export const readUpstreamResponseError = async (
  response: Response
): Promise<ReturnType<typeof readUpstreamErrorFields>> =>
  readUpstreamErrorFields(await readUpstreamErrorPayload(response));
