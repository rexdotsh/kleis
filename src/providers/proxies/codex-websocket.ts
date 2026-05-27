import {
  CODEX_RESPONSE_ENDPOINT,
  CODEX_WEBSOCKET_BETA_HEADER,
} from "../constants";
import { readOpenAiResponsesUsageFromSseEvent } from "../../usage/token-usage";
import type { TokenUsage } from "../../usage/token-usage";
import { isObjectRecord, readBooleanField } from "../../utils/object";

const SESSION_SOCKET_TTL_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 15_000;

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
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  continuation: ContinuationState | null;
  skipNextContinuationStore: boolean;
};

type CacheDecision = {
  reason:
    | "delta"
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
  firstMismatchIndex: number | null;
  currentNonInputKeys: string[];
  cachedNonInputKeys: string[];
  mismatchShapes: MismatchShapes | null;
};

type SafeItemShape = {
  type: string | null;
  role: string | null;
  hasId: boolean;
  hasCallId: boolean;
  contentTypes: string[];
  summaryCount: number | null;
  hasEncryptedContent: boolean;
};

type MismatchShapes = {
  expected: SafeItemShape;
  actual: SafeItemShape;
  responseItemTypes: string[];
};

const socketCache = new Map<string, CachedSocket>();
const pendingSocketKeys = new Set<string>();
const suppressContinuationStoreKeys = new Set<string>();

const emptyCacheDecision = (
  reason: CacheDecision["reason"],
  webSocketBody: Record<string, unknown>,
  cached: CachedSocket | null
): CacheDecision => ({
  reason,
  currentInputItems: Array.isArray(webSocketBody.input)
    ? webSocketBody.input.length
    : null,
  cachedInputItems: Array.isArray(cached?.continuation?.lastRequestBody.input)
    ? cached.continuation.lastRequestBody.input.length
    : null,
  cachedResponseItems: cached?.continuation?.lastResponseItems.length ?? null,
  baselineItems: null,
  deltaItems: null,
  firstMismatchIndex: null,
  currentNonInputKeys: Object.keys(
    withoutContinuationFields(webSocketBody)
  ).sort(),
  cachedNonInputKeys: Object.keys(
    cached?.continuation
      ? withoutContinuationFields(cached.continuation.lastRequestBody)
      : {}
  ).sort(),
  mismatchShapes: null,
});

const firstJsonMismatchIndex = (
  left: readonly unknown[],
  right: readonly unknown[]
): number | null => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (!sameJson(left[index], right[index])) {
      return index;
    }
  }
  return left.length === right.length ? null : length;
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

const readSessionId = (body: Record<string, unknown>, headers: Headers) =>
  readString(body.prompt_cache_key) ??
  readString(headers.get("session_id")) ??
  readString(headers.get("session-id")) ??
  readString(headers.get("x-session-affinity")) ??
  readString(headers.get("x-client-request-id"));

const isSocketOpen = (socket: WebSocketLike): boolean =>
  socket.readyState === undefined || socket.readyState === 1;

