import {
  ANTHROPIC_API_BASE_URL,
  CLAUDE_REQUIRED_BETA_HEADERS,
} from "../constants";
import { isObjectRecord } from "../../utils/object";
import { fetchTrackingJson } from "./http";

const CLAUDE_USAGE_TIMEOUT_MS = 10_000;

const readString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const readBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;
const readObject = (value: unknown): Record<string, unknown> | null =>
  isObjectRecord(value) ? value : null;

const decodeUsageWindow = (value: unknown) => {
  const input = readObject(value);
  if (!input) {
    return null;
  }
  return {
    utilization: readNumber(input.utilization),
    resetsAt: readString(input.resets_at),
    limitDollars: readNumber(input.limit_dollars),
    usedDollars: readNumber(input.used_dollars),
    remainingDollars: readNumber(input.remaining_dollars),
  };
};

const decodeExtraUsage = (value: unknown) => {
  const input = readObject(value);
  if (!input) {
    return null;
  }
  return {
    isEnabled: readBoolean(input.is_enabled),
    monthlyLimit: readNumber(input.monthly_limit),
    usedCredits: readNumber(input.used_credits),
    utilization: readNumber(input.utilization),
    currency: readString(input.currency),
    decimalPlaces: readNumber(input.decimal_places),
    disabledReason: readString(input.disabled_reason),
    userDisabled: readBoolean(input.user_disabled),
    spendLimitReached: readBoolean(input.spend_limit_reached),
    creditsEverEnabled: readBoolean(input.credits_ever_enabled),
    daily: decodeUsageWindow(input.daily),
    weekly: decodeUsageWindow(input.weekly),
  };
};

const decodeLimit = (value: unknown) => {
  const input = readObject(value);
  if (!input) {
    return null;
  }
  const scope = readObject(input.scope);
  const model = readObject(scope?.model);
  return {
    kind: readString(input.kind),
    group: readString(input.group),
    percent: readNumber(input.percent),
    severity: readString(input.severity),
    resetsAt: readString(input.resets_at),
    modelId: readString(model?.id),
    modelDisplayName: readString(model?.display_name),
    surface: readString(scope?.surface),
    isActive: readBoolean(input.is_active),
  };
};

export const decodeClaudeSubscriptionUsage = (value: unknown) => {
  const input = readObject(value);
  if (!input) {
    throw new Error("Claude subscription usage response is malformed");
  }

  const modelWindows: Record<string, ReturnType<typeof decodeUsageWindow>> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (key.startsWith("seven_day_") && key !== "seven_day") {
      modelWindows[key] = decodeUsageWindow(entry);
    }
  }

  return {
    source: "oauth" as const,
    fiveHour: decodeUsageWindow(input.five_hour),
    sevenDay: decodeUsageWindow(input.seven_day),
    modelWindows,
    extraUsage: decodeExtraUsage(input.extra_usage),
    limits: Array.isArray(input.limits)
      ? input.limits.map(decodeLimit).filter((limit) => limit !== null)
      : [],
  };
};

export const fetchClaudeSubscriptionUsage = async (accessToken: string) => {
  const data = await fetchTrackingJson({
    url: `${ANTHROPIC_API_BASE_URL}/api/oauth/usage`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "anthropic-beta":
        CLAUDE_REQUIRED_BETA_HEADERS.find((header) =>
          header.startsWith("oauth-")
        ) ?? "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "User-Agent": "Kleis/1 account-usage",
    },
    timeoutMs: CLAUDE_USAGE_TIMEOUT_MS,
    errorPrefix: "Claude subscription usage request failed",
  });
  return decodeClaudeSubscriptionUsage(data);
};

const RATE_LIMIT_FIELDS = [
  "retry-after",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-limit",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
  "anthropic-ratelimit-input-tokens-limit",
  "anthropic-ratelimit-input-tokens-remaining",
  "anthropic-ratelimit-input-tokens-reset",
  "anthropic-ratelimit-output-tokens-limit",
  "anthropic-ratelimit-output-tokens-remaining",
  "anthropic-ratelimit-output-tokens-reset",
] as const;

const UNIFIED_FIELDS = [
  [
    "fiveHour",
    "anthropic-ratelimit-unified-5h-utilization",
    "anthropic-ratelimit-unified-5h-reset",
  ],
  [
    "sevenDay",
    "anthropic-ratelimit-unified-7d-utilization",
    "anthropic-ratelimit-unified-7d-reset",
  ],
] as const;

export const readClaudeRateLimitHeaders = (headers: Headers) => {
  const limits: Record<string, string> = {};
  for (const name of RATE_LIMIT_FIELDS) {
    const value = headers.get(name);
    if (value !== null) {
      limits[name] = value;
    }
  }

  const unified: Record<
    string,
    { utilization: number; rawUtilization: string; resetsAt: string | null }
  > = {};
  for (const [name, utilizationHeader, resetHeader] of UNIFIED_FIELDS) {
    const rawUtilization = headers.get(utilizationHeader);
    if (rawUtilization === null) {
      continue;
    }
    const parsed = Number(rawUtilization);
    if (!Number.isFinite(parsed)) {
      continue;
    }
    unified[name] = {
      utilization: Math.max(0, Math.min(100, parsed * 100)),
      rawUtilization,
      resetsAt: headers.get(resetHeader),
    };
  }

  const workspaceId = headers.get("anthropic-workspace-id");
  if (
    Object.keys(limits).length === 0 &&
    Object.keys(unified).length === 0 &&
    !workspaceId
  ) {
    return null;
  }
  return { workspaceId, limits, unified };
};
