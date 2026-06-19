import type { TokenUsage } from "../../usage/token-usage";
import { errorLogFields, logWarn } from "../../utils/log";
import { isObjectRecord } from "../../utils/object";
import { createSseKeepAlive } from "./sse-keepalive";

type SseUsageExtractor = (payload: unknown) => TokenUsage | null;

type OpenAiSsePassthroughInput = {
  response: Response;
  extractUsage: SseUsageExtractor;
  onTokenUsage?: ((usage: TokenUsage) => void) | null | undefined;
};

const readSseTerminalAnomaly = (payload: unknown): string | null => {
  if (!isObjectRecord(payload)) {
    return null;
  }

  if (payload.type === "response.incomplete") {
    return "response.incomplete";
  }
  if (payload.type === "response.failed" || payload.type === "error") {
    return String(payload.type);
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
    terminalAnomaly: string | null;
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
  const usageState = {
    eventDataLines: [] as string[],
    latestUsage: null as TokenUsage | null,
    terminalAnomaly: null as string | null,
  };
  let pendingText = "";
  let bytes = 0;
  let chunks = 0;
  let lastChunkAt = startedAt;
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
      bytes,
      chunks,
      ...fields,
      ...(error === undefined ? {} : errorLogFields(error)),
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const keepAlive = createSseKeepAlive(controller, {
        provider: "openai",
        transport: "sse",
        getElapsedMs: () => Date.now() - startedAt,
      });
      clearKeepAlive = keepAlive.clear;

      const pump = async (): Promise<void> => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
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
                logStreamAnomaly("openai_sse_terminal_anomaly", {
                  terminalAnomaly: usageState.terminalAnomaly,
                });
              }
              closed = true;
              clearKeepAlive?.();
              controller.close();
              return;
            }

            if (!value) {
              continue;
            }

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
            } catch (error) {
              logStreamAnomaly("openai_sse_enqueue_failed", {}, error);
              throw error;
            }
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
      };

      pump().catch((error: unknown) => {
        if (closed) {
          clearKeepAlive?.();
          return;
        }
        closed = true;
        clearKeepAlive?.();
        logStreamAnomaly("openai_sse_stream_failed", {}, error);
        controller.error(error);
      });
    },
    cancel(reason): Promise<void> {
      if (!closed) {
        logStreamAnomaly("openai_sse_downstream_cancelled", {}, reason);
      }
      closed = true;
      clearKeepAlive?.();
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: input.response.status,
    statusText: input.response.statusText,
    headers: input.response.headers,
  });
};
