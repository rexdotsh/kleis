import type { TokenUsage } from "../../usage/token-usage";

type SseUsageExtractor = (payload: unknown) => TokenUsage | null;

type OpenAiSsePassthroughInput = {
  response: Response;
  extractUsage: SseUsageExtractor;
  onTokenUsage?: ((usage: TokenUsage) => void) | null | undefined;
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
  state: { eventDataLines: string[]; latestUsage: TokenUsage | null },
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
  const usageState = {
    eventDataLines: [] as string[],
    latestUsage: null as TokenUsage | null,
  };
  let pendingText = "";

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        pendingText += decoder.decode();
        pendingText = readLatestUsageFromSse(
          `${pendingText}\n\n`,
          usageState,
          input.extractUsage
        );
        if (usageState.latestUsage) {
          input.onTokenUsage?.(usageState.latestUsage);
        }
        controller.close();
        return;
      }

      if (!value) {
        return;
      }

      pendingText += decoder.decode(value, { stream: true });
      pendingText = readLatestUsageFromSse(
        pendingText,
        usageState,
        input.extractUsage
      );
      controller.enqueue(value);
    },
    cancel(reason): Promise<void> {
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: input.response.status,
    statusText: input.response.statusText,
    headers: input.response.headers,
  });
};
