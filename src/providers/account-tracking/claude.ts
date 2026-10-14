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
const CLAUDE_PROFILE_TIMEOUT_MS = 5000;

const CLAUDE_PLAN_LABELS = {
  pro: "Pro",
  max: "Max",
  max_5x: "Max 5x",
  max_20x: "Max 20x",
  team: "Team",
  team_standard: "Team Standard",
  team_premium: "Team Premium",
  enterprise: "Enterprise",
} as const;

type ClaudePlanType = keyof typeof CLAUDE_PLAN_LABELS;

export type ClaudeSubscriptionPlan = { type: ClaudePlanType; label: string };

// The organization decides the plan; Team premium seats carry the Max 5x rate
// tier, so on Team it identifies the seat rather than a Max subscription.
const readTeamSeat = (
  seatTier: string | null,
  rateLimitTier: string | null
): ClaudePlanType => {
  if (seatTier === "team_standard") return "team_standard";
  if (seatTier === "team_tier_1") return "team_premium";
  if (rateLimitTier === "default_claude_max_5x") return "team_premium";
  return "team";
};

const readClaudePlanType = (
  organizationType: string | null,
  rateLimitTier: string | null,
  seatTier: string | null
): ClaudePlanType | null => {
  switch (organizationType) {
    case "claude_pro":
      return "pro";
    case "claude_max":
      if (rateLimitTier === "default_claude_max_20x") return "max_20x";
      if (rateLimitTier === "default_claude_max_5x") return "max_5x";
      return "max";
    case "claude_team":
      return readTeamSeat(seatTier, rateLimitTier);
    case "claude_enterprise":
      return "enterprise";
    default:
      return null;
  }
};

export const decodeClaudeSubscriptionPlan = (
  value: unknown
): ClaudeSubscriptionPlan | null => {
  const input = requireObject(
    value,
    "Claude OAuth profile response is malformed"
  );
  const organization = readObject(input.organization);
  const type = readClaudePlanType(
    readString(organization?.organization_type),
    readString(organization?.rate_limit_tier),
    readString(organization?.seat_tier)
  );
  return type ? { type, label: CLAUDE_PLAN_LABELS[type] } : null;
};

export const fetchClaudeSubscriptionPlan = async (accessToken: string) => {
  const data = await fetchTrackingJson({
    url: `${ANTHROPIC_API_BASE_URL}/api/oauth/profile`,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
      "anthropic-version": "2023-06-01",
      "User-Agent": "Kleis/1 account-usage",
    },
    timeoutMs: CLAUDE_PROFILE_TIMEOUT_MS,
    errorPrefix: "Claude OAuth profile request failed",
  });
  return decodeClaudeSubscriptionPlan(data);
};

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
