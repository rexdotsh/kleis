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
import { isObjectRecord, readBooleanField } from "../../utils/object";

const SESSION_SOCKET_TTL_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 15_000;
const RESPONSE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_SOCKET_AGE_MS = 55 * 60 * 1000;
const CONNECTION_LIMIT_RETRIES = 5;
const STREAM_FAILURE_RETRIES = 5;
const CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

type WebSocketLike = {
  readonly readyState?: number;
  close(code?: number, reason?: string): void;
  send(data: string): void;
  addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
  removeEventListener(
    type: WebSocketEventType,
    listener: WebSocketListener
  ): void;
};

type WebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | { headers?: Record<string, string> }
) => WebSocketLike;

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

type CacheDecision = {
  reason:
    | "delta"
    | "normalized_delta"
    | "no_cached_socket"
    | "no_continuation"
    | "explicit_previous_response_id"
    | "input_not_array"
    | "cached_input_not_array"
    | "non_input_mismatch"
    | "input_shorter_than_baseline"
    | "prefix_mismatch";
  currentInputItems: number | null;
  cachedInputItems: number | null;
  cachedResponseItems: number | null;
  baselineItems: number | null;
  deltaItems: number | null;
};

const socketCache = new Map<string, CachedSocket>();
const fallbackSocketKeys = new Map<string, ReturnType<typeof setTimeout>>();
const streamFailureCounts = new Map<string, number>();
const pendingSocketKeys = new Set<string>();
const suppressContinuationStoreKeys = new Set<string>();
let diagnosticRequestCounter = 0;

