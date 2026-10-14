import type { ClaudeSubscriptionUsage } from "./claude";
import type { CodexRateLimitWindow, CodexUsageStatus } from "./codex";
import { readBoolean, readNumber, readObject, readString } from "./decode";

// Proxied responses carry the account's limits as they stand after the
// request. Claude Code reads Anthropic's unified rate-limit headers; codex-rs
// (codex-api/src/rate_limits.rs) reads Codex's headers and websocket events.
// A reading holds only what the response reported, and merging it keeps every
// other field at its value from the last usage-endpoint poll.

type ClaudeWindow = NonNullable<ClaudeSubscriptionUsage["fiveHour"]>;
type ClaudeWindowReading = Partial<
  Pick<ClaudeWindow, "utilization" | "resetsAt">
>;

export type ClaudeLiveLimits = {
  provider: "claude";
  // Keyed like the usage endpoint: five_hour, seven_day, seven_day_*.
  windows: Record<string, ClaudeWindowReading>;
};

type CodexWindowReading = {
  usedPercent: number;
  windowSeconds: number | null;
  resetAt: number | null;
};

export type CodexLiveLimits = {
  provider: "codex";
  primaryWindow: CodexWindowReading | null;
  secondaryWindow: CodexWindowReading | null;
  credits: CodexUsageStatus["credits"];
  planType: string | null;
};

export type LiveLimits = ClaudeLiveLimits | CodexLiveLimits;

// Claude Code's header names for the usage endpoint's windows.
const CLAUDE_WINDOW_HEADERS = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_overage_included: "7d_oi",
} as const;

const isClaudeWindowKey = (value: string): boolean =>
  value === "five_hour" || value.startsWith("seven_day");

