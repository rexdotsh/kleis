import { expect, test } from "bun:test";
import {
  extractWebSocketCloseError,
  extractWebSocketError,
  readWebSocketCloseCode,
  webSocketErrorLogFields,
} from "../../src/providers/proxies/codex-websocket-errors";

test.each([
  [
    "Invalid previous_response_id: resp_PRIVATE_RESPONSE_ID",
    "invalid_previous_response_id",
  ],
  ["PRIVATESECRETTOKEN🔐", "other"],
  ["Connection ended: PRIVATESECRETTOKEN", "connection_ended"],
  ["", "message_too_big"],
])(
  "websocket close reasons retain classification and length, not provider text: %s",
  (reason, category) => {
    const error = extractWebSocketCloseError({ code: 1009, reason });
    const fields = webSocketErrorLogFields(error);
    expect(readWebSocketCloseCode(error)).toBe(1009);
    expect(fields).toMatchObject({
      errorName: "WebSocketCloseError",
      errorMessage: `WebSocket closed 1009 (${category}, ${Buffer.byteLength(reason)} bytes)`,
      errorStack: expect.stringContaining(
        `(${category}, ${Buffer.byteLength(reason)} bytes)`
      ),
      closeReason: category,
      closeReasonBytes: Buffer.byteLength(reason),
    });
    expect(JSON.stringify(fields)).not.toContain("PRIVATE");
    expect(error.cause).toBeUndefined();
  }
);

test("websocket close metadata rejects malformed codes", () => {
  for (const code of ["PRIVATESECRETTOKEN", Number.NaN, 1009.5, -1, 50_000]) {
    const error = extractWebSocketCloseError({
      code,
      reason: "PRIVATESECRETTOKEN",
    });
    expect(readWebSocketCloseCode(error)).toBeNull();
    expect(error.message).toBe("WebSocket closed (other, 18 bytes)");
    expect(JSON.stringify(webSocketErrorLogFields(error))).not.toContain(
      "PRIVATE"
    );
  }
});

test.each([
  new Error("Invalid WebSocket frame: PRIVATESECRETTOKEN"),
  { message: "PRIVATESECRETTOKEN" },
  { error: new Error("PRIVATESECRETTOKEN") },
  { error: { message: "PRIVATESECRETTOKEN", stack: "PRIVATESECRETTOKEN" } },
])(
  "websocket error events cannot copy provider messages or nested stacks: %j",
  (event) => {
    const error = extractWebSocketError(event);
    const fields = webSocketErrorLogFields(error);
    expect(fields).toMatchObject({
      errorName: "WebSocketError",
      errorStack: expect.stringContaining("WebSocket error ("),
    });
    expect(JSON.stringify(fields)).not.toContain("PRIVATESECRETTOKEN");
    expect(error.cause).toBeUndefined();
  }
);

test("websocket errors preserve allowlisted transport codes and HTTP handshake status", () => {
  expect(
    extractWebSocketError({
      error: { code: "ECONNRESET", message: "PRIVATESECRETTOKEN" },
    }).message
  ).toBe("WebSocket error (ECONNRESET, 18 bytes)");
  expect(
    extractWebSocketError({
      message: "Unexpected server response: 403 PRIVATESECRETTOKEN",
    }).message
  ).toContain("unexpected_server_response, HTTP 403");
  expect(
    JSON.stringify(
      webSocketErrorLogFields(
        extractWebSocketError({
          code: "PRIVATESECRETTOKEN",
          message: "PRIVATESECRETTOKEN",
        })
      )
    )
  ).not.toContain("PRIVATE");
});
