import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import WebSocket from "ws";

import {
  CODEX_RESPONSE_ENDPOINT,
  CODEX_WEBSOCKET_BETA_HEADER,
} from "../constants";
import {
  applyCodexSessionHeaders,
  deriveCodexSessionId,
  readCodexSessionId,
} from "./codex-proxy";
import { readOpenAiResponsesUsageFromSseEvent } from "../../usage/token-usage";
import type { TokenUsage } from "../../usage/token-usage";
import { errorLogFields, logWarn } from "../../utils/log";
import { isObjectRecord, readBooleanField } from "../../utils/object";
import { createSseKeepAlive, createSseResponseHeaders } from "./sse-keepalive";

const SESSION_SOCKET_TTL_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 15_000;
const RESPONSE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_SOCKET_AGE_MS = 55 * 60 * 1000;
const CONNECTION_LIMIT_RETRIES = 5;
const STREAM_FAILURE_RETRIES = 5;
const CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const textEncoder = new TextEncoder();

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

type WebSocketLike = {
  readonly readyState?: number;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  send(data: string, callback?: (error?: Error) => void): void;
  addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
  removeEventListener(
    type: WebSocketEventType,
    listener: WebSocketListener
  ): void;
};

type WebSocketConstructor = new (
  url: string,
  options?: { headers?: Record<string, string>; agent?: unknown }
) => WebSocketLike;

let webSocketConstructorOverride: WebSocketConstructor | null = null;

export const setCodexWebSocketConstructorForTests = (
  webSocketConstructor: WebSocketConstructor | null
): void => {
  webSocketConstructorOverride = webSocketConstructor;
};

type WebSocketCloseError = Error & {
  webSocketCloseCode?: number;
};

type CodexWebSocketInput = {
  headers: Headers;
  bodyJson: Record<string, unknown> | null;
  accountKey: string;
  sessionId?: string | null;
  upstreamSessionId?: string | null;
  onTokenUsage?: ((usage: TokenUsage) => void) | null;
  signal?: AbortSignal;
};

type ContinuationState = {
  lastRequestBody: Record<string, unknown>;
  lastResponseId: string;
  lastResponseItems: unknown[];
};

type CachedSocket = {
  socket: WebSocketLike;
  connectedAt: number;
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  continuation: ContinuationState | null;
  skipNextContinuationStore: boolean;
};

const socketCache = new Map<string, CachedSocket>();
const fallbackSocketKeys = new Map<string, ReturnType<typeof setTimeout>>();
const streamFailureCounts = new Map<string, number>();
const pendingSocketKeys = new Set<string>();
const suppressContinuationStoreKeys = new Set<string>();

const resolveCodexWebSocketUrl = (): string => {
  const url = new URL(CODEX_RESPONSE_ENDPOINT);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
};

const headersToRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  for (const [key, value] of headers) {
    record[key] = value;
  }
  return record;
};

const createSseResponse = (body: ReadableStream<Uint8Array>): Response =>
  new Response(body, {
    headers: createSseResponseHeaders(),
  });

const readString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
};

const isCompactionRequest = (
  body: Record<string, unknown>,
  headers: Headers
): boolean => {
  const clientMetadata = isObjectRecord(body.client_metadata)
    ? body.client_metadata
    : null;
  const rawMetadata =
    readString(clientMetadata?.["x-codex-turn-metadata"]) ??
    readString(headers.get("x-codex-turn-metadata"));
  if (!rawMetadata) {
    return false;
  }

  try {
    const metadata = JSON.parse(rawMetadata) as unknown;
    return (
      isObjectRecord(metadata) &&
      readString(metadata.request_kind)?.toLowerCase() === "compaction"
    );
  } catch {
    return false;
  }
};

const isSocketOpen = (socket: WebSocketLike): boolean =>
  socket.readyState === undefined || socket.readyState === 1;

const isSocketFresh = (cached: CachedSocket): boolean =>
  Date.now() - cached.connectedAt < MAX_SOCKET_AGE_MS;

const closeSocket = (socket: WebSocketLike): void => {
  try {
    socket.close(1000, "done");
  } catch {
    // Ignore close failures from already-closed sockets.
  }
};

const terminateSocket = (socket: WebSocketLike): void => {
  try {
    if (socket.terminate) {
      socket.terminate();
      return;
    }
    socket.close(1001, "invalid");
  } catch {
    // Ignore termination failures from already-closed sockets.
  }
};

