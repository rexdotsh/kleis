import type { Provider } from "../../db/schema";
import {
  readClaudeLiveLimits,
  readCodexLiveLimits,
} from "../account-tracking/live-limits";
import { readUpstreamResponseError } from "./upstream-error";

export const isSubscriptionLimitResponse = async (
  provider: Provider,
  response: Response,
  signal: AbortSignal
): Promise<boolean> => {
  signal.throwIfAborted();
  if (response.status !== 429) return false;
  if (provider === "claude") {
    const status = response.headers.get("anthropic-ratelimit-unified-status");
    if (status === "allowed") return false;
    if (status === "rejected") return true;
    const claim = response.headers.get(
      "anthropic-ratelimit-unified-representative-claim"
    );
    const limits = readClaudeLiveLimits(response.headers);
    return !!claim && (limits?.windows[claim]?.utilization ?? 0) >= 100;
  }
  const limits = readCodexLiveLimits(response.headers);
  if (
    [limits?.primaryWindow, limits?.secondaryWindow].some(
      (window) => window && window.usedPercent >= 100
    )
  )
    return true;
  const { errorType, errorCode } = await readUpstreamResponseError(response, {
    timeoutMs: 3000,
    signal,
  });
  return (errorCode ?? errorType) === "usage_limit_reached";
};
