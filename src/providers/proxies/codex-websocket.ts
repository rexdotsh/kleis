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
};

const socketCache = new Map<string, CachedSocket>();

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

  const socket = await connectWebSocket(headers, signal);
  const cached: CachedSocket = {
    socket,
    busy: true,
    idleTimer: null,
    continuation: null,
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
): Record<string, unknown> => {
  if (
    !cached?.continuation ||
    !Array.isArray(webSocketBody.input) ||
    hasOwn(webSocketBody, "previous_response_id")
  ) {
    return webSocketBody;
  }

  const { continuation } = cached;
  if (
    !sameJson(
      withoutContinuationFields(webSocketBody),
      withoutContinuationFields(continuation.lastRequestBody)
    ) ||
    !Array.isArray(continuation.lastRequestBody.input)
  ) {
    cached.continuation = null;
    return webSocketBody;
  }

  const baseline = [
    ...continuation.lastRequestBody.input,
    ...continuation.lastResponseItems,
  ];
  const prefix = webSocketBody.input.slice(0, baseline.length);
  if (!sameJson(prefix, baseline)) {
    cached.continuation = null;
    return webSocketBody;
  }

  return {
    ...webSocketBody,
    previous_response_id: continuation.lastResponseId,
    input: webSocketBody.input.slice(baseline.length),
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
  try {
    acquired = await acquireSocket(headers, cacheKey, input.signal);
    requestBody = buildRequestBody(fullBody, acquired.cached);
  } catch {
    acquired?.release(false);
    return null;
  }

  const active = acquired;

  const responseItems: unknown[] = [];
  let responseId: string | null = null;
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
    if (keepSocket && active.cached && responseId) {
      active.cached.continuation = {
        lastRequestBody: fullBody,
        lastResponseId: responseId,
        lastResponseItems: responseItems,
      };
    } else if (active.cached) {
      active.cached.continuation = null;
    }
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
      finish();
    } else if (isErrorPayload(payload)) {
      keepSocket = false;
      terminal = true;
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
