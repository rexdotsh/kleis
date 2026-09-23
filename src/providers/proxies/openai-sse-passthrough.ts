import type { TokenUsage } from "../../usage/token-usage";
import { errorLogFields, logWarn } from "../../utils/log";
import { isObjectRecord } from "../../utils/object";
import {
  normalizeOpenAiResponsesEvent,
  type OpenAiResponsesEventShapeIssue,
  readOpenAiResponsesEventShapeIssue,
} from "./openai-responses-event";
import { createSseKeepAlive, createSseResponseHeaders } from "./sse-keepalive";

type SseUsageExtractor = (payload: unknown) => TokenUsage | null;
const MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

type OpenAiSsePassthroughInput = {
  response: Response;
  extractUsage: SseUsageExtractor;
  onTokenUsage?: ((usage: TokenUsage) => void) | null | undefined;
  keepAliveIntervalMs?: number;
};

type SseTerminalAnomaly = Record<string, string | number | boolean>;

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
    return {
      terminalAnomaly: "response.incomplete",
      ...(typeof response?.status === "string"
        ? { responseStatus: response.status }
        : {}),
      ...(typeof incompleteDetails?.reason === "string"
        ? { incompleteReason: incompleteDetails.reason }
        : {}),
    };
  }
  if (payload.type === "response.failed" || payload.type === "error") {
    const response = isObjectRecord(payload.response) ? payload.response : null;
    const nestedError = isObjectRecord(response?.error) ? response.error : null;
    const error = isObjectRecord(payload.error) ? payload.error : nestedError;
    const errorCode = error?.code ?? payload.code;
    return {
      terminalAnomaly: String(payload.type),
      ...(typeof response?.status === "string"
        ? { responseStatus: response.status }
        : {}),
      ...(typeof errorCode === "string" ? { errorCode } : {}),
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

const findSseEventBoundary = (
  buffer: string
): { index: number; length: number } | null => {
  const match = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/u.exec(buffer);
  if (!match || match.index === undefined) {
    return null;
  }
  return { index: match.index, length: match[0].length };
};

const readSseDataLines = (chunk: string): string[] =>
  chunk
    .replace(/\r\n|\r/gu, "\n")
    .split("\n")
    .filter((line) => line === "data" || line.startsWith("data:"))
    .map((line) => (line === "data" ? "" : line.slice(5).trimStart()));

const rewriteSseData = (
  chunk: string,
  payload: Record<string, unknown>
): string => {
  const boundary = findSseEventBoundary(chunk);
  if (!boundary || boundary.index + boundary.length !== chunk.length) {
    return chunk;
  }

  const body = chunk.slice(0, boundary.index);
  const newline = body.includes("\r\n")
    ? "\r\n"
    : body.includes("\r")
      ? "\r"
      : "\n";
  let wroteData = false;
  const lines: string[] = [];
  for (const line of body.split(/\r\n|\r|\n/u)) {
    if (line === "data" || line.startsWith("data:")) {
      if (!wroteData) {
        lines.push(`data: ${JSON.stringify(payload)}`);
        wroteData = true;
      }
      continue;
    }
    if (line === "event" || line.startsWith("event:")) {
      lines.push(`event: ${String(payload.type)}`);
      continue;
    }
    lines.push(line);
  }
  return `${lines.join(newline)}${chunk.slice(boundary.index)}`;
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
  onInvalidShape: (issue: OpenAiResponsesEventShapeIssue) => void
): string => {
  const dataLines = readSseDataLines(chunk);
  if (!dataLines.length) {
    return chunk;
  }
  const payloadText = dataLines.join("\n");
  if (!payloadText || payloadText === "[DONE]") {
    return chunk;
  }

  const jsonPayload = tryParseJson(payloadText);
  if (!isObjectRecord(jsonPayload)) {
    onInvalidJson({
      bytes: new TextEncoder().encode(payloadText).byteLength,
      lines: dataLines.length,
    });
    return chunk;
  }

  const shapeIssue = readOpenAiResponsesEventShapeIssue(jsonPayload);
  if (shapeIssue) {
    onInvalidShape(shapeIssue);
  }
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
  return normalized === jsonPayload ? chunk : rewriteSseData(chunk, normalized);
};

export const createOpenAiSseUsagePassthrough = (
  input: OpenAiSsePassthroughInput
): Response => {
  if (!input.response.body) {
    return input.response;
  }

  const reader = input.response.body.getReader();
  const decoder = new TextDecoder();
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
  let pendingText = "";
  let pendingBytes = 0;
  let bytes = 0;
  let chunks = 0;
  let lastChunkAt = startedAt;
  let lastWriteAt = startedAt;
  let closed = false;
  let utf8ValidationEnabled = true;
  let clearKeepAlive: (() => void) | null = null;

  const logStreamAnomaly = (
    event: string,
    fields: Record<string, string | number | boolean> = {},
    error?: unknown
  ): void => {
    logWarn(event, {
      provider: "openai",
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

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      if (!isSseBody) {
        return;
      }
      clearKeepAlive = createSseKeepAlive(controller, {
        provider: "openai",
        transport: "sse",
        getElapsedMs: () => Date.now() - startedAt,
        canEnqueue: () => pendingText.length === 0,
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
            pendingText += decoder.decode();
            if (utf8ValidationEnabled) {
              try {
                validationDecoder.decode();
              } catch {
                logStreamAnomaly("openai_sse_invalid_frame", {
                  parseCategory: "invalid_utf8",
                });
              }
            }
            if (isSseBody && pendingText.trim()) {
              const suffix = pendingText.endsWith("\r\n")
                ? "\r\n"
                : pendingText.endsWith("\n")
                  ? "\n"
                  : pendingText.endsWith("\r")
                    ? "\r"
                    : "\n\n";
              const framed = transformSseEvent(
                `${pendingText}${suffix}`,
                usageState,
                input.extractUsage,
                reportInvalidJson,
                reportInvalidShape
              );
              pendingText = framed.slice(0, -suffix.length);
              logStreamAnomaly("openai_sse_truncated_event", {
                pendingBytes,
                parseCategory: "truncated_event",
              });
            }
            if (pendingText) {
              controller.enqueue(encoder.encode(pendingText));
            }
            if (usageState.latestUsage) {
              input.onTokenUsage?.(usageState.latestUsage);
            }
            if (usageState.terminalAnomaly) {
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

          pendingBytes += value.byteLength;
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
          pendingText += decoder.decode(value, { stream: true });
          let output = "";
          let boundary = findSseEventBoundary(pendingText);
          while (boundary) {
            const eventEnd = boundary.index + boundary.length;
            output += transformSseEvent(
              pendingText.slice(0, eventEnd),
              usageState,
              input.extractUsage,
              reportInvalidJson,
              reportInvalidShape
            );
            pendingText = pendingText.slice(eventEnd);
            boundary = findSseEventBoundary(pendingText);
          }
          if (output) {
            pendingBytes = encoder.encode(pendingText).byteLength;
          }
          if (pendingBytes > MAX_SSE_EVENT_BYTES) {
            logStreamAnomaly("openai_sse_event_too_large", {
              pendingBytes,
              maxEventBytes: MAX_SSE_EVENT_BYTES,
              parseCategory: "event_size_limit",
            });
            throw new Error("OpenAI SSE event exceeds the proxy buffer limit");
          }
          if (output) {
            controller.enqueue(encoder.encode(output));
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
        reader.cancel(error).catch(() => undefined);
        logStreamAnomaly("openai_sse_stream_failed", {}, error);
        controller.error(error);
      }
    },
    cancel(reason): Promise<void> {
      closed = true;
      clearKeepAlive?.();
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: input.response.status,
    statusText: input.response.statusText,
    headers: createSseResponseHeaders(input.response.headers),
  });
};