const extractWebSocketError = (event: unknown): Error => {
  if (isObjectRecord(event)) {
    const message = readString(event.message);
    if (message) {
      return new Error(message);
    }

    const nestedError = event.error;
    if (nestedError instanceof Error && nestedError.message) {
      return nestedError;
    }
    if (isObjectRecord(nestedError)) {
      const nestedMessage = readString(nestedError.message);
      if (nestedMessage) {
        return new Error(nestedMessage);
      }
    }
  }

  return new Error("WebSocket error");
};

const extractWebSocketCloseError = (event: unknown): Error => {
  if (!isObjectRecord(event)) {
    return new Error("WebSocket closed");
  }

  const code = typeof event.code === "number" ? event.code : null;
  const reason = readString(event.reason);
  const codeText = code === null ? "" : ` ${code}`;
  const reasonText =
    reason ??
    (code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE ? "message too big" : null);
  const error = new Error(
    `WebSocket closed${codeText}${reasonText ? ` ${reasonText}` : ""}`.trim()
  ) as WebSocketCloseError;
  if (code !== null) {
    error.webSocketCloseCode = code;
  }
  return error;
};

const readWebSocketCloseCode = (error: unknown): number | null => {
  if (!(error instanceof Error)) {
    return null;
  }

  const closeCode = (error as WebSocketCloseError).webSocketCloseCode;
  return typeof closeCode === "number" ? closeCode : null;
};

const clearSessionFallback = (key: string): void => {
  const timer = fallbackSocketKeys.get(key);
  if (timer) {
    clearTimeout(timer);
    fallbackSocketKeys.delete(key);
  }
};

const markSessionFallback = (key: string | null): void => {
  if (!key) {
    return;
  }
  clearSessionFallback(key);
  const timer = setTimeout(() => {
    fallbackSocketKeys.delete(key);
    streamFailureCounts.delete(key);
  }, SESSION_SOCKET_TTL_MS);
  fallbackSocketKeys.set(key, timer);
};

const clearSessionStreamFailures = (key: string | null): void => {
  if (!key) {
    return;
  }
  streamFailureCounts.delete(key);
};

const recordSessionStreamFailure = (key: string | null): number => {
  if (!key) {
    return 0;
  }

  const failures = (streamFailureCounts.get(key) ?? 0) + 1;
  streamFailureCounts.set(key, failures);
  if (failures > STREAM_FAILURE_RETRIES) {
    markSessionFallback(key);
  }
  return failures;
};

const scheduleExpiry = (key: string, cached: CachedSocket): void => {
  if (cached.idleTimer) {
    clearTimeout(cached.idleTimer);
  }

  cached.idleTimer = setTimeout(() => {
    if (cached.busy) {
      return;
    }

    closeSocket(cached.socket);
    socketCache.delete(key);
    clearSessionFallback(key);
    clearSessionStreamFailures(key);
  }, SESSION_SOCKET_TTL_MS);
};

const getWebSocketConstructor = (): WebSocketConstructor | null => {
  if (webSocketConstructorOverride) {
    return webSocketConstructorOverride;
  }
  return WebSocket as unknown as WebSocketConstructor;
};

