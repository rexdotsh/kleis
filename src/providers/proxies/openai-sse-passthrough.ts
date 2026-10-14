import type { TokenUsage } from "../../usage/token-usage";
import { errorLogFields, logError, logWarn } from "../../utils/log";
import { isObjectRecord } from "../../utils/object";
import { createCodexStreamDiagnostics } from "./codex-stream-diagnostics";
import { readUpstreamErrorFields } from "./upstream-error";
import {
  normalizeOpenAiResponsesEvent,
  type OpenAiResponsesEventShapeIssue,
  readOpenAiResponsesEventShapeIssue,
} from "./openai-responses-event";
import {
  createSseEventFramer,
  readSseData,
  replaceSseData,
} from "./sse-events";
import { createSseKeepAlive, createSseResponseHeaders } from "./sse-keepalive";

type SseUsageExtractor = (payload: unknown) => TokenUsage | null;

type OpenAiSsePassthroughInput = {
  response: Response;
  providerAccountId?: string | undefined;
  extractUsage: SseUsageExtractor;
  onTokenUsage?: ((usage: TokenUsage) => void) | null | undefined;
  keepAliveIntervalMs?: number;
};

type SseTerminalAnomaly = Record<string, string | number | boolean | null>;

const readSseTerminalAnomaly = (
  payload: unknown
): SseTerminalAnomaly | null => {
  if (!isObjectRecord(payload)) {
    return null;
  }

  if (payload.type === "response.incomplete") {
    const response = isObjectRecord(payload.response) ? payload.response : null;
    const incompleteDetails = isObjectRecord(response?.incomplete_details)
      ? response.incomplete_details
      : null;
    if (incompleteDetails?.reason === "max_output_tokens") {
      return null;
    }
    return {
      terminalAnomaly: "response.incomplete",
      responseStatus: "incomplete",
      incompleteReason:
        incompleteDetails?.reason === "content_filter"
          ? "content_filter"
          : "unknown",
    };
  }
  if (payload.type === "response.failed" || payload.type === "error") {
    const response = isObjectRecord(payload.response) ? payload.response : null;
    return {
      terminalAnomaly: String(payload.type),
      responseStatus: response?.status === "failed" ? "failed" : "unknown",
      ...readUpstreamErrorFields(payload),
    };
  }

  return null;
};

const tryParseJson = (value: string): unknown | null => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const transformSseEvent = (
  chunk: string,
  state: {
    latestUsage: TokenUsage | null;
    terminalAnomaly: SseTerminalAnomaly | null;
    sawTerminal: boolean;
  },
  extractUsage: SseUsageExtractor,
  onInvalidJson: (input: { bytes: number; lines: number }) => void,
  onInvalidShape: (issue: OpenAiResponsesEventShapeIssue) => void,
  trackDiagnostics: (payload: Record<string, unknown>) => void
): string => {
  const payloadText = readSseData(chunk);
  if (!payloadText) {
    return chunk;
  }

  const jsonPayload = tryParseJson(payloadText);
  if (!isObjectRecord(jsonPayload)) {
    onInvalidJson({
      bytes: Buffer.byteLength(payloadText),
      lines: payloadText.split("\n").length,
    });
    return chunk;
  }

  const shapeIssue = readOpenAiResponsesEventShapeIssue(jsonPayload);
  if (shapeIssue) {
    onInvalidShape(shapeIssue);
  }
  trackDiagnostics(jsonPayload);
  const normalized = state.sawTerminal
    ? jsonPayload
    : normalizeOpenAiResponsesEvent(jsonPayload);
  if (
    normalized.type === "response.completed" ||
    normalized.type === "response.incomplete" ||
    normalized.type === "response.failed" ||
    normalized.type === "error"
  ) {
    state.sawTerminal = true;
  }
  state.terminalAnomaly =
    readSseTerminalAnomaly(normalized) ?? state.terminalAnomaly;
  const usage = extractUsage(normalized);
  if (usage) {
    state.latestUsage = usage;
  }
  return normalized === jsonPayload
    ? chunk
    : replaceSseData(
        chunk,
        JSON.stringify(normalized),
        String(normalized.type)
      );
};

