import type { Provider } from "../db/schema";
import { logError, logWarn } from "../utils/log";

const LOG_INTERVAL_MS = 60_000;
const MAX_FAILURE_KEYS = 256;

type UpstreamFailureFields = {
  provider: Provider;
  providerAccountId: string;
  endpoint: string;
  status: number;
  errorType: string | null;
  errorCode: string | null;
  elapsedMs: number;
  requestId: string | null;
};

export const createUpstreamFailureLogger = (
  now: () => number = Date.now
): ((fields: UpstreamFailureFields) => void) => {
  const entries = new Map<
    string,
    { loggedAt: number; suppressedCount: number }
  >();
  return (fields): void => {
    const key = [
      fields.provider,
      fields.providerAccountId,
      fields.endpoint,
      fields.status,
      fields.errorType,
      fields.errorCode,
    ].join("\0");
    const time = now();
    const previous = entries.get(key);
    if (previous && time - previous.loggedAt < LOG_INTERVAL_MS) {
      previous.suppressedCount++;
      return;
    }
    if (!previous && entries.size === MAX_FAILURE_KEYS) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) {
        entries.delete(oldest);
      }
    }
    entries.set(key, { loggedAt: time, suppressedCount: 0 });
    const log = fields.status >= 500 ? logError : logWarn;
    log("proxy_upstream_response_failed", {
      ...fields,
      suppressedCount: previous?.suppressedCount || undefined,
    });
  };
};
