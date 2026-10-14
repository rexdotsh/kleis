import { readBoolean, readNumber, readObject, readString } from "./decode";

// Proxied responses report the account's limits as they stand after the
// request. Header names and meanings follow the clients that read them:
// Claude Code's unified rate-limit headers, and codex-rs
// codex-api/src/rate_limits.rs for Codex headers and websocket events.

const CLAUDE_UNIFIED_PREFIX = "anthropic-ratelimit-unified";

// Claude Code's mapping of usage windows to header names; 7d_oi is the
// seven_day_overage_included window that the usage endpoint also returns.
const CLAUDE_WINDOW_HEADERS = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["seven_day_overage_included", "7d_oi"],
] as const;

const CLAUDE_STATUSES = new Set(["allowed", "allowed_warning", "rejected"]);

const CODEX_REACHED_TYPES = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached",
]);

// Plausible reset times, 2020 to 2100, in epoch seconds.
const MIN_EPOCH_SECONDS = 1_577_836_800;
const MAX_EPOCH_SECONDS = 4_102_444_800;

// A utilization fraction far above 1 is not a fraction.
const MAX_CLAUDE_UTILIZATION = 10;

export type ClaudeWindowName = (typeof CLAUDE_WINDOW_HEADERS)[number][0];

export type ClaudeWindowReading = {
  // Percent (0–100), the scale of the usage endpoint.
  utilization: number | null;
  resetsAt: string | null;
};

export type ClaudeRateLimitReading = {
  provider: "claude";
  windows: Partial<Record<ClaudeWindowName, ClaudeWindowReading>>;
  status: string | null;
  resetsAt: string | null;
  representativeClaim: string | null;
};

export type CodexWindowReading = {
  usedPercent: number;
  windowSeconds: number | null;
  resetAt: number | null;
};

export type CodexLimitReading = {
  limitId: string;
  limitName: string | null;
  primary: CodexWindowReading | null;
  secondary: CodexWindowReading | null;
};

export type CodexRateLimitReading = {
  provider: "codex";
  limits: CodexLimitReading[];
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  planType: string | null;
  rateLimitReachedType: string | null;
};

export type RateLimitReading = ClaudeRateLimitReading | CodexRateLimitReading;

