import type { ClaudeSubscriptionUsage } from "../../providers/account-tracking/claude";
import type {
  CodexRateLimitWindow,
  CodexUsageStatus,
} from "../../providers/account-tracking/codex";
import type {
  ClaudeRateLimitReading,
  ClaudeWindowReading,
  CodexLimitReading,
  CodexRateLimitReading,
  CodexWindowReading,
} from "../../providers/account-tracking/rate-limit-headers";

type ClaudeUsageWindow = ClaudeSubscriptionUsage["fiveHour"];
type CodexAdditionalLimit = CodexUsageStatus["additionalRateLimits"][number];

const emptyClaudeSubscription = (): ClaudeSubscriptionUsage => ({
  source: "oauth",
  fiveHour: null,
  sevenDay: null,
  modelWindows: {},
  extraUsage: null,
  limits: [],
});

const mergeClaudeWindow = (
  previous: ClaudeUsageWindow,
  reading: ClaudeWindowReading | undefined
): ClaudeUsageWindow => {
  if (!reading) {
    return previous;
  }
  return {
    utilization: reading.utilization ?? previous?.utilization ?? null,
    resetsAt: reading.resetsAt ?? previous?.resetsAt ?? null,
    limitDollars: previous?.limitDollars ?? null,
    usedDollars: previous?.usedDollars ?? null,
    remainingDollars: previous?.remainingDollars ?? null,
  };
};

// A rejected request means the window that decided it is used up, which the
// usage endpoint reports as at least 100%.
const markClaudeWindowReached = (
  window: ClaudeUsageWindow,
  resetsAt: string | null
): ClaudeUsageWindow => ({
  utilization: Math.max(window?.utilization ?? 0, 100),
  resetsAt: window?.resetsAt ?? resetsAt,
  limitDollars: window?.limitDollars ?? null,
  usedDollars: window?.usedDollars ?? null,
  remainingDollars: window?.remainingDollars ?? null,
});

// Headers cover the 5h, 7d and 7d overage-included windows; per-model
// windows, extra usage and the limits list keep their last polled values.
export const mergeClaudeReading = (
  previous: ClaudeSubscriptionUsage | undefined,
  reading: ClaudeRateLimitReading
): ClaudeSubscriptionUsage => {
  const base = previous ?? emptyClaudeSubscription();
  const subscription: ClaudeSubscriptionUsage = {
    ...base,
    fiveHour: mergeClaudeWindow(base.fiveHour, reading.windows.five_hour),
    sevenDay: mergeClaudeWindow(base.sevenDay, reading.windows.seven_day),
  };
  const overageIncluded = reading.windows.seven_day_overage_included;
  if (overageIncluded) {
    subscription.modelWindows = {
      ...base.modelWindows,
      seven_day_overage_included: mergeClaudeWindow(
        base.modelWindows.seven_day_overage_included ?? null,
        overageIncluded
      ),
    };
  }
  const claim = reading.representativeClaim;
  if (reading.status !== "rejected" || !claim) {
    return subscription;
  }
  if (claim === "five_hour") {
    subscription.fiveHour = markClaudeWindowReached(
      subscription.fiveHour,
      reading.resetsAt
    );
  } else if (claim === "seven_day") {
    subscription.sevenDay = markClaudeWindowReached(
      subscription.sevenDay,
      reading.resetsAt
    );
  } else if (claim.startsWith("seven_day_")) {
    subscription.modelWindows = {
      ...subscription.modelWindows,
      [claim]: markClaudeWindowReached(
        subscription.modelWindows[claim] ?? null,
        reading.resetsAt
      ),
    };
  }
  return subscription;
};

const mergeCodexWindow = (
  previous: CodexRateLimitWindow | null | undefined,
  reading: CodexWindowReading | null,
  nowSeconds: number
): CodexRateLimitWindow | null => {
  if (!reading) {
    return previous ?? null;
  }
  const resetAt = reading.resetAt ?? previous?.resetAt ?? null;
  return {
    usedPercent: reading.usedPercent,
    windowSeconds: reading.windowSeconds ?? previous?.windowSeconds ?? null,
    resetAfterSeconds:
      resetAt === null ? null : Math.max(0, resetAt - nowSeconds),
    resetAt,
  };
};

const isWindowReached = (window: CodexRateLimitWindow | null): boolean =>
  (window?.usedPercent ?? 0) >= 100;

const emptyCodexStatus = (): CodexUsageStatus => ({
  planType: null,
  allowed: null,
  limitReached: null,
  primaryWindow: null,
  secondaryWindow: null,
  credits: null,
  spendControl: null,
  additionalRateLimits: [],
  rateLimitReachedType: null,
  resetCreditsAvailable: null,
});

const mergeAdditionalLimit = (
  previous: CodexAdditionalLimit | undefined,
  reading: CodexLimitReading,
  nowSeconds: number
): CodexAdditionalLimit => {
  const primaryWindow = mergeCodexWindow(
    previous?.primaryWindow,
    reading.primary,
    nowSeconds
  );
  const secondaryWindow = mergeCodexWindow(
    previous?.secondaryWindow,
    reading.secondary,
    nowSeconds
  );
  const limitReached =
    isWindowReached(primaryWindow) || isWindowReached(secondaryWindow);
  return {
    meteredFeature: previous?.meteredFeature ?? reading.limitId,
    limitName: reading.limitName ?? previous?.limitName ?? null,
    allowed: !limitReached,
    limitReached,
    primaryWindow,
    secondaryWindow,
  };
};

const sameLimit = (
  limit: CodexAdditionalLimit,
  reading: CodexLimitReading
): boolean =>
  (limit.meteredFeature ?? "").toLowerCase().replaceAll("-", "_") ===
    reading.limitId ||
  (reading.limitName !== null && limit.limitName === reading.limitName);

// Headers and events cover the windows, credits and, for events, the plan.
// Spend controls and reset-credit counts keep their last polled values.
export const mergeCodexReading = (
  previous: CodexUsageStatus | undefined,
  reading: CodexRateLimitReading,
  now: number
): CodexUsageStatus => {
  const nowSeconds = Math.floor(now / 1000);
  const status: CodexUsageStatus = { ...(previous ?? emptyCodexStatus()) };
  const additional = [...status.additionalRateLimits];
  for (const limit of reading.limits) {
    if (limit.limitId === "codex") {
      status.primaryWindow = mergeCodexWindow(
        status.primaryWindow,
        limit.primary,
        nowSeconds
      );
      status.secondaryWindow = mergeCodexWindow(
        status.secondaryWindow,
        limit.secondary,
        nowSeconds
      );
      continue;
    }
    const index = additional.findIndex((entry) => sameLimit(entry, limit));
    const merged = mergeAdditionalLimit(additional[index], limit, nowSeconds);
    if (index === -1) {
      additional.push(merged);
    } else {
      additional[index] = merged;
    }
  }
  status.additionalRateLimits = additional;
  if (reading.credits) {
    status.credits = reading.credits;
  }
  if (reading.planType) {
    status.planType = reading.planType;
  }
  const hasMainLimit = reading.limits.some(
    (limit) => limit.limitId === "codex"
  );
  if (reading.rateLimitReachedType || hasMainLimit) {
    const reached =
      reading.rateLimitReachedType !== null ||
      isWindowReached(status.primaryWindow) ||
      isWindowReached(status.secondaryWindow);
    status.limitReached = reached;
    status.allowed = !reached;
    status.rateLimitReachedType = reached
      ? (reading.rateLimitReachedType ??
        status.rateLimitReachedType ??
        "rate_limit_reached")
      : null;
  }
  return status;
};
