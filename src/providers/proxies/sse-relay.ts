import type { TokenUsage } from "../../usage/token-usage";
import { hashLogId, logError, logWarn, type LogFields } from "../../utils/log";
import { createSseEventFramer } from "./sse-events";
import { createSseKeepAlive, createSseResponseHeaders } from "./sse-keepalive";

type RelayContext = {
  startedAt: number;
  requestId: string | null;
  log(event: string, fields?: LogFields): void;
};

export const createSseRelay = (input: {
  response: Response;
  provider: "codex" | "claude";
  providerAccountId?: string | undefined;
  transport: "sse" | "sse_transform";
  streamFailedEvent: string;
  invalidFrameEvent?: string;
  keepAliveIntervalMs?: number | undefined;
  onTokenUsage?: ((usage: TokenUsage) => void) | null | undefined;
  onStreamEnd?: ((statusCode: number) => void) | null | undefined;
  createProtocol(context: RelayContext): {
    transformEvent(event: string): string;
    getUsage(): TokenUsage | null;
    getEndStatus(): number | null;
    onEof(rest: string): void;
  };
}): Response => {
  if (!input.response.body) {
    return input.response;
  }
  const reader = input.response.body.getReader();
  const framer = createSseEventFramer();
  const encoder = new TextEncoder();
  const validationDecoder = input.invalidFrameEvent
    ? new TextDecoder("utf-8", { fatal: true })
    : null;
  const startedAt = Date.now();
  const requestId =
    input.response.headers.get("x-request-id") ??
    input.response.headers.get("request-id");
  let bytes = 0;
  let chunks = 0;
  let lastChunkAt = startedAt;
  let lastWriteAt = startedAt;
  let closed = false;
  let utf8ValidationEnabled = true;
  let clearKeepAlive: (() => void) | undefined;
  const log = (event: string, fields: LogFields = {}, failed = false): void => {
    (failed ? logError : logWarn)(event, {
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      transport: input.transport,
      requestIdHash: hashLogId(requestId),
      elapsedMs: Date.now() - startedAt,
      idleMs: Date.now() - lastChunkAt,
      downstreamIdleMs: Date.now() - lastWriteAt,
      bytes,
      chunks,
      ...fields,
    });
  };
  const protocol = input.createProtocol({ startedAt, requestId, log });
  const transformEvent = protocol.transformEvent;
  const transformEvents = (events: string[]): string => {
    let output = "";
    for (const event of events) {
      output += transformEvent(event);
    }
    return output;
  };
  const validateUtf8 = (value?: Uint8Array): void => {
    if (
      !utf8ValidationEnabled ||
      !validationDecoder ||
      !input.invalidFrameEvent
    )
      return;
    try {
      validationDecoder.decode(value, { stream: value !== undefined });
    } catch {
      utf8ValidationEnabled = false;
      log(input.invalidFrameEvent, {
        parseCategory: "invalid_utf8",
        ...(value ? { frameBytes: value.byteLength } : {}),
      });
    }
  };
  const finish = (fallbackStatus: number): void => {
    if (closed) return;
    closed = true;
    clearKeepAlive?.();
    const usage = protocol.getUsage();
    // Usage goes first so the request recorded at the end includes it.
    if (usage) input.onTokenUsage?.(usage);
    input.onStreamEnd?.(
      input.response.ok
        ? (protocol.getEndStatus() ?? fallbackStatus)
        : input.response.status
    );
  };
  const cancelReader = async (reason?: unknown): Promise<void> => {
    try {
      await reader.cancel(reason);
    } finally {
      reader.releaseLock();
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      clearKeepAlive = createSseKeepAlive(controller, {
        onKeepAlive: () => {
          lastWriteAt = Date.now();
        },
        ...(input.keepAliveIntervalMs
          ? { intervalMs: input.keepAliveIntervalMs }
          : {}),
      }).clear;
    },
    async pull(controller): Promise<void> {
      try {
        while (!closed) {
          const { done, value } = await reader.read();
          if (closed) return;
          if (done) {
            const { events, rest } = framer.end();
            if (validationDecoder) validateUtf8();
            const output =
              transformEvents(events) + (rest ? transformEvent(rest) : "");
            if (output) {
              controller.enqueue(encoder.encode(output));
              lastWriteAt = Date.now();
            }
            protocol.onEof(rest);
            finish(502);
            reader.releaseLock();
            controller.close();
            return;
          }
          if (!value) continue;
          bytes += value.byteLength;
          chunks++;
          lastChunkAt = Date.now();
          if (validationDecoder) validateUtf8(value);
          const events = framer.push(value);
          if (events.length) {
            controller.enqueue(encoder.encode(transformEvents(events)));
            lastWriteAt = Date.now();
            return;
          }
        }
      } catch (error) {
        if (closed) return;
        finish(502);
        cancelReader(error).catch(() => undefined);
        log(
          input.streamFailedEvent,
          {
            errorName: error instanceof TypeError ? "TypeError" : "Error",
            errorCategory:
              error instanceof Error &&
              error.message === "SSE event exceeds the proxy buffer limit"
                ? "event_buffer_limit"
                : "stream_read_failed",
          },
          true
        );
        controller.error(error);
      }
    },
    cancel(reason): Promise<void> {
      if (closed) return Promise.resolve();
      // 499: the client closed the request.
      finish(499);
      return cancelReader(reason);
    },
  });
  return new Response(stream, {
    status: input.response.status,
    statusText: input.response.statusText,
    headers: createSseResponseHeaders(input.response.headers),
  });
};