const nextDiagnosticRequestId = (): string => {
  diagnosticRequestCounter = (diagnosticRequestCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${diagnosticRequestCounter.toString(36)}`;
};

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
    headers: {
      "content-type": "text/event-stream",
    },
  });

const readString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
};

const inputItems = (body: Record<string, unknown>): number | null =>
  Array.isArray(body.input) ? body.input.length : null;

const emptyCacheDecision = (
  reason: CacheDecision["reason"],
  webSocketBody: Record<string, unknown>,
  cached: CachedSocket | null
): CacheDecision => ({
  reason,
  currentInputItems: inputItems(webSocketBody),
  cachedInputItems: cached?.continuation
    ? inputItems(cached.continuation.lastRequestBody)
    : null,
  cachedResponseItems: cached?.continuation?.lastResponseItems.length ?? null,
  baselineItems: null,
  deltaItems: null,
});

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
  return new Error(
    `WebSocket closed${codeText}${reasonText ? ` ${reasonText}` : ""}`.trim()
  );
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
  const websocket = globalThis.WebSocket;
  return typeof websocket === "function"
    ? (websocket as unknown as WebSocketConstructor)
    : null;
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
      closeSocket(socket);
      fail(new Error("Request was aborted"));
    };
    const onTimeout = (): void => {
      closeSocket(socket);
      fail(
        new Error(`WebSocket connect timeout after ${CONNECT_TIMEOUT_MS}ms`)
      );
    };

    try {
      socket = new WebSocketCtor(resolveCodexWebSocketUrl(), {
        headers: headersToRecord(headers),
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
      release: (): void => closeSocket(acquired.socket),
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
            closeSocket(existing.socket);
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
        closeSocket(cached.socket);
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
): { body: Record<string, unknown>; decision: CacheDecision } => {
  if (!cached) {
    return {
      body: webSocketBody,
      decision: emptyCacheDecision("no_cached_socket", webSocketBody, cached),
    };
  }
  if (!cached.continuation) {
    return {
      body: webSocketBody,
      decision: emptyCacheDecision("no_continuation", webSocketBody, cached),
    };
  }
  if (hasOwn(webSocketBody, "previous_response_id")) {
    return {
      body: webSocketBody,
      decision: emptyCacheDecision(
        "explicit_previous_response_id",
        webSocketBody,
        cached
      ),
    };
  }
  if (!Array.isArray(webSocketBody.input)) {
    const decision = emptyCacheDecision(
      "input_not_array",
      webSocketBody,
      cached
    );
    cached.continuation = null;
    return { body: webSocketBody, decision };
  }

  const { continuation } = cached;
  if (!Array.isArray(continuation.lastRequestBody.input)) {
    const decision = emptyCacheDecision(
      "cached_input_not_array",
      webSocketBody,
      cached
    );
    cached.continuation = null;
    return { body: webSocketBody, decision };
  }
  if (
    !sameJson(
      withoutContinuationFields(webSocketBody),
      withoutContinuationFields(continuation.lastRequestBody)
    )
  ) {
    const decision = emptyCacheDecision(
      "non_input_mismatch",
      webSocketBody,
      cached
    );
    cached.continuation = null;
    return { body: webSocketBody, decision };
  }

  const baseline = [
    ...continuation.lastRequestBody.input,
    ...continuation.lastResponseItems,
  ];
  if (webSocketBody.input.length < baseline.length) {
    const decision = {
      ...emptyCacheDecision(
        "input_shorter_than_baseline",
        webSocketBody,
        cached
      ),
      baselineItems: baseline.length,
    };
    cached.continuation = null;
    return { body: webSocketBody, decision };
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
        body: {
          ...webSocketBody,
          previous_response_id: continuation.lastResponseId,
          input: delta,
        },
        decision: {
          ...emptyCacheDecision("normalized_delta", webSocketBody, cached),
          baselineItems: baseline.length,
          deltaItems: delta.length,
        },
      };
    }

    const decision = {
      ...emptyCacheDecision("prefix_mismatch", webSocketBody, cached),
      baselineItems: baseline.length,
    };
    cached.continuation = null;
    return { body: webSocketBody, decision };
  }

  const delta = webSocketBody.input.slice(baseline.length);
  return {
    body: {
      ...webSocketBody,
      previous_response_id: continuation.lastResponseId,
      input: delta,
    },
    decision: {
      ...emptyCacheDecision("delta", webSocketBody, cached),
      baselineItems: baseline.length,
      deltaItems: delta.length,
    },
  };
};

const encodeSse = (payload: unknown): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);

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
  const status = payload.status;
  return typeof status === "number" && status >= 400 && status <= 599
    ? status
    : 502;
};

const isErrorPayload = (payload: Record<string, unknown>): boolean =>
  payload.type === "error" || payload.type === "response.failed";

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

const sessionHash = (sessionId: string | null | undefined): string | null =>
  sessionId ? sessionId.replace(/^kleis_/, "").slice(0, 16) : null;

const logCodexWebSocketDiagnostic = (
  payload: Record<string, unknown>
): void => {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
};

const errorShape = (error: unknown): Record<string, unknown> => ({
  name: error instanceof Error ? error.name : typeof error,
  message: error instanceof Error ? error.message : String(error),
});

const closeEventShape = (event: unknown): Record<string, unknown> | null => {
  if (!isObjectRecord(event)) {
    return null;
  }
  return {
    code: typeof event.code === "number" ? event.code : null,
    wasClean: typeof event.wasClean === "boolean" ? event.wasClean : null,
  };
};

const logCodexWebSocketLifecycle = (input: {
  diagnosticRequestId: string;
  model: unknown;
  upstreamSessionId: string | null;
  stage: string;
  elapsedMs: number;
  cacheDecision?: string;
  error?: unknown;
  closeEvent?: unknown;
  messagesReceived?: number;
  queueLength?: number;
  terminal?: boolean;
  settled?: boolean;
  failureSet?: boolean;
  sentInputItems?: number | null;
  hasPreviousResponseId?: boolean;
  retryAttempt?: number;
  streamFailures?: number;
  fallbackActive?: boolean;
}): void => {
  logCodexWebSocketDiagnostic({
    event: "codex_compaction_ws_lifecycle",
    diagnosticRequestId: input.diagnosticRequestId,
    model: readString(input.model),
    sessionHash: sessionHash(input.upstreamSessionId),
    stage: input.stage,
    elapsedMs: input.elapsedMs,
    cacheDecision: input.cacheDecision,
    ...(input.error ? { error: errorShape(input.error) } : {}),
    ...(input.closeEvent
      ? { closeEvent: closeEventShape(input.closeEvent) }
      : {}),
    messagesReceived: input.messagesReceived,
    queueLength: input.queueLength,
    terminal: input.terminal,
    settled: input.settled,
    failureSet: input.failureSet,
    sentInputItems: input.sentInputItems,
    hasPreviousResponseId: input.hasPreviousResponseId,
    retryAttempt: input.retryAttempt,
    streamFailures: input.streamFailures,
    fallbackActive: input.fallbackActive,
  });
};

const logCodexWebSocketDecision = (input: {
  diagnosticRequestId: string;
  model: unknown;
  upstreamSessionId: string | null;
  decision: CacheDecision;
  requestBody: Record<string, unknown>;
  firstEventType: unknown;
}): void => {
  logCodexWebSocketDiagnostic({
    event: "codex_compaction_ws_decision",
    diagnosticRequestId: input.diagnosticRequestId,
    model: readString(input.model),
    sessionHash: sessionHash(input.upstreamSessionId),
    cacheDecision: input.decision.reason,
    cachedDelta:
      input.decision.reason === "delta" ||
      input.decision.reason === "normalized_delta",
    currentInputItems: input.decision.currentInputItems,
    cachedInputItems: input.decision.cachedInputItems,
    cachedResponseItems: input.decision.cachedResponseItems,
    baselineItems: input.decision.baselineItems,
    deltaItems: input.decision.deltaItems,
    sentInputItems: inputItems(input.requestBody),
    hasPreviousResponseId:
      typeof input.requestBody.previous_response_id === "string",
    firstEventType: readString(input.firstEventType),
  });
};

const logCodexWebSocketStore = (input: {
  diagnosticRequestId: string;
  model: unknown;
  upstreamSessionId: string | null;
  elapsedMs: number;
  keptSocket: boolean;
  responseIdPresent: boolean;
  responseItems: number;
  storedContinuation: boolean;
  finalEventType: unknown;
  finalResponseStatus: string | null;
  skippedStore: boolean;
}): void => {
  logCodexWebSocketDiagnostic({
    event: "codex_compaction_ws_store",
    diagnosticRequestId: input.diagnosticRequestId,
    model: readString(input.model),
    sessionHash: sessionHash(input.upstreamSessionId),
    elapsedMs: input.elapsedMs,
    keptSocket: input.keptSocket,
    responseIdPresent: input.responseIdPresent,
    responseItems: input.responseItems,
    storedContinuation: input.storedContinuation,
    finalEventType: readString(input.finalEventType),
    finalResponseStatus: input.finalResponseStatus,
    skippedStore: input.skippedStore,
  });
};

const buildWebSocketHeaders = (
  headers: Headers,
  requestId: string
): Headers => {
  const nextHeaders = new Headers(headers);
  nextHeaders.delete("accept");
  nextHeaders.delete("content-type");
  nextHeaders.delete("openai-beta");
  nextHeaders.set("OpenAI-Beta", CODEX_WEBSOCKET_BETA_HEADER);
  applyCodexSessionHeaders(nextHeaders, requestId);
  return nextHeaders;
};

export const tryProxyCodexWebSocket = async (
  input: CodexWebSocketInput
): Promise<Response | null> => {
  const diagnosticRequestId = nextDiagnosticRequestId();
  const startedAt = Date.now();
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

  if (cacheKey && fallbackSocketKeys.has(cacheKey)) {
    logCodexWebSocketLifecycle({
      diagnosticRequestId,
      model: body.model,
      upstreamSessionId: input.upstreamSessionId ?? null,
      stage: "session_fallback_active",
      elapsedMs: Date.now() - startedAt,
      streamFailures: streamFailureCounts.get(cacheKey) ?? 0,
      fallbackActive: true,
    });
    return null;
  }

  let acquired: Awaited<ReturnType<typeof acquireSocket>> | null = null;
  const fullBody = withoutTransportFields(
    sessionId ? { ...body, prompt_cache_key: requestId } : body
  );
  let requestBody: Record<string, unknown>;
  let cacheDecision: CacheDecision;
  try {
    acquired = await acquireSocket(headers, cacheKey, input.signal);
    const builtRequest = buildRequestBody(fullBody, acquired.cached);
    requestBody = builtRequest.body;
    cacheDecision = builtRequest.decision;
  } catch (error) {
    acquired?.release(false);
    let streamFailures: number | undefined;
    if (!input.signal?.aborted && !isSessionConcurrencyError(error)) {
      streamFailures = recordSessionStreamFailure(cacheKey);
    }
    const fallbackActive = cacheKey
      ? fallbackSocketKeys.has(cacheKey)
      : undefined;
    logCodexWebSocketLifecycle({
      diagnosticRequestId,
      model: body.model,
      upstreamSessionId: input.upstreamSessionId ?? null,
      stage: "acquire_failed",
      elapsedMs: Date.now() - startedAt,
      error,
      ...(streamFailures === undefined ? {} : { streamFailures }),
      ...(fallbackActive === undefined ? {} : { fallbackActive }),
    });
    return null;
  }

  const active = acquired;

  const responseItems: unknown[] = [];
  let responseId: string | null = null;
  let finalEventType: unknown = null;
  let finalResponseStatus: string | null = null;
  let keepSocket = true;
  let settled = false;
  let terminal = false;
  let failure: unknown = null;
  let messagesReceived = 0;
  let emittedPayload = false;
  let connectionLimitAttempts = 0;
  let retryingConnectionLimit = false;
  let responseIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let messageChain = Promise.resolve();
  let wake: (() => void) | null = null;
  const queue: Record<string, unknown>[] = [];

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
    try {
      active.socket.send(
        JSON.stringify({ ...requestBody, type: "response.create" })
      );
      resetResponseIdleTimer("idle_timeout_waiting_for_websocket");
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
    closeSocket(active.socket);
    logCodexWebSocketLifecycle({
      diagnosticRequestId,
      model: requestBody.model,
      upstreamSessionId: input.upstreamSessionId ?? null,
      stage: "connection_limit_retry",
      elapsedMs: Date.now() - startedAt,
      cacheDecision: cacheDecision.reason,
      retryAttempt: connectionLimitAttempts,
      messagesReceived,
      queueLength: queue.length,
      terminal,
      settled,
      failureSet: Boolean(failure),
      sentInputItems: inputItems(requestBody),
      hasPreviousResponseId:
        typeof requestBody.previous_response_id === "string",
    });

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

  const fail = (stage: string, error: unknown, closeEvent?: unknown): void => {
    if (settled) {
      return;
    }
    settled = true;
    keepSocket = false;
    failure = error;
    cleanup();
    active.release(false);
    const streamFailures = isUserCancelledStage(stage)
      ? undefined
      : recordSessionStreamFailure(cacheKey);
    const fallbackActive = cacheKey
      ? fallbackSocketKeys.has(cacheKey)
      : undefined;
    logCodexWebSocketLifecycle({
      diagnosticRequestId,
      model: requestBody.model,
      upstreamSessionId: input.upstreamSessionId ?? null,
      stage,
      elapsedMs: Date.now() - startedAt,
      cacheDecision: cacheDecision.reason,
      error,
      closeEvent,
      messagesReceived,
      queueLength: queue.length,
      terminal,
      settled,
      failureSet: true,
      sentInputItems: inputItems(requestBody),
      hasPreviousResponseId:
        typeof requestBody.previous_response_id === "string",
      ...(streamFailures === undefined ? {} : { streamFailures }),
      ...(fallbackActive === undefined ? {} : { fallbackActive }),
    });
    firstPayloadReject?.(error);
    wakePull();
  };

  const finish = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    const skippedStore = active.cached?.skipNextContinuationStore ?? false;
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
    logCodexWebSocketStore({
      diagnosticRequestId,
      model: requestBody.model,
      upstreamSessionId: input.upstreamSessionId ?? null,
      elapsedMs: Date.now() - startedAt,
      keptSocket: keepSocket,
      responseIdPresent: Boolean(responseId),
      responseItems: responseItems.length,
      storedContinuation: canStoreContinuation,
      finalEventType,
      finalResponseStatus,
      skippedStore,
    });
    active.release(keepSocket);
    wakePull();
  };

  const onAbort = (): void =>
    fail("request_aborted", new Error("Request was aborted"));

  const onError = (event: unknown): void =>
    fail("socket_error", extractWebSocketError(event));

  const onClose = (event: unknown): void => {
    if (terminal) {
      logCodexWebSocketLifecycle({
        diagnosticRequestId,
        model: requestBody.model,
        upstreamSessionId: input.upstreamSessionId ?? null,
        stage: "socket_closed_after_terminal",
        elapsedMs: Date.now() - startedAt,
        cacheDecision: cacheDecision.reason,
        closeEvent: event,
        messagesReceived,
        queueLength: queue.length,
        terminal,
        settled,
        failureSet: Boolean(failure),
        sentInputItems: inputItems(requestBody),
        hasPreviousResponseId:
          typeof requestBody.previous_response_id === "string",
      });
      wakePull();
      return;
    }
    fail(
      "socket_closed_before_terminal",
      extractWebSocketCloseError(event),
      event
    );
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
    messagesReceived++;
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
      logCodexWebSocketLifecycle({
        diagnosticRequestId,
        model: requestBody.model,
        upstreamSessionId: input.upstreamSessionId ?? null,
        stage: "upstream_terminal_received",
        elapsedMs: Date.now() - startedAt,
        cacheDecision: cacheDecision.reason,
        messagesReceived,
        queueLength: queue.length,
        terminal,
        settled,
        failureSet: Boolean(failure),
        sentInputItems: inputItems(requestBody),
        hasPreviousResponseId:
          typeof requestBody.previous_response_id === "string",
      });
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
  } catch (error) {
    logCodexWebSocketLifecycle({
      diagnosticRequestId,
      model: requestBody.model,
      upstreamSessionId: input.upstreamSessionId ?? null,
      stage: "first_payload_failed",
      elapsedMs: Date.now() - startedAt,
      cacheDecision: cacheDecision.reason,
      error,
      messagesReceived,
      queueLength: queue.length,
      terminal,
      settled,
      failureSet: Boolean(failure),
      sentInputItems: inputItems(requestBody),
      hasPreviousResponseId:
        typeof requestBody.previous_response_id === "string",
      ...(cacheKey && streamFailureCounts.has(cacheKey)
        ? { streamFailures: streamFailureCounts.get(cacheKey) ?? 0 }
        : {}),
      ...(cacheKey ? { fallbackActive: fallbackSocketKeys.has(cacheKey) } : {}),
    });
    return null;
  }

  logCodexWebSocketDecision({
    diagnosticRequestId,
    model: requestBody.model,
    upstreamSessionId: input.upstreamSessionId ?? null,
    decision: cacheDecision,
    requestBody,
    firstEventType: first.type,
  });

  if (isErrorPayload(first)) {
    keepSocket = false;
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
      if (payload.type === "response.incomplete") {
        keepSocket = false;
      }
      if (isErrorPayload(payload)) {
        keepSocket = false;
      }
      terminal = true;
      finalEventType = payload.type;
      finalResponseStatus = isObjectRecord(payload.response)
        ? readString(payload.response.status)
        : null;
      finish();
    }
  };

  const stream = new ReadableStream<Uint8Array>({
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
      if (settled) {
        logCodexWebSocketLifecycle({
          diagnosticRequestId,
          model: requestBody.model,
          upstreamSessionId: input.upstreamSessionId ?? null,
          stage: "downstream_cancel_after_settled",
          elapsedMs: Date.now() - startedAt,
          cacheDecision: cacheDecision.reason,
          messagesReceived,
          queueLength: queue.length,
          terminal,
          settled,
          failureSet: Boolean(failure),
          sentInputItems: inputItems(requestBody),
          hasPreviousResponseId:
            typeof requestBody.previous_response_id === "string",
        });
        return;
      }
      fail("downstream_cancel", new Error("Response stream was cancelled"));
    },
  });

  return createSseResponse(stream);
};
