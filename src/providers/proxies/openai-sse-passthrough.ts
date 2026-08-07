import type { TokenUsage } from "../../usage/token-usage";
import { errorLogFields, logWarn } from "../../utils/log";
import { isObjectRecord } from "../../utils/object";
import { createSseKeepAlive, createSseResponseHeaders } from "./sse-keepalive";

type SseUsageExtractor = (payload: unknown) => TokenUsage | null;

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
    const errorMessage = error?.message ?? payload.message;
    const errorParam = error?.param ?? payload.param;
    return {
      terminalAnomaly: String(payload.type),
      ...(typeof response?.status === "string"
        ? { responseStatus: response.status }
        : {}),
      ...(typeof errorCode === "string" ? { errorCode } : {}),
      ...(typeof errorMessage === "string" ? { errorMessage } : {}),
      ...(typeof errorParam === "string" ? { errorParam } : {}),
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

const readLatestUsageFromSse = (
  text: string,
  state: {
    eventDataLines: string[];
    latestUsage: TokenUsage | null;
    terminalAnomaly: SseTerminalAnomaly | null;
  },
  extractUsage: SseUsageExtractor
): string => {
  let cursor = 0;

  const flushEvent = (): void => {
    if (!state.eventDataLines.length) {
      return;
    }

    const payloadText = state.eventDataLines.join("\n");
    state.eventDataLines = [];
    if (!payloadText || payloadText === "[DONE]") {
      return;
    }

    const jsonPayload = tryParseJson(payloadText);
    if (!jsonPayload) {
      return;
    }

    state.terminalAnomaly = readSseTerminalAnomaly(jsonPayload);

    const usage = extractUsage(jsonPayload);
    if (usage) {
      state.latestUsage = usage;
    }
  };

  while (true) {
    const lineBreak = text.indexOf("\n", cursor);
    if (lineBreak === -1) {
      break;
    }

    let line = text.slice(cursor, lineBreak);
    cursor = lineBreak + 1;
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    if (line.length === 0) {
      flushEvent();
      continue;
    }

    if (line.startsWith("data:")) {
      state.eventDataLines.push(line.slice(5).trimStart());
    }
  }

  return text.slice(cursor);
};

export const createOpenAiSseUsagePassthrough = (
  input: OpenAiSsePassthroughInput
): Response => {
  if (!input.response.body) {
    return input.response;
  }

  const reader = input.response.body.getReader();
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  const contentType = (
    input.response.headers.get("content-type") ?? ""
  ).toLowerCase();
  // Codex omits the content-type header on SSE streams; anything explicitly
  // non-SSE (e.g. JSON error bodies) must not receive keepalive comments.
  const isSseBody = !contentType || contentType.includes("text/event-stream");
  const usageState = {
    eventDataLines: [] as string[],
    latestUsage: null as TokenUsage | null,
    terminalAnomaly: null as SseTerminalAnomaly | null,
  };
  let pendingText = "";
  let bytes = 0;
  let chunks = 0;
  let lastChunkAt = startedAt;
  let lastWriteAt = startedAt;
  let closed = false;
  let clearKeepAlive: (() => void) | null = null;

  const logStreamAnomaly = (
    event: string,
    fields: Record<string, string | number | boolean> = {},
    error?: unknown
  ): void => {
    logWarn(event, {
      provider: "openai",
      transport: "sse",
      elapsedMs: Date.now() - startedAt,
      idleMs: Date.now() - lastChunkAt,
      downstreamIdleMs: Date.now() - lastWriteAt,
      bytes,
      chunks,
      ...fields,
      ...(error === undefined ? {} : errorLogFields(error)),
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
          pendingText = readLatestUsageFromSse(
            `${pendingText}\n\n`,
            usageState,
            input.extractUsage
          );
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
        pendingText += decoder.decode(value, { stream: true });
        pendingText = readLatestUsageFromSse(
          pendingText,
          usageState,
          input.extractUsage
        );
        try {
          controller.enqueue(value);
          lastWriteAt = Date.now();
        } catch (error) {
          logStreamAnomaly("openai_sse_enqueue_failed", {}, error);
          throw error;
        }
      } catch (error) {
        if (closed) {
          clearKeepAlive?.();
          return;
        }
        closed = true;
        clearKeepAlive?.();
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