export const createOpenAiSseUsagePassthrough = (
  input: OpenAiSsePassthroughInput
): Response => {
  if (!input.response.body) {
    return input.response;
  }

  const reader = input.response.body.getReader();
  const framer = createSseEventFramer();
  const validationDecoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const contentType = (
    input.response.headers.get("content-type") ?? ""
  ).toLowerCase();
  // Codex omits the content-type header on SSE streams; anything explicitly
  // non-SSE (e.g. JSON error bodies) must not receive keepalive comments.
  const isSseBody = !contentType || contentType.includes("text/event-stream");
  const usageState = {
    latestUsage: null as TokenUsage | null,
    terminalAnomaly: null as SseTerminalAnomaly | null,
    sawTerminal: false,
  };
  let usageReported = false;
  const reportUsage = (): void => {
    if (usageReported || !usageState.latestUsage) {
      return;
    }
    usageReported = true;
    input.onTokenUsage?.(usageState.latestUsage);
  };
  const trackDiagnostics = createCodexStreamDiagnostics({
    providerAccountId: input.providerAccountId,
    requestId:
      input.response.headers.get("x-request-id") ??
      input.response.headers.get("request-id"),
    transport: "sse",
    startedAt,
  });
  let bytes = 0;
  let chunks = 0;
  let lastChunkAt = startedAt;
  let lastWriteAt = startedAt;
  let closed = false;
  let utf8ValidationEnabled = true;
  let clearKeepAlive: (() => void) | null = null;

  const logStreamAnomaly = (
    event: string,
    fields: Record<string, string | number | boolean | null> = {},
    error?: unknown
  ): void => {
    const log = error === undefined ? logWarn : logError;
    log(event, {
      provider: "codex",
      providerAccountId: input.providerAccountId,
      transport: "sse",
      requestId:
        input.response.headers.get("x-request-id") ??
        input.response.headers.get("request-id") ??
        null,
      elapsedMs: Date.now() - startedAt,
      idleMs: Date.now() - lastChunkAt,
      downstreamIdleMs: Date.now() - lastWriteAt,
      bytes,
      chunks,
      ...fields,
      ...(error === undefined ? {} : errorLogFields(error)),
    });
  };

  const reportInvalidJson = (details: {
    bytes: number;
    lines: number;
  }): void => {
    logStreamAnomaly("openai_sse_invalid_json", {
      eventDataBytes: details.bytes,
      eventDataLines: details.lines,
      parseCategory: "invalid_json_or_non_object",
    });
  };

  const reportInvalidShape = (issue: OpenAiResponsesEventShapeIssue): void => {
    logStreamAnomaly("openai_sse_invalid_shape", {
      parseCategory: "invalid_field_type",
      eventType: issue.eventType,
      fields: issue.fields,
    });
  };

  const transformEvent = (event: string): string =>
    transformSseEvent(
      event,
      usageState,
      input.extractUsage,
      reportInvalidJson,
      reportInvalidShape,
      trackDiagnostics
    );
  const transformEvents = (events: string[]): string => {
    let output = "";
    for (const event of events) {
      output += transformEvent(event);
    }
    return output;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      if (!isSseBody) {
        return;
      }
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
        while (true) {
          let result = await reader.read();
          while (!(result.done || result.value)) {
            result = await reader.read();
          }

          if (result.done) {
            if (closed) {
              clearKeepAlive?.();
              return;
            }
            const { events, rest } = framer.end();
            if (utf8ValidationEnabled) {
              try {
                validationDecoder.decode();
              } catch {
                logStreamAnomaly("openai_sse_invalid_frame", {
                  parseCategory: "invalid_utf8",
                });
              }
            }
            let output = transformEvents(events);
            if (isSseBody && rest.trim()) {
              output += transformEvent(rest);
              logStreamAnomaly("openai_sse_truncated_event", {
                pendingBytes: Buffer.byteLength(rest),
                parseCategory: "truncated_event",
              });
            } else {
              output += rest;
            }
            if (output) {
              controller.enqueue(encoder.encode(output));
            }
            reportUsage();
            if (input.response.ok && usageState.terminalAnomaly) {
              logStreamAnomaly(
                "openai_sse_terminal_anomaly",
                usageState.terminalAnomaly
              );
            }
            closed = true;
            clearKeepAlive?.();
            controller.close();
            return;
          }

          const value = result.value;
          bytes += value.byteLength;
          chunks++;
          lastChunkAt = Date.now();
          if (!isSseBody) {
            controller.enqueue(value);
            lastWriteAt = Date.now();
            return;
          }

          if (utf8ValidationEnabled) {
            try {
              validationDecoder.decode(value, { stream: true });
            } catch {
              utf8ValidationEnabled = false;
              logStreamAnomaly("openai_sse_invalid_frame", {
                parseCategory: "invalid_utf8",
                frameBytes: value.byteLength,
              });
            }
          }
          const events = framer.push(value);
          if (events.length) {
            controller.enqueue(encoder.encode(transformEvents(events)));
            lastWriteAt = Date.now();
            return;
          }
        }
      } catch (error) {
        if (closed) {
          clearKeepAlive?.();
          return;
        }
        closed = true;
        clearKeepAlive?.();
        reportUsage();
        reader.cancel(error).catch(() => undefined);
        logStreamAnomaly("openai_sse_stream_failed", {}, error);
        controller.error(error);
      }
    },
    cancel(reason): Promise<void> {
      closed = true;
      clearKeepAlive?.();
      reportUsage();
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: input.response.status,
    statusText: input.response.statusText,
    headers: createSseResponseHeaders(input.response.headers),
  });
};
