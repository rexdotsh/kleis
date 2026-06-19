import { errorLogFields, logWarn } from "../../utils/log";

const SSE_KEEPALIVE_INTERVAL_MS = 25_000;
const SSE_KEEPALIVE_BYTES = new TextEncoder().encode(": kleis-keepalive\n\n");

type SseKeepAliveInput = {
  provider: string;
  transport: string;
  getElapsedMs: () => number;
};

export const createSseKeepAlive = (
  controller: ReadableStreamDefaultController<Uint8Array>,
  input: SseKeepAliveInput
): { clear(): void } => {
  let active = true;
  const timer = setInterval(() => {
    if (!active) {
      return;
    }

    try {
      controller.enqueue(SSE_KEEPALIVE_BYTES);
    } catch (error) {
      active = false;
      clearInterval(timer);
      logWarn("sse_keepalive_enqueue_failed", {
        provider: input.provider,
        transport: input.transport,
        elapsedMs: input.getElapsedMs(),
        ...errorLogFields(error),
      });
    }
  }, SSE_KEEPALIVE_INTERVAL_MS);

  return {
    clear(): void {
      active = false;
      clearInterval(timer);
    },
  };
};