const readHeaderNumber = (value: string | null): number | undefined => {
  if (!value?.trim()) {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
};

const readHeaderBoolean = (value: string | null): boolean | null => {
  const flag = value?.trim().toLowerCase();
  if (flag === "true" || flag === "1") return true;
  if (flag === "false" || flag === "0") return false;
  return null;
};

export const readClaudeLiveLimits = (
  headers: Headers
): ClaudeLiveLimits | null => {
  const header = (name: string) =>
    headers.get(`anthropic-ratelimit-unified-${name}`);
  const windows: ClaudeLiveLimits["windows"] = {};
  for (const [key, name] of Object.entries(CLAUDE_WINDOW_HEADERS)) {
    // A 0–1 fraction; the usage endpoint reports percent.
    const fraction = readHeaderNumber(header(`${name}-utilization`));
    const reset = readHeaderNumber(header(`${name}-reset`));
    const window: ClaudeWindowReading = {};
    if (fraction !== undefined) {
      window.utilization = Math.round(fraction * 10_000) / 100;
    }
    if (reset !== undefined) {
      window.resetsAt = new Date(reset * 1000).toISOString();
    }
    if (Object.keys(window).length) {
      windows[key] = window;
    }
  }
  // A rejected request means the window that decided it is used up.
  const claim = header("representative-claim")?.trim() ?? "";
  if (header("status") === "rejected" && isClaudeWindowKey(claim)) {
    windows[claim] = {
      ...windows[claim],
      utilization: Math.max(windows[claim]?.utilization ?? 0, 100),
    };
  }
  return Object.keys(windows).length ? { provider: "claude", windows } : null;
};

// Like codex-rs, a window without a used percent, or all zeros, carries no data.
const codexWindow = (
  usedPercent: number | null | undefined,
  windowMinutes: number | null | undefined,
  resetAt: number | null | undefined
): CodexWindowReading | null => {
  if (
    usedPercent === null ||
    usedPercent === undefined ||
    usedPercent < 0 ||
    (usedPercent === 0 && !windowMinutes && !resetAt)
  ) {
    return null;
  }
  return {
    usedPercent,
    windowSeconds: windowMinutes ? windowMinutes * 60 : null,
    resetAt: resetAt || null,
  };
};

const codexCredits = (
  hasCredits: boolean | null,
  unlimited: boolean | null,
  balance: string | null | undefined
): CodexUsageStatus["credits"] =>
  hasCredits === null || unlimited === null
    ? null
    : { hasCredits, unlimited, balance: balance?.trim() || null };

const codexLiveLimits = (
  fields: Omit<CodexLiveLimits, "provider">
): CodexLiveLimits | null =>
  Object.values(fields).some((value) => value !== null)
    ? { provider: "codex", ...fields }
    : null;

export const readCodexLiveLimits = (
  headers: Headers
): CodexLiveLimits | null => {
  const window = (name: "primary" | "secondary") =>
    codexWindow(
      readHeaderNumber(headers.get(`x-codex-${name}-used-percent`)),
      readHeaderNumber(headers.get(`x-codex-${name}-window-minutes`)),
      readHeaderNumber(headers.get(`x-codex-${name}-reset-at`))
    );
  return codexLiveLimits({
    primaryWindow: window("primary"),
    secondaryWindow: window("secondary"),
    credits: codexCredits(
      readHeaderBoolean(headers.get("x-codex-credits-has-credits")),
      readHeaderBoolean(headers.get("x-codex-credits-unlimited")),
      headers.get("x-codex-credits-balance")
    ),
    planType: null,
  });
};

// The websocket transport sends `codex.rate_limits` events instead of
// headers; they also carry the plan. Events for a metered feature's own limit
// are not the account's main windows.
export const readCodexLiveLimitsEvent = (
  payload: Record<string, unknown>
): CodexLiveLimits | null => {
  const limitName =
    readString(payload.metered_limit_name) ?? readString(payload.limit_name);
  const rateLimits =
    limitName && limitName.toLowerCase() !== "codex"
      ? null
      : readObject(payload.rate_limits);
  const window = (name: "primary" | "secondary") => {
    const input = readObject(rateLimits?.[name]);
    return codexWindow(
      readNumber(input?.used_percent),
      readNumber(input?.window_minutes),
      readNumber(input?.reset_at)
    );
  };
  const credits = readObject(payload.credits);
  return codexLiveLimits({
    primaryWindow: window("primary"),
    secondaryWindow: window("secondary"),
    credits: codexCredits(
      readBoolean(credits?.has_credits),
      readBoolean(credits?.unlimited),
      readString(credits?.balance)
    ),
    planType: readString(payload.plan_type),
  });
};

const mergeClaudeWindow = (
  previous: ClaudeSubscriptionUsage["fiveHour"] | undefined,
  reading: ClaudeWindowReading | undefined
): ClaudeSubscriptionUsage["fiveHour"] =>
  reading
    ? {
        utilization: null,
        resetsAt: null,
        limitDollars: null,
        usedDollars: null,
        remainingDollars: null,
        ...previous,
        ...reading,
      }
    : (previous ?? null);

export const mergeClaudeLiveLimits = (
  previous: ClaudeSubscriptionUsage | undefined,
  { windows }: ClaudeLiveLimits
): ClaudeSubscriptionUsage => {
  const { five_hour, seven_day, ...modelWindows } = windows;
  const merged: ClaudeSubscriptionUsage = {
    source: "oauth",
    modelWindows: {},
    extraUsage: null,
    limits: [],
    ...previous,
    fiveHour: mergeClaudeWindow(previous?.fiveHour, five_hour),
    sevenDay: mergeClaudeWindow(previous?.sevenDay, seven_day),
  };
  for (const [key, reading] of Object.entries(modelWindows)) {
    merged.modelWindows = {
      ...merged.modelWindows,
      [key]: mergeClaudeWindow(merged.modelWindows[key], reading),
    };
  }
  return merged;
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
    resetAt,
    resetAfterSeconds:
      resetAt === null ? null : Math.max(0, resetAt - nowSeconds),
  };
};

export const mergeCodexLiveLimits = (
  previous: CodexUsageStatus | undefined,
  limits: CodexLiveLimits,
  now: number
): CodexUsageStatus => {
  const nowSeconds = Math.floor(now / 1000);
  return {
    allowed: null,
    limitReached: null,
    spendControl: null,
    additionalRateLimits: [],
    rateLimitReachedType: null,
    resetCreditsAvailable: null,
    ...previous,
    planType: limits.planType ?? previous?.planType ?? null,
    primaryWindow: mergeCodexWindow(
      previous?.primaryWindow,
      limits.primaryWindow,
      nowSeconds
    ),
    secondaryWindow: mergeCodexWindow(
      previous?.secondaryWindow,
      limits.secondaryWindow,
      nowSeconds
    ),
    credits: limits.credits ?? previous?.credits ?? null,
  };
};