const connectWebSocket = (
  headers: Headers,
  signal?: AbortSignal
): Promise<WebSocketLike> => {
  const WebSocketCtor = getWebSocketConstructor();
  if (!WebSocketCtor) {
    return Promise.reject(new Error("WebSocket is not available"));
  }
  if (signal?.aborted) {
    return Promise.reject(new Error("Request was aborted"));
  }

  return new Promise((resolve, reject) => {
    let socket: WebSocketLike;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onOpen = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = (event: unknown): void =>
      fail(extractWebSocketError(event));
    const onClose = (event: unknown): void =>
      fail(extractWebSocketCloseError(event));
    const onAbort = (): void => {
      fail(new Error("Request was aborted"));
      terminateSocket(socket);
    };
    const onTimeout = (): void => {
      fail(
        new Error(`WebSocket connect timeout after ${CONNECT_TIMEOUT_MS}ms`)
      );
      terminateSocket(socket);
    };

    try {
      const webSocketUrl = resolveCodexWebSocketUrl();
      const proxyUrl = getProxyForUrl(
        webSocketUrl.replace(/^wss:/u, "https:").replace(/^ws:/u, "http:")
      );
      socket = new WebSocketCtor(webSocketUrl, {
        headers: headersToRecord(headers),
        ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);
    timeout = setTimeout(onTimeout, CONNECT_TIMEOUT_MS);
  });
};

const acquireSocket = async (
  headers: Headers,
  cacheKey: string | null,
  signal?: AbortSignal
): Promise<{
  socket: WebSocketLike;
  cached: CachedSocket | null;
  release(keep: boolean): void;
}> => {
  if (!cacheKey) {
    const socket = await connectWebSocket(headers, signal);
    const acquired = {
      socket,
      cached: null,
      release(keep: boolean): void {
        if (keep) {
          closeSocket(acquired.socket);
          return;
        }
        terminateSocket(acquired.socket);
      },
    };
    return acquired;
  }

  const existing = socketCache.get(cacheKey);
  if (existing) {
    if (existing.busy) {
      existing.continuation = null;
      existing.skipNextContinuationStore = true;
      throw new Error("Codex WebSocket session is busy");
    }

    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }

    if (isSocketOpen(existing.socket) && isSocketFresh(existing)) {
      existing.busy = true;
      return {
        socket: existing.socket,
        cached: existing,
        release(keep: boolean): void {
          if (!(keep && isSocketOpen(existing.socket))) {
            terminateSocket(existing.socket);
            socketCache.delete(cacheKey);
            return;
          }
          existing.busy = false;
          scheduleExpiry(cacheKey, existing);
        },
      };
    }

    closeSocket(existing.socket);
    socketCache.delete(cacheKey);
  }

  if (pendingSocketKeys.has(cacheKey)) {
    suppressContinuationStoreKeys.add(cacheKey);
    throw new Error("Codex WebSocket session is connecting");
  }

  pendingSocketKeys.add(cacheKey);
  let socket: WebSocketLike;
  try {
    socket = await connectWebSocket(headers, signal);
  } catch (error) {
    suppressContinuationStoreKeys.delete(cacheKey);
    throw error;
  } finally {
    pendingSocketKeys.delete(cacheKey);
  }
  const cached: CachedSocket = {
    socket,
    connectedAt: Date.now(),
    busy: true,
    idleTimer: null,
    continuation: null,
    skipNextContinuationStore: suppressContinuationStoreKeys.delete(cacheKey),
  };
  socketCache.set(cacheKey, cached);
  return {
    socket,
    cached,
    release(keep: boolean): void {
      if (!(keep && isSocketOpen(cached.socket))) {
        terminateSocket(cached.socket);
        socketCache.delete(cacheKey);
        return;
      }
      cached.busy = false;
      scheduleExpiry(cacheKey, cached);
    },
  };
};

export const closeCodexWebSocketSessions = (): void => {
  for (const cached of socketCache.values()) {
    if (cached.idleTimer) {
      clearTimeout(cached.idleTimer);
    }
    closeSocket(cached.socket);
  }
  socketCache.clear();
  for (const timer of fallbackSocketKeys.values()) {
    clearTimeout(timer);
  }
  fallbackSocketKeys.clear();
  streamFailureCounts.clear();
};

const withoutContinuationFields = (
  body: Record<string, unknown>
): Record<string, unknown> => {
  const {
    input: _input,
    previous_response_id: _previous,
    ...rest
  } = withoutTransportFields(body);
  return rest;
};

const withoutTransportFields = (
  body: Record<string, unknown>
): Record<string, unknown> => {
  const { background: _background, stream: _stream, ...rest } = body;
  return rest;
};

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const hasOwn = (body: Record<string, unknown>, key: string): boolean =>
  Object.hasOwn(body, key);

const sameOptionalJson = (left: unknown, right: unknown): boolean =>
  (left === undefined && right === undefined) ||
  (left === undefined && right === null) ||
  (left === null && right === undefined) ||
  sameJson(left, right);

const matchesOptionalField = (
  inputItem: Record<string, unknown>,
  responseItem: Record<string, unknown>,
  field: string
): boolean =>
  inputItem[field] === undefined || inputItem[field] === responseItem[field];

const outputTextContent = (content: unknown): unknown[] | null => {
  if (!Array.isArray(content)) {
    return null;
  }
  const normalized: Array<{ text: unknown; type: "output_text" }> = [];
  for (const item of content) {
    if (!isObjectRecord(item) || item.type !== "output_text") {
      return null;
    }
    normalized.push({ type: "output_text", text: item.text });
  }
  return normalized;
};

const matchesMessageInput = (
  responseItem: Record<string, unknown>,
  inputItem: Record<string, unknown>
): boolean => {
  const responseContent = outputTextContent(responseItem.content);
  const inputContent = outputTextContent(inputItem.content);
  return (
    (responseItem.role === undefined || responseItem.role === "assistant") &&
    inputItem.role === "assistant" &&
    matchesOptionalField(inputItem, responseItem, "id") &&
    matchesOptionalField(inputItem, responseItem, "status") &&
    matchesOptionalField(inputItem, responseItem, "type") &&
    Boolean(responseContent) &&
    sameJson(inputContent, responseContent)
  );
};

const matchesFunctionCallInput = (
  responseItem: Record<string, unknown>,
  inputItem: Record<string, unknown>
): boolean =>
  inputItem.type === "function_call" &&
  matchesOptionalField(inputItem, responseItem, "id") &&
  matchesOptionalField(inputItem, responseItem, "status") &&
  inputItem.call_id === responseItem.call_id &&
  inputItem.name === responseItem.name &&
  inputItem.arguments === responseItem.arguments;

const matchesReasoningInput = (
  responseItem: Record<string, unknown>,
  inputItem: Record<string, unknown>
): boolean => {
  if (typeof responseItem.id !== "string") {
    return false;
  }
  if (inputItem.type === "item_reference") {
    return inputItem.id === responseItem.id;
  }
  const hasInputId = inputItem.id !== undefined;
  const hasMatchingEncryptedContent =
    typeof inputItem.encrypted_content === "string" &&
    inputItem.encrypted_content === responseItem.encrypted_content;
  return (
    inputItem.type === "reasoning" &&
    matchesOptionalField(inputItem, responseItem, "id") &&
    (hasInputId || hasMatchingEncryptedContent) &&
    sameJson(inputItem.summary, responseItem.summary ?? []) &&
    sameOptionalJson(
      inputItem.encrypted_content,
      responseItem.encrypted_content
    )
  );
};

const matchesLoweredResponseItem = (
  responseItem: unknown,
  inputItem: unknown
): boolean => {
  if (sameJson(responseItem, inputItem)) {
    return true;
  }
  if (!(isObjectRecord(responseItem) && isObjectRecord(inputItem))) {
    return false;
  }
  if (responseItem.type === "message") {
    return matchesMessageInput(responseItem, inputItem);
  }
  if (responseItem.type === "function_call") {
    return matchesFunctionCallInput(responseItem, inputItem);
  }
  if (responseItem.type === "reasoning") {
    return matchesReasoningInput(responseItem, inputItem);
  }
  return false;
};

const matchesLoweredResponseItems = (
  responseItems: readonly unknown[],
  inputItems: readonly unknown[]
): boolean => {
  if (responseItems.length !== inputItems.length) {
    return false;
  }
  return responseItems.every((responseItem, index) =>
    matchesLoweredResponseItem(responseItem, inputItems[index])
  );
};

const buildRequestBody = (
  webSocketBody: Record<string, unknown>,
  cached: CachedSocket | null
): Record<string, unknown> => {
  if (!cached) {
    return webSocketBody;
  }
  if (!cached.continuation) {
    return webSocketBody;
  }
  if (hasOwn(webSocketBody, "previous_response_id")) {
    return webSocketBody;
  }
  if (!Array.isArray(webSocketBody.input)) {
    cached.continuation = null;
    return webSocketBody;
  }

  const { continuation } = cached;
  if (!Array.isArray(continuation.lastRequestBody.input)) {
    cached.continuation = null;
    return webSocketBody;
  }
  if (
    !sameJson(
      withoutContinuationFields(webSocketBody),
      withoutContinuationFields(continuation.lastRequestBody)
    )
  ) {
    cached.continuation = null;
    return webSocketBody;
  }

  const baseline = [
    ...continuation.lastRequestBody.input,
    ...continuation.lastResponseItems,
  ];
  if (webSocketBody.input.length < baseline.length) {
    cached.continuation = null;
    return webSocketBody;
  }

  const prefix = webSocketBody.input.slice(0, baseline.length);
  if (!sameJson(prefix, baseline)) {
    const cachedInput = continuation.lastRequestBody.input;
    const responsePrefix = webSocketBody.input.slice(
      cachedInput.length,
      baseline.length
    );
    if (
      sameJson(webSocketBody.input.slice(0, cachedInput.length), cachedInput) &&
      matchesLoweredResponseItems(
        continuation.lastResponseItems,
        responsePrefix
      )
    ) {
      const delta = webSocketBody.input.slice(baseline.length);
      return {
        ...webSocketBody,
        previous_response_id: continuation.lastResponseId,
        input: delta,
      };
    }

    cached.continuation = null;
    return webSocketBody;
  }

  const delta = webSocketBody.input.slice(baseline.length);
  return {
    ...webSocketBody,
    previous_response_id: continuation.lastResponseId,
    input: delta,
  };
};

const encodeSse = (payload: unknown): Uint8Array =>
  textEncoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

const encodeDoneSse = (): Uint8Array => textEncoder.encode("data: [DONE]\n\n");

const decodeMessageData = async (data: unknown): Promise<string | null> => {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    );
  }
  if (isObjectRecord(data) && typeof data.arrayBuffer === "function") {
    const arrayBuffer = (await data.arrayBuffer()) as ArrayBuffer;
    return new TextDecoder().decode(new Uint8Array(arrayBuffer));
  }
  return null;
};

