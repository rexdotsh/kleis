const SSE_KEEPALIVE_INTERVAL_MS = 25_000;
const SSE_KEEPALIVE_BYTES = new TextEncoder().encode(": kleis-keepalive\n\n");

export const createSseResponseHeaders = (source?: HeadersInit): Headers => {
  const headers = new Headers(source);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("cache-control", "no-cache, no-transform");
  if (!headers.has("content-type")) {
    headers.set("content-type", "text/event-stream");
  }
  headers.set("x-accel-buffering", "no");
  return headers;
};

type SseKeepAliveInput = {
  onKeepAlive?: () => void;
  intervalMs?: number;
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
      input.onKeepAlive?.();
    } catch {
      active = false;
      clearInterval(timer);
    }
  }, input.intervalMs ?? SSE_KEEPALIVE_INTERVAL_MS);

  return {
    clear(): void {
      active = false;
      clearInterval(timer);
    },
  };
};
