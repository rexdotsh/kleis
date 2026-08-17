import { ANTHROPIC_API_BASE_URL, CLAUDE_OAUTH_BETA_HEADER } from "../constants";
import {
  decodeArray,
  decodeFields,
  readBoolean,
  readNumber,
  readObject,
  readString,
  requireObject,
} from "./decode";
import { fetchTrackingJson } from "./http";

const CLAUDE_USAGE_TIMEOUT_MS = 10_000;

const decodeUsageWindow = (value: unknown) =>
  decodeFields(value, {
    utilization: ["utilization", readNumber],
    resetsAt: ["resets_at", readString],
    limitDollars: ["limit_dollars", readNumber],
    usedDollars: ["used_dollars", readNumber],
    remainingDollars: ["remaining_dollars", readNumber],
  });

const decodeExtraUsage = (value: unknown) =>
  decodeFields(value, {
    isEnabled: ["is_enabled", readBoolean],
    monthlyLimit: ["monthly_limit", readNumber],
    usedCredits: ["used_credits", readNumber],
    utilization: ["utilization", readNumber],
    currency: ["currency", readString],
    decimalPlaces: ["decimal_places", readNumber],
    disabledReason: ["disabled_reason", readString],
    userDisabled: ["user_disabled", readBoolean],
    spendLimitReached: ["spend_limit_reached", readBoolean],
    creditsEverEnabled: ["credits_ever_enabled", readBoolean],
    daily: ["daily", decodeUsageWindow],
    weekly: ["weekly", decodeUsageWindow],
  });

const decodeLimit = (value: unknown) => {
  const input = readObject(value);
  if (!input) {
    return null;
  }
  const scope = readObject(input.scope);
  const model = readObject(scope?.model);
  return {
    ...decodeFields(input, {
      kind: ["kind", readString],
      group: ["group", readString],
      percent: ["percent", readNumber],
      severity: ["severity", readString],
      resetsAt: ["resets_at", readString],
      isActive: ["is_active", readBoolean],
    }),
    modelId: readString(model?.id),
    modelDisplayName: readString(model?.display_name),
    surface: readString(scope?.surface),
  };
};

export const decodeClaudeSubscriptionUsage = (value: unknown) => {
  const input = requireObject(
    value,
    "Claude subscription usage response is malformed"
  );

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
    limits: decodeArray(input.limits, decodeLimit),
  };
};

export type ClaudeSubscriptionUsage = ReturnType<
  typeof decodeClaudeSubscriptionUsage
>;

export const fetchClaudeSubscriptionUsage = async (accessToken: string) => {
  const data = await fetchTrackingJson({
    url: `${ANTHROPIC_API_BASE_URL}/api/oauth/usage`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
      "anthropic-version": "2023-06-01",
      "User-Agent": "Kleis/1 account-usage",
    },
    timeoutMs: CLAUDE_USAGE_TIMEOUT_MS,
    errorPrefix: "Claude subscription usage request failed",
  });
  return decodeClaudeSubscriptionUsage(data);
};
