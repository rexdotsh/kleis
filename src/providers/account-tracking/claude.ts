import {
  ANTHROPIC_API_BASE_URL,
  CLAUDE_CLI_USER_AGENT,
  CLAUDE_OAUTH_BETA_HEADER,
} from "../constants";
import {
  CLAUDE_RESET_CLAIM_TIMEOUT_MS,
  CLAUDE_RESET_PROGRAM,
  type ClaudeResetClaimResult,
  decodeClaudeResetClaimResult,
  decodeClaudeResetStatus,
} from "./claude-resets";
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
  free: "Free",
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
    case "claude_free":
      return "free";
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

const decodeClaudeSubscriptionPlan = (
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

// Everything Kleis keeps from /api/oauth/profile; the plan is derived the
// same way as decodeClaudeSubscriptionPlan.
export const decodeClaudeAccountProfile = (value: unknown) => {
  const input = requireObject(
    value,
    "Claude OAuth profile response is malformed"
  );
  const account = readObject(input.account);
  const organization = readObject(input.organization);
  return {
    plan: decodeClaudeSubscriptionPlan(input),
    displayName: readString(account?.display_name),
    fullName: readString(account?.full_name),
    organizationUuid: readString(organization?.uuid),
    organizationName: readString(organization?.name),
    organizationType: readString(organization?.organization_type),
    rateLimitTier: readString(organization?.rate_limit_tier),
    seatTier: readString(organization?.seat_tier),
    billingType: readString(organization?.billing_type),
    subscriptionStatus: readString(organization?.subscription_status),
    subscriptionCreatedAt: readString(organization?.subscription_created_at),
    trialEndsAt: readString(organization?.claude_code_trial_ends_at),
    hasExtraUsageEnabled: readBoolean(organization?.has_extra_usage_enabled),
  };
};

export type ClaudeAccountProfile = ReturnType<
  typeof decodeClaudeAccountProfile
> & { organizationRole: string | null; workspaceRole: string | null };

const claudeOAuthHeaders = (accessToken: string) => ({
  Authorization: `Bearer ${accessToken}`,
  Accept: "application/json",
  "anthropic-beta": CLAUDE_OAUTH_BETA_HEADER,
  "anthropic-version": "2023-06-01",
  "User-Agent": CLAUDE_CLI_USER_AGENT,
});

export const decodeClaudeRoles = (value: unknown) => {
  const input = requireObject(value, "Claude roles response is malformed");
  return {
    organizationRole: readString(input.organization_role),
    workspaceRole: readString(input.workspace_role),
  };
};

export const fetchClaudeRoles = async (accessToken: string) =>
  decodeClaudeRoles(
    await fetchTrackingJson({
      url: `${ANTHROPIC_API_BASE_URL}/api/oauth/claude_cli/roles`,
      headers: claudeOAuthHeaders(accessToken),
      timeoutMs: CLAUDE_PROFILE_TIMEOUT_MS,
      errorPrefix: "Claude roles request failed",
    })
  );

// The role is extra detail: when its lookup fails the profile still counts,
// with the previously known role.
export const fetchClaudeAccountProfile = async (
  accessToken: string,
  previous: ClaudeAccountProfile | null
): Promise<ClaudeAccountProfile> => {
  const [profile, roles] = await Promise.all([
    fetchTrackingJson({
      url: `${ANTHROPIC_API_BASE_URL}/api/oauth/profile`,
      headers: claudeOAuthHeaders(accessToken),
      timeoutMs: CLAUDE_PROFILE_TIMEOUT_MS,
      errorPrefix: "Claude OAuth profile request failed",
    }),
    fetchClaudeRoles(accessToken).catch(() => null),
  ]);
  return {
    ...decodeClaudeAccountProfile(profile),
    organizationRole:
      roles?.organizationRole ?? previous?.organizationRole ?? null,
    workspaceRole: roles?.workspaceRole ?? previous?.workspaceRole ?? null,
  };
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

const decodeClaudeSubscriptionUsage = (value: unknown) => {
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

// cedar_ember=1 adds the saved limit resets to the usual usage response, so
// one request reads both. Claude Code adds skip_spend=1, which drops
// extra_usage; Kleis shows extra usage, so it leaves that out.
export const fetchClaudeSubscriptionUsage = async (accessToken: string) => {
  const data = await fetchTrackingJson({
    url: `${ANTHROPIC_API_BASE_URL}/api/oauth/usage?${CLAUDE_RESET_PROGRAM}=1`,
    headers: claudeOAuthHeaders(accessToken),
    timeoutMs: CLAUDE_USAGE_TIMEOUT_MS,
    errorPrefix: "Claude subscription usage request failed",
  });
  return {
    usage: decodeClaudeSubscriptionUsage(data),
    resets: decodeClaudeResetStatus(readObject(data)?.[CLAUDE_RESET_PROGRAM]),
  };
};

export const claimClaudeResetCredit = async (input: {
  accessToken: string;
  organizationUuid: string;
  grantId: string;
  requestId: string;
}): Promise<ClaudeResetClaimResult> => {
  const value = await fetchTrackingJson({
    url: `${ANTHROPIC_API_BASE_URL}/api/organizations/${encodeURIComponent(input.organizationUuid)}/reset_rate_limits`,
    method: "POST",
    headers: {
      ...claudeOAuthHeaders(input.accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      program: CLAUDE_RESET_PROGRAM,
      grant_id: input.grantId,
      request_id: input.requestId,
    }),
    timeoutMs: CLAUDE_RESET_CLAIM_TIMEOUT_MS,
    errorPrefix: "Claude reset claim failed",
  });
  return decodeClaudeResetClaimResult(value);
};
