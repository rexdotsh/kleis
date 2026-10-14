import { errorLogFields } from "../../utils/log";
import { isObjectRecord } from "../../utils/object";

const REASON_PREFIXES = [
  ["Invalid previous_response_id:", "invalid_previous_response_id"],
  ["Previous response with id", "previous_response_not_found"],
  ["websocket_connection_limit_reached", "connection_limit_reached"],
  ["rate_limit_exceeded", "rate_limit_exceeded"],
  ["message too big", "message_too_big"],
  ["Connection ended", "connection_ended"],
  ["Invalid WebSocket frame:", "invalid_websocket_frame"],
  ["WebSocket is not open:", "socket_not_open"],
] as const;
const TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPROTO",
  "EPIPE",
  "ECONNABORTED",
  "WS_ERR_INVALID_CLOSE_CODE",
  "WS_ERR_INVALID_UTF8",
  "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH",
  "WS_ERR_UNEXPECTED_RSV_1",
]);

const readText = (value: unknown): string =>
  typeof value === "string" ? value : "";

const classifyText = (text: string): string => {
  if (!text) {
    return "none";
  }
  for (const [prefix, category] of REASON_PREFIXES) {
    if (text.startsWith(prefix)) {
      return category;
    }
  }
  return "other";
};

class WebSocketCloseError extends Error {
  readonly webSocketCloseCode: number | null;
  readonly closeReason: string;
  readonly closeReasonBytes: number;

  constructor(event: unknown) {
    const data = isObjectRecord(event) ? event : null;
    const code =
      typeof data?.code === "number" &&
      Number.isInteger(data.code) &&
      data.code >= 1000 &&
      data.code <= 4999
        ? data.code
        : null;
    const text = readText(data?.reason);
    const category =
      !text && code === 1009 ? "message_too_big" : classifyText(text);
    const bytes = Buffer.byteLength(text);
    // Close reasons can embed response IDs or request content; retain only metadata.
    super(
      `WebSocket closed${code === null ? "" : ` ${code}`} (${category}, ${bytes} bytes)`
    );
    this.name = "WebSocketCloseError";
    this.webSocketCloseCode = code;
    this.closeReason = category;
    this.closeReasonBytes = bytes;
  }
}

export const extractWebSocketCloseError = (event: unknown): Error =>
  new WebSocketCloseError(event);

export const readWebSocketCloseCode = (error: unknown): number | null =>
  error instanceof WebSocketCloseError ? error.webSocketCloseCode : null;

export const webSocketErrorLogFields = (error: unknown) => ({
  ...errorLogFields(error),
  ...(error instanceof WebSocketCloseError
    ? {
        closeReason: error.closeReason,
        closeReasonBytes: error.closeReasonBytes,
      }
    : {}),
});

export const extractWebSocketError = (event: unknown): Error => {
  const data = isObjectRecord(event) ? event : null;
  const nested = isObjectRecord(data?.error) ? data.error : null;
  const message = readText(data?.message) || readText(nested?.message);
  const code = data?.code ?? nested?.code;
  const transportCode =
    typeof code === "string" && TRANSPORT_CODES.has(code) ? code : null;
  const status = /^Unexpected server response: ([1-5]\d{2})(?:\b|$)/u.exec(
    message
  )?.[1];
  const category =
    transportCode ??
    (status ? "unexpected_server_response" : classifyText(message));
  const error = new Error(
    `WebSocket error (${category}${status ? `, HTTP ${status}` : ""}, ${Buffer.byteLength(message)} bytes)`
  );
  error.name = "WebSocketError";
  return error;
};