const closeSocket = (socket: WebSocketLike): void => {
  try {
    socket.close(1000, "done");
  } catch {
    // Ignore close failures from already-closed sockets.
  }
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
    const onError = (): void => fail(new Error("WebSocket error"));
    const onClose = (): void => fail(new Error("WebSocket closed"));
    const onAbort = (): void => {
      closeSocket(socket);
      fail(new Error("Request was aborted"));
    };
    const onTimeout = (): void => {
      closeSocket(socket);
      fail(new Error("WebSocket connect timed out"));
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
    return {
      socket,
      cached: null,
      release: () => closeSocket(socket),
    };
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

    if (isSocketOpen(existing.socket)) {
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
      if (!(keep && isSocketOpen(socket))) {
        closeSocket(socket);
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

const matchesMessageInput = (
  responseItem: Record<string, unknown>,
  inputItem: Record<string, unknown>
): boolean =>
  (responseItem.role === undefined || responseItem.role === "assistant") &&
  inputItem.role === "assistant" &&
  matchesOptionalField(inputItem, responseItem, "id") &&
  matchesOptionalField(inputItem, responseItem, "status") &&
  matchesOptionalField(inputItem, responseItem, "type") &&
  Array.isArray(inputItem.content) &&
  sameJson(inputItem.content, responseItem.content);

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
  return (
    inputItem.type === "reasoning" &&
    inputItem.id === responseItem.id &&
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

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const deriveSessionId = async (
  accountKey: string,
  sessionId: string
): Promise<string> => {
  const data = new TextEncoder().encode(`${accountKey}:${sessionId}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `kleis_${toHex(new Uint8Array(digest)).slice(0, 48)}`;
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
    cached.continuation = null;
    return {
      body: webSocketBody,
      decision: emptyCacheDecision("input_not_array", webSocketBody, cached),
    };
  }

  const { continuation } = cached;
  if (!Array.isArray(continuation.lastRequestBody.input)) {
    const decision = emptyCacheDecision(
      "cached_input_not_array",
      webSocketBody,
      cached
    );
    cached.continuation = null;
    return {
      body: webSocketBody,
      decision,
    };
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
    return {
      body: webSocketBody,
      decision,
    };
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
    return {
      body: webSocketBody,
      decision,
    };
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
          ...emptyCacheDecision("delta", webSocketBody, cached),
          baselineItems: baseline.length,
          deltaItems: delta.length,
        },
      };
    }

    const firstMismatchIndex = firstJsonMismatchIndex(prefix, baseline);
    const firstMismatchShapes =
      firstMismatchIndex === null
        ? null
        : mismatchShapes(
            baseline[firstMismatchIndex],
            prefix[firstMismatchIndex],
            continuation.lastResponseItems
          );
    const decision = {
      ...emptyCacheDecision("prefix_mismatch", webSocketBody, cached),
      baselineItems: baseline.length,
      firstMismatchIndex,
      mismatchShapes: firstMismatchShapes,
    };
    cached.continuation = null;
    return {
      body: webSocketBody,
      decision,
    };
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

const decodeMessageData = (data: unknown): string | null => {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
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

const isCacheableFinalEvent = (
  eventType: unknown,
  responseStatus: string | null
): boolean =>
  (eventType === "response.completed" || eventType === "response.done") &&
  (!responseStatus || responseStatus === "completed");

const safeHeaderNames = (headers: Headers): string[] => {
  const sensitive = new Set([
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
    "x-api-key",
  ]);
  return Array.from(headers.keys())
    .map((header) => header.toLowerCase())
    .filter((header) => !sensitive.has(header))
    .sort();
};

const safeString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const SAFE_ITEM_LABELS = new Set([
  "assistant",
  "computer_use_call",
  "file_search_call",
  "function_call",
  "function_call_output",
  "image_generation_call",
  "input_image",
  "input_text",
  "item_reference",
  "local_shell_call",
  "mcp_call",
  "message",
  "output_text",
  "reasoning",
  "summary_text",
  "system",
  "user",
  "web_search_call",
  "web_search_preview_call",
]);

const safeItemLabel = (value: unknown): string | null => {
  const label = safeString(value);
  if (!label) {
    return null;
  }
  return SAFE_ITEM_LABELS.has(label) ? label : "other";
};

const safeItemShape = (item: unknown): SafeItemShape => {
  if (!isObjectRecord(item)) {
    return {
      type: null,
      role: null,
      hasId: false,
      hasCallId: false,
      contentTypes: [],
      summaryCount: null,
      hasEncryptedContent: false,
    };
  }

  const contentTypes = Array.isArray(item.content)
    ? item.content
        .map((content) =>
          isObjectRecord(content) ? safeItemLabel(content.type) : null
        )
        .filter((type) => type !== null)
    : [];

  return {
    type: safeItemLabel(item.type),
    role: safeItemLabel(item.role),
    hasId: typeof item.id === "string",
    hasCallId: typeof item.call_id === "string",
    contentTypes,
    summaryCount: Array.isArray(item.summary) ? item.summary.length : null,
    hasEncryptedContent: typeof item.encrypted_content === "string",
  };
};

const safeItemType = (item: unknown): string => {
  if (!isObjectRecord(item)) {
    return typeof item;
  }
  return safeItemLabel(item.type) ?? safeItemLabel(item.role) ?? "object";
};

const mismatchShapes = (
  expected: unknown,
  actual: unknown,
  responseItems: readonly unknown[]
): MismatchShapes => ({
  expected: safeItemShape(expected),
  actual: safeItemShape(actual),
  responseItemTypes: responseItems.map(safeItemType),
});

const readSessionSource = (
  body: Record<string, unknown>,
  headers: Headers
): string => {
  if (readString(body.prompt_cache_key)) {
    return "prompt_cache_key";
  }
  for (const header of [
    "session_id",
    "session-id",
    "x-session-affinity",
    "x-client-request-id",
  ]) {
    if (readString(headers.get(header))) {
      return header;
    }
  }
  return "none";
};

const logCodexWebSocketEvent = (payload: Record<string, unknown>): void => {
  try {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } catch {
    // Diagnostics must never interfere with proxy cleanup.
  }
};

const logCodexWebSocketUse = (input: {
  model: unknown;
  sessionSource: string;
  cacheDecision: CacheDecision;
  inputItems: unknown;
  requestBody: Record<string, unknown>;
  incomingHeaders: Headers;
  firstEventType?: unknown;
}): void => {
  logCodexWebSocketEvent({
    event: "codex_websocket_proxy",
    model: readString(input.model) ?? null,
    sessionSource: input.sessionSource,
    cachedDelta: input.cacheDecision.reason === "delta",
    cacheDecision: input.cacheDecision.reason,
    currentInputItems: input.cacheDecision.currentInputItems,
    cachedInputItems: input.cacheDecision.cachedInputItems,
    cachedResponseItems: input.cacheDecision.cachedResponseItems,
    baselineItems: input.cacheDecision.baselineItems,
    deltaItems: input.cacheDecision.deltaItems,
    firstMismatchIndex: input.cacheDecision.firstMismatchIndex,
    mismatchShapes: input.cacheDecision.mismatchShapes,
    inputItems: Array.isArray(input.inputItems)
      ? input.inputItems.length
      : null,
    hasPreviousResponseId:
      typeof input.requestBody.previous_response_id === "string",
    hasPromptCacheKey: typeof input.requestBody.prompt_cache_key === "string",
    currentNonInputKeys: input.cacheDecision.currentNonInputKeys,
    cachedNonInputKeys: input.cacheDecision.cachedNonInputKeys,
    incomingHeaderNames: safeHeaderNames(input.incomingHeaders),
    incomingSessionHeaders: {
      session_id: Boolean(readString(input.incomingHeaders.get("session_id"))),
      sessionId: Boolean(readString(input.incomingHeaders.get("session-id"))),
      xSessionAffinity: Boolean(
        readString(input.incomingHeaders.get("x-session-affinity"))
      ),
      xClientRequestId: Boolean(
        readString(input.incomingHeaders.get("x-client-request-id"))
      ),
    },
    firstEventType: readString(input.firstEventType) ?? null,
  });
};

const logCodexWebSocketStore = (input: {
  model: unknown;
  sessionSource: string;
  keptSocket: boolean;
  responseIdPresent: boolean;
  responseItems: number;
  terminal: boolean;
  cached: boolean;
  finalEventType: unknown;
}): void => {
  logCodexWebSocketEvent({
    event: "codex_websocket_cache_store",
    model: readString(input.model) ?? null,
    sessionSource: input.sessionSource,
    keptSocket: input.keptSocket,
    responseIdPresent: input.responseIdPresent,
    responseItems: input.responseItems,
    terminal: input.terminal,
    cached: input.cached,
    finalEventType: readString(input.finalEventType) ?? null,
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
  nextHeaders.set("session_id", requestId);
  nextHeaders.set("x-client-request-id", requestId);
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

  const sessionId = readSessionId(body, input.headers);
  const sessionSource = readSessionSource(body, input.headers);
  const requestId = sessionId
    ? await deriveSessionId(input.accountKey, sessionId)
    : crypto.randomUUID();
  const cacheKey = sessionId ? `${input.accountKey}:${sessionId}` : null;
  const headers = buildWebSocketHeaders(input.headers, requestId);

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
  } catch {
    acquired?.release(false);
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
    active.socket.removeEventListener("message", onMessage);
    active.socket.removeEventListener("error", onError);
    active.socket.removeEventListener("close", onClose);
    input.signal?.removeEventListener("abort", onAbort);
  };

  const fail = (error: unknown): void => {
    if (settled) {
      return;
    }
    settled = true;
    keepSocket = false;
    failure = error;
    cleanup();
    active.release(false);
    firstPayloadReject?.(error);
    wakePull();
  };

  const finish = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    if (active.cached) {
      if (
        keepSocket &&
        responseId &&
        isCacheableFinalEvent(finalEventType, finalResponseStatus) &&
        !active.cached.skipNextContinuationStore
      ) {
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
    logCodexWebSocketStore({
      model: requestBody.model,
      sessionSource,
      keptSocket: keepSocket,
      responseIdPresent: Boolean(responseId),
      responseItems: responseItems.length,
      terminal,
      cached: Boolean(active.cached),
      finalEventType,
    });
    active.release(keepSocket);
    wakePull();
  };

  const onAbort = (): void => fail(new Error("Request was aborted"));

  const onError = (): void => fail(new Error("WebSocket error"));

  const onClose = (): void => {
    if (terminal) {
      wakePull();
      return;
    }
    fail(new Error("WebSocket closed"));
  };

  const onMessage = (event: unknown): void => {
    try {
      const text = decodeMessageData(isObjectRecord(event) ? event.data : null);
      if (!text) {
        return;
      }

      const payload = JSON.parse(text) as unknown;
      if (!isObjectRecord(payload)) {
        return;
      }

      if (
        payload.type === "response.completed" ||
        payload.type === "response.done" ||
        payload.type === "response.incomplete" ||
        isErrorPayload(payload)
      ) {
        terminal = true;
        finalEventType = payload.type;
        finalResponseStatus = isObjectRecord(payload.response)
          ? readString(payload.response.status)
          : null;
      }
      queue.push(payload);
      if (queue.length === 1) {
        firstPayloadResolve?.(payload);
      }
      wakePull();
    } catch (error) {
      fail(error);
    }
  };

  active.socket.addEventListener("message", onMessage);
  active.socket.addEventListener("error", onError);
  active.socket.addEventListener("close", onClose);
  input.signal?.addEventListener("abort", onAbort);

  try {
    active.socket.send(
      JSON.stringify({ ...requestBody, type: "response.create" })
    );
  } catch (error) {
    fail(error);
  }

  let first: Record<string, unknown>;
  try {
    first = await firstPayload;
  } catch {
    return null;
  }

  logCodexWebSocketUse({
    model: requestBody.model,
    sessionSource,
    cacheDecision,
    inputItems: requestBody.input,
    requestBody,
    incomingHeaders: input.headers,
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
    if (
      payload.type === "response.completed" ||
      payload.type === "response.done" ||
      payload.type === "response.incomplete"
    ) {
      terminal = true;
      finalEventType = payload.type;
      finalResponseStatus = isObjectRecord(payload.response)
        ? readString(payload.response.status)
        : null;
      finish();
    } else if (isErrorPayload(payload)) {
      keepSocket = false;
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
          processPayload(payload, controller);
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
        return;
      }
      fail(new Error("Response stream was cancelled"));
    },
  });

  return createSseResponse(stream);
};