const readPayloadStatus = (payload: Record<string, unknown>): number => {
  const status = payload.status ?? payload.status_code;
  if (typeof status === "number" && status >= 400 && status <= 599) {
    return status;
  }

  const error = isObjectRecord(payload.error) ? payload.error : null;
  const response = isObjectRecord(payload.response) ? payload.response : null;
  const responseError = isObjectRecord(response?.error) ? response.error : null;
  const errorType = error?.type ?? responseError?.type;
  const errorCode = error?.code ?? responseError?.code;
  if (
    errorType === "usage_limit_reached" ||
    errorCode === "rate_limit_exceeded"
  ) {
    return 429;
  }

  return 502;
};

const isErrorPayload = (payload: Record<string, unknown>): boolean =>
  payload.type === "error" || payload.type === "response.failed";

const truncateLogValue = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
};

const readErrorField = (
  payload: Record<string, unknown>,
  key: string
): string | number | boolean | null | undefined => {
  const error = isObjectRecord(payload.error) ? payload.error : null;
  const response = isObjectRecord(payload.response) ? payload.response : null;
  const responseError = isObjectRecord(response?.error) ? response.error : null;
  const value = error?.[key] ?? responseError?.[key] ?? payload[key];
  if (typeof value === "string") {
    return truncateLogValue(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
};

const readErrorPayloadLogFields = (
  payload: Record<string, unknown>
): Record<string, string | number | boolean | null> => ({
  payloadType: String(payload.type),
  errorType: readErrorField(payload, "type") ?? null,
  errorCode: readErrorField(payload, "code") ?? null,
  errorMessage: readErrorField(payload, "message") ?? null,
  errorParam: readErrorField(payload, "param") ?? null,
  errorStatus: readErrorField(payload, "status") ?? null,
});

const isExpectedUsageLimitPayload = (
  payload: Record<string, unknown>
): boolean => {
  const errorType = readErrorField(payload, "type");
  const errorCode = readErrorField(payload, "code");
  return (
    errorType === "usage_limit_reached" ||
    errorType === "usage_not_included" ||
    errorType === "rate_limit_exceeded" ||
    errorCode === "usage_limit_reached" ||
    errorCode === "usage_not_included" ||
    errorCode === "rate_limit_exceeded"
  );
};

const isTerminalPayload = (payload: Record<string, unknown>): boolean =>
  payload.type === "response.completed" ||
  payload.type === "response.done" ||
  payload.type === "response.incomplete" ||
  isErrorPayload(payload);

const isConnectionLimitPayload = (payload: Record<string, unknown>): boolean =>
  payload.type === "error" &&
  isObjectRecord(payload.error) &&
  payload.error.code === CONNECTION_LIMIT_REACHED_CODE;

const isSessionConcurrencyError = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message === "Codex WebSocket session is busy" ||
    error.message === "Codex WebSocket session is connecting");

const isUserCancelledStage = (stage: string): boolean =>
  stage === "request_aborted" || stage === "downstream_cancel";

const isCacheableFinalEvent = (
  eventType: unknown,
  responseStatus: string | null
): boolean =>
  (eventType === "response.completed" || eventType === "response.done") &&
  (!responseStatus || responseStatus === "completed");

const buildWebSocketHeaders = (
  headers: Headers,
  requestId: string
): Headers => {
  const nextHeaders = new Headers(headers);
  nextHeaders.delete("accept");
  nextHeaders.delete("connection");
  nextHeaders.delete("content-length");
  nextHeaders.delete("content-type");
  nextHeaders.delete("host");
  nextHeaders.delete("openai-beta");
  nextHeaders.delete("transfer-encoding");
  nextHeaders.delete("upgrade");
  nextHeaders.set("OpenAI-Beta", CODEX_WEBSOCKET_BETA_HEADER);
  applyCodexSessionHeaders(nextHeaders, requestId);
  return nextHeaders;
};

export const tryProxyCodexWebSocket = async (
  input: CodexWebSocketInput
): Promise<Response | null> => {
  const body = input.bodyJson;
  if (
    !body ||
    readBooleanField(body, "stream") !== true ||
    readBooleanField(body, "background") === true
  ) {
    return null;
  }

  const sessionId = input.sessionId ?? readCodexSessionId(body, input.headers);
  const requestId = input.upstreamSessionId
    ? input.upstreamSessionId
    : sessionId
      ? await deriveCodexSessionId(input.accountKey, sessionId)
      : crypto.randomUUID();
  const cacheKey = sessionId ? `${input.accountKey}:${sessionId}` : null;
  const headers = buildWebSocketHeaders(input.headers, requestId);

  if (isCompactionRequest(body, input.headers)) {
    markSessionFallback(cacheKey);
    return null;
  }

  if (cacheKey && fallbackSocketKeys.has(cacheKey)) {
    return null;
  }

  let acquired: Awaited<ReturnType<typeof acquireSocket>> | null = null;
  const fullBody = withoutTransportFields(
    sessionId ? { ...body, prompt_cache_key: requestId } : body
  );
  let requestBody: Record<string, unknown>;
  let requestPayloadText: string;
  let requestBytes: number;
  try {
    acquired = await acquireSocket(headers, cacheKey, input.signal);
    requestBody = buildRequestBody(fullBody, acquired.cached);
    requestPayloadText = JSON.stringify({
      ...requestBody,
      type: "response.create",
    });
    requestBytes = textEncoder.encode(requestPayloadText).byteLength;
  } catch (error) {
    acquired?.release(false);
    if (!input.signal?.aborted && !isSessionConcurrencyError(error)) {
      recordSessionStreamFailure(cacheKey);
    }
    return null;
  }

  const active = acquired;
  const startedAt = Date.now();

  const responseItems: unknown[] = [];
  let responseId: string | null = null;
  let finalEventType: unknown = null;
  let finalResponseStatus: string | null = null;
  let keepSocket = true;
  let settled = false;
  let terminal = false;
  let failure: unknown = null;
  let emittedPayload = false;
  let connectionLimitAttempts = 0;
  let retryingConnectionLimit = false;
  let responseIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let clearStreamKeepAlive: (() => void) | null = null;
  let messageChain = Promise.resolve();
  let wake: (() => void) | null = null;
  const queue: Record<string, unknown>[] = [];

  const logStreamAnomaly = (event: string, fields = {}): void => {
    logWarn(event, {
      provider: "codex",
      transport: "websocket",
      elapsedMs: Date.now() - startedAt,
      hasSession: Boolean(sessionId),
      emittedPayload,
      terminal,
      queueLength: queue.length,
      connectionLimitAttempts,
      requestBytes,
      ...fields,
    });
  };

  const wakePull = (): void => {
    if (!wake) {
      return;
    }
    const resolve = wake;
    wake = null;
    resolve();
  };

  const clearResponseIdleTimer = (): void => {
    if (!responseIdleTimer) {
      return;
    }
    clearTimeout(responseIdleTimer);
    responseIdleTimer = null;
  };

  const resetResponseIdleTimer = (stage: string): void => {
    if (settled) {
      return;
    }
    clearResponseIdleTimer();
    responseIdleTimer = setTimeout(() => {
      fail(stage, new Error(stage));
    }, RESPONSE_IDLE_TIMEOUT_MS);
  };

  let firstPayloadResolve: ((payload: Record<string, unknown>) => void) | null =
    null;
  let firstPayloadReject: ((error: unknown) => void) | null = null;
  const firstPayload = new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      firstPayloadResolve = resolve;
      firstPayloadReject = reject;
    }
  );

  const cleanup = (): void => {
    clearResponseIdleTimer();
    active.socket.removeEventListener("message", onMessage);
    active.socket.removeEventListener("error", onError);
    active.socket.removeEventListener("close", onClose);
    input.signal?.removeEventListener("abort", onAbort);
  };

  const attachSocketListeners = (): void => {
    active.socket.addEventListener("message", onMessage);
    active.socket.addEventListener("error", onError);
    active.socket.addEventListener("close", onClose);
  };

  const sendRequest = (): void => {
    if (settled) {
      return;
    }
    if (input.signal?.aborted) {
      fail("request_aborted", new Error("Request was aborted"));
      return;
    }
    try {
      resetResponseIdleTimer("idle_timeout_sending_websocket_request");
      active.socket.send(requestPayloadText, (error?: Error) => {
        if (settled) {
          return;
        }
        if (error) {
          fail("send_failed", error);
          return;
        }
        resetResponseIdleTimer("idle_timeout_waiting_for_websocket");
      });
    } catch (error) {
      fail("send_failed", error);
    }
  };

  const retryConnectionLimit = async (): Promise<void> => {
    if (settled || retryingConnectionLimit) {
      return;
    }
    if (connectionLimitAttempts >= CONNECTION_LIMIT_RETRIES) {
      fail(
        "connection_limit_retries_exhausted",
        new Error(CONNECTION_LIMIT_REACHED_CODE)
      );
      return;
    }

    connectionLimitAttempts++;
    retryingConnectionLimit = true;
    clearResponseIdleTimer();
    active.socket.removeEventListener("message", onMessage);
    active.socket.removeEventListener("error", onError);
    active.socket.removeEventListener("close", onClose);
    terminateSocket(active.socket);

    try {
      const nextSocket = await connectWebSocket(headers, input.signal);
      active.socket = nextSocket;
      if (active.cached) {
        active.cached.socket = nextSocket;
        active.cached.connectedAt = Date.now();
      }
      attachSocketListeners();
      sendRequest();
    } catch (error) {
      fail("connection_limit_retry_failed", error);
    } finally {
      retryingConnectionLimit = false;
    }
  };

  const fail = (stage: string, error: unknown): void => {
    if (settled) {
      return;
    }
    settled = true;
    keepSocket = false;
    failure = error;
    clearStreamKeepAlive?.();
    cleanup();
    active.release(false);
    if (isUserCancelledStage(stage)) {
      logStreamAnomaly("codex_websocket_stream_cancelled", {
        stage,
        ...errorLogFields(error),
      });
    } else {
      const webSocketCloseCode = readWebSocketCloseCode(error);
      const immediateFallback =
        stage === "socket_closed_before_terminal" &&
        webSocketCloseCode !== null;
      if (immediateFallback) {
        markSessionFallback(cacheKey);
      }
      const failureCount = recordSessionStreamFailure(cacheKey);
      logStreamAnomaly("codex_websocket_stream_failed", {
        stage,
        failureCount,
        immediateFallback,
        webSocketCloseCode,
        ...errorLogFields(error),
      });
    }
    firstPayloadReject?.(error);
    wakePull();
  };

  const finish = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearStreamKeepAlive?.();
    cleanup();
    const canStoreContinuation = Boolean(
      active.cached &&
        keepSocket &&
        responseId &&
        isCacheableFinalEvent(finalEventType, finalResponseStatus) &&
        !active.cached.skipNextContinuationStore
    );
    if (active.cached) {
      if (canStoreContinuation && responseId) {
        active.cached.continuation = {
          lastRequestBody: fullBody,
          lastResponseId: responseId,
          lastResponseItems: responseItems,
        };
      } else {
        active.cached.continuation = null;
      }
      active.cached.skipNextContinuationStore = false;
    }
    if (isCacheableFinalEvent(finalEventType, finalResponseStatus)) {
      clearSessionStreamFailures(cacheKey);
    }
    active.release(keepSocket);
    wakePull();
  };

  const onAbort = (): void =>
    fail("request_aborted", new Error("Request was aborted"));

  const onError = (event: unknown): void =>
    fail("socket_error", extractWebSocketError(event));

  const onClose = (event: unknown): void => {
    messageChain = messageChain
      .then(() => {
        if (terminal) {
          wakePull();
          return;
        }
        fail(
          "socket_closed_before_terminal",
          extractWebSocketCloseError(event)
        );
      })
      .catch((error: unknown) => {
        fail("message_parse_failed", error);
      });
  };

  const handleMessage = async (event: unknown): Promise<void> => {
    if (settled) {
      return;
    }
    const text = await decodeMessageData(
      isObjectRecord(event) ? event.data : null
    );
    if (settled || !text) {
      return;
    }

    const payload = JSON.parse(text) as unknown;
    if (!isObjectRecord(payload)) {
      return;
    }
    resetResponseIdleTimer("idle_timeout_waiting_for_websocket");

    if (!emittedPayload && isConnectionLimitPayload(payload)) {
      retryConnectionLimit().catch((error: unknown) => {
        fail("connection_limit_retry_failed", error);
      });
      return;
    }

    if (isTerminalPayload(payload)) {
      clearResponseIdleTimer();
      terminal = true;
      finalEventType = payload.type;
      finalResponseStatus = isObjectRecord(payload.response)
        ? readString(payload.response.status)
        : null;
    }
    emittedPayload = true;
    queue.push(payload);
    if (queue.length === 1) {
      firstPayloadResolve?.(payload);
    }
    wakePull();
  };

  const onMessage = (event: unknown): void => {
    messageChain = messageChain
      .then(() => handleMessage(event))
      .catch((error: unknown) => {
        fail("message_parse_failed", error);
      });
  };

  attachSocketListeners();
  input.signal?.addEventListener("abort", onAbort);

  sendRequest();

  let first: Record<string, unknown>;
  try {
    first = await firstPayload;
  } catch {
    return null;
  }

  if (isErrorPayload(first)) {
    keepSocket = false;
    if (!isExpectedUsageLimitPayload(first)) {
      logStreamAnomaly("codex_websocket_error_payload", {
        responseStatus: finalResponseStatus,
        ...readErrorPayloadLogFields(first),
      });
    }
    finish();
    return Response.json(first, { status: readPayloadStatus(first) });
  }

  const processPayload = (
    payload: Record<string, unknown>,
    controller: ReadableStreamDefaultController<Uint8Array>
  ): void => {
    const usage = readOpenAiResponsesUsageFromSseEvent(payload);
    if (usage) {
      input.onTokenUsage?.(usage);
    }

    if (isObjectRecord(payload.response)) {
      responseId = readString(payload.response.id) ?? responseId;
    }
    if (payload.type === "response.output_item.done") {
      responseItems.push(payload.item);
    }

    controller.enqueue(encodeSse(payload));
    if (isTerminalPayload(payload)) {
      terminal = true;
      finalEventType = payload.type;
      finalResponseStatus = isObjectRecord(payload.response)
        ? readString(payload.response.status)
        : null;
      if (payload.type === "response.incomplete") {
        keepSocket = false;
        logStreamAnomaly("codex_websocket_response_incomplete", {
          responseStatus: finalResponseStatus,
        });
      }
      if (isErrorPayload(payload)) {
        keepSocket = false;
        if (!isExpectedUsageLimitPayload(payload)) {
          logStreamAnomaly("codex_websocket_error_payload", {
            responseStatus: finalResponseStatus,
            ...readErrorPayloadLogFields(payload),
          });
        }
      }
      controller.enqueue(encodeDoneSse());
      finish();
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      clearStreamKeepAlive = createSseKeepAlive(controller, {
        provider: "codex",
        transport: "websocket_sse",
        getElapsedMs: () => Date.now() - startedAt,
      }).clear;
    },
    async pull(controller): Promise<void> {
      while (!queue.length && !settled) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }

      if (queue.length) {
        const payload = queue.shift();
        if (payload) {
          try {
            processPayload(payload, controller);
          } catch (error) {
            fail("downstream_enqueue_failed", error);
            controller.error(error);
          }
        }
        return;
      }

      if (failure) {
        controller.error(failure);
        return;
      }

      controller.close();
    },
    cancel(): void {
      clearStreamKeepAlive?.();
      if (settled) {
        return;
      }
      fail("downstream_cancel", new Error("Response stream was cancelled"));
    },
  });

  return createSseResponse(stream);
};