const readFiniteNumber = (value: string | null): number | null => {
  if (value === null || value.trim() === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const readInteger = (value: string | null): number | null => {
  const number = readFiniteNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
};

// Resets are epoch seconds; milliseconds are accepted too.
const toEpochSeconds = (value: number | null): number | null => {
  if (value === null) {
    return null;
  }
  const seconds = Math.round(value > MAX_EPOCH_SECONDS ? value / 1000 : value);
  return seconds >= MIN_EPOCH_SECONDS && seconds <= MAX_EPOCH_SECONDS
    ? seconds
    : null;
};

const toIsoTimestamp = (seconds: number | null): string | null =>
  seconds === null ? null : new Date(seconds * 1000).toISOString();

const roundPercent = (value: number): number => Math.round(value * 100) / 100;

const readClaudeUtilization = (value: string | null): number | null => {
  const fraction = readFiniteNumber(value);
  return fraction !== null &&
    fraction >= 0 &&
    fraction <= MAX_CLAUDE_UTILIZATION
    ? roundPercent(fraction * 100)
    : null;
};

const readClaudeReset = (value: string | null): string | null =>
  toIsoTimestamp(toEpochSeconds(readFiniteNumber(value)));

const readKnown = (value: string | null, known: Set<string>): string | null => {
  const trimmed = value?.trim() ?? "";
  return known.has(trimmed) ? trimmed : null;
};

const readName = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? "";
  return /^[a-z][a-z0-9_]{0,63}$/.test(trimmed) ? trimmed : null;
};

export const readClaudeRateLimitHeaders = (
  headers: Headers
): ClaudeRateLimitReading | null => {
  const windows: ClaudeRateLimitReading["windows"] = {};
  for (const [name, header] of CLAUDE_WINDOW_HEADERS) {
    const utilization = readClaudeUtilization(
      headers.get(`${CLAUDE_UNIFIED_PREFIX}-${header}-utilization`)
    );
    const resetsAt = readClaudeReset(
      headers.get(`${CLAUDE_UNIFIED_PREFIX}-${header}-reset`)
    );
    if (utilization !== null || resetsAt !== null) {
      windows[name] = { utilization, resetsAt };
    }
  }
  const status = readKnown(
    headers.get(`${CLAUDE_UNIFIED_PREFIX}-status`),
    CLAUDE_STATUSES
  );
  if (!(status || Object.keys(windows).length)) {
    return null;
  }
  return {
    provider: "claude",
    windows,
    status,
    resetsAt: readClaudeReset(headers.get(`${CLAUDE_UNIFIED_PREFIX}-reset`)),
    representativeClaim: readName(
      headers.get(`${CLAUDE_UNIFIED_PREFIX}-representative-claim`)
    ),
  };
};

const normalizeLimitId = (value: string): string =>
  value.trim().toLowerCase().replaceAll("-", "_");

const readUsedPercent = (value: number | null): number | null =>
  value !== null && value >= 0 ? value : null;

// Like codex-rs, a window that is all zeros carries no data.
const codexWindow = (
  usedPercent: number | null,
  windowMinutes: number | null,
  resetAt: number | null
): CodexWindowReading | null => {
  if (usedPercent === null) {
    return null;
  }
  const minutes =
    windowMinutes !== null && windowMinutes >= 0 ? windowMinutes : null;
  if (usedPercent === 0 && !minutes && resetAt === null) {
    return null;
  }
  return {
    usedPercent,
    windowSeconds: minutes === null ? null : minutes * 60,
    resetAt,
  };
};

const readCodexHeaderWindow = (
  headers: Headers,
  prefix: string
): CodexWindowReading | null =>
  codexWindow(
    readUsedPercent(readFiniteNumber(headers.get(`${prefix}-used-percent`))),
    readInteger(headers.get(`${prefix}-window-minutes`)),
    toEpochSeconds(readInteger(headers.get(`${prefix}-reset-at`)))
  );

const readHeaderBoolean = (value: string | null): boolean | null => {
  const trimmed = value?.trim().toLowerCase();
  if (trimmed === "true" || trimmed === "1") return true;
  if (trimmed === "false" || trimmed === "0") return false;
  return null;
};

const PRIMARY_USED_PERCENT_SUFFIX = "-primary-used-percent";

const codexLimitIds = (headers: Headers): string[] => {
  const ids = new Set<string>(["codex"]);
  for (const name of headers.keys()) {
    if (name.startsWith("x-") && name.endsWith(PRIMARY_USED_PERCENT_SUFFIX)) {
      const id = readName(
        normalizeLimitId(name.slice(2, -PRIMARY_USED_PERCENT_SUFFIX.length))
      );
      if (id) {
        ids.add(id);
      }
    }
  }
  return [...ids];
};

export const readCodexRateLimitHeaders = (
  headers: Headers
): CodexRateLimitReading | null => {
  const limits: CodexLimitReading[] = [];
  for (const limitId of codexLimitIds(headers)) {
    const prefix = `x-${limitId.replaceAll("_", "-")}`;
    const primary = readCodexHeaderWindow(headers, `${prefix}-primary`);
    const secondary = readCodexHeaderWindow(headers, `${prefix}-secondary`);
    if (primary || secondary) {
      limits.push({
        limitId,
        limitName: headers.get(`${prefix}-limit-name`)?.trim() || null,
        primary,
        secondary,
      });
    }
  }
  const hasCredits = readHeaderBoolean(
    headers.get("x-codex-credits-has-credits")
  );
  const unlimited = readHeaderBoolean(headers.get("x-codex-credits-unlimited"));
  const credits =
    hasCredits !== null && unlimited !== null
      ? {
          hasCredits,
          unlimited,
          balance: headers.get("x-codex-credits-balance")?.trim() || null,
        }
      : null;
  const rateLimitReachedType = readKnown(
    headers.get("x-codex-rate-limit-reached-type"),
    CODEX_REACHED_TYPES
  );
  if (!(limits.length || credits || rateLimitReachedType)) {
    return null;
  }
  return {
    provider: "codex",
    limits,
    credits,
    planType: null,
    rateLimitReachedType,
  };
};

const readEventWindow = (value: unknown): CodexWindowReading | null => {
  const input = readObject(value);
  const windowMinutes = readNumber(input?.window_minutes);
  const resetAt = readNumber(input?.reset_at);
  return codexWindow(
    readUsedPercent(readNumber(input?.used_percent)),
    windowMinutes !== null && Number.isInteger(windowMinutes)
      ? windowMinutes
      : null,
    toEpochSeconds(resetAt)
  );
};

// The websocket transport sends limits as `codex.rate_limits` events instead
// of headers; they also carry the plan.
export const readCodexRateLimitEvent = (
  payload: Record<string, unknown>
): CodexRateLimitReading | null => {
  if (payload.type !== "codex.rate_limits") {
    return null;
  }
  const rateLimits = readObject(payload.rate_limits);
  const primary = readEventWindow(rateLimits?.primary);
  const secondary = readEventWindow(rateLimits?.secondary);
  const limitId = readName(
    normalizeLimitId(
      readString(payload.metered_limit_name) ??
        readString(payload.limit_name) ??
        "codex"
    )
  );
  const credits = readObject(payload.credits);
  const hasCredits = readBoolean(credits?.has_credits);
  const unlimited = readBoolean(credits?.unlimited);
  const planType = readName(readString(payload.plan_type));
  const reading: CodexRateLimitReading = {
    provider: "codex",
    limits:
      limitId && (primary || secondary)
        ? [{ limitId, limitName: null, primary, secondary }]
        : [],
    credits:
      hasCredits !== null && unlimited !== null
        ? {
            hasCredits,
            unlimited,
            balance: readString(credits?.balance)?.trim() || null,
          }
        : null,
    planType,
    rateLimitReachedType: null,
  };
  return reading.limits.length || reading.credits || planType ? reading : null;
};
