import { CODEX_ACCOUNT_ID_HEADER } from "../constants";
import { isObjectRecord } from "../../utils/object";
import { fetchTrackingJson } from "./http";

const CODEX_TRACKING_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_USAGE_TIMEOUT_MS = 10_000;
const CODEX_CREDITS_TIMEOUT_MS = 5000;
const CODEX_THREAD_TIMEOUT_MS = 60_000;

const readString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const readNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const readBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const readObject = (value: unknown): Record<string, unknown> | null =>
  isObjectRecord(value) ? value : null;

export type CodexRateLimitWindow = {
  usedPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
};

const decodeWindow = (value: unknown): CodexRateLimitWindow | null => {
  const input = readObject(value);
  if (!input) {
    return null;
  }
  return {
    usedPercent: readNumber(input.used_percent),
    windowSeconds: readNumber(input.limit_window_seconds),
    resetAfterSeconds: readNumber(input.reset_after_seconds),
    resetAt: readNumber(input.reset_at),
  };
};

const decodeAdditionalRateLimit = (value: unknown) => {
  const input = readObject(value);
  if (!input) {
    return null;
  }
  const rateLimit = readObject(input.rate_limit) ?? input;
  return {
    meteredFeature: readString(input.metered_feature),
    limitName: readString(input.limit_name),
    allowed: readBoolean(rateLimit.allowed),
    limitReached: readBoolean(rateLimit.limit_reached),
    primaryWindow: decodeWindow(rateLimit.primary_window),
    secondaryWindow: decodeWindow(rateLimit.secondary_window),
  };
};

export type CodexUsageStatus = ReturnType<typeof decodeCodexUsageStatus>;

export const decodeCodexUsageStatus = (value: unknown) => {
  const input = readObject(value);
  if (!input) {
    throw new Error("Codex usage response is malformed");
  }
  const rateLimit = readObject(input.rate_limit);
  const credits = readObject(input.credits);
  const spendControl = readObject(input.spend_control);
  const resetCredits = readObject(input.rate_limit_reset_credits);
  const additionalRateLimits = Array.isArray(input.additional_rate_limits)
    ? input.additional_rate_limits
        .map(decodeAdditionalRateLimit)
        .filter((entry) => entry !== null)
    : [];

  return {
    planType: readString(input.plan_type),
    allowed: readBoolean(rateLimit?.allowed),
    limitReached: readBoolean(rateLimit?.limit_reached),
    primaryWindow: decodeWindow(rateLimit?.primary_window),
    secondaryWindow: decodeWindow(rateLimit?.secondary_window),
    credits: credits
      ? {
          hasCredits: readBoolean(credits.has_credits),
          unlimited: readBoolean(credits.unlimited),
          balance: readString(credits.balance) ?? readNumber(credits.balance),
        }
      : null,
    spendControl: spendControl
      ? {
          reached: readBoolean(spendControl.reached),
          individualLimit:
            readString(spendControl.individual_limit) ??
            readNumber(spendControl.individual_limit),
        }
      : null,
    additionalRateLimits,
    rateLimitReachedType: readString(input.rate_limit_reached_type),
    resetCreditsAvailable: readNumber(resetCredits?.available_count),
  };
};

export type CodexResetCredit = {
  id: string;
  resetType: string | null;
  status: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  title: string | null;
  description: string | null;
};

export const decodeCodexResetCredits = (value: unknown) => {
  const input = readObject(value);
  if (!input) {
    throw new Error("Codex reset-credit response is malformed");
  }
  const credits: CodexResetCredit[] = [];
  if (Array.isArray(input.credits)) {
    for (const valueEntry of input.credits) {
      const entry = readObject(valueEntry);
      const id = readString(entry?.id);
      if (!entry || !id) {
        continue;
      }
      credits.push({
        id,
        resetType: readString(entry.reset_type),
        status: readString(entry.status),
        grantedAt: readString(entry.granted_at),
        expiresAt: readString(entry.expires_at),
        title: readString(entry.title),
        description: readString(entry.description),
      });
    }
  }
  return {
    availableCount: readNumber(input.available_count),
    credits,
  };
};

export const decodeCodexUsageProfile = (value: unknown) => {
  const input = readObject(value);
  if (!input) {
    throw new Error("Codex usage profile response is malformed");
  }
  const stats = readObject(input.stats);
  const dailyUsageBuckets: Array<{ startDate: string; tokens: number }> = [];
  if (Array.isArray(stats?.daily_usage_buckets)) {
    for (const valueEntry of stats.daily_usage_buckets) {
      const entry = readObject(valueEntry);
      const startDate = readString(entry?.start_date);
      const tokens = readNumber(entry?.tokens);
      if (startDate && tokens !== null) {
        dailyUsageBuckets.push({ startDate, tokens });
      }
    }
  }
  return {
    lifetimeTokens: readNumber(stats?.lifetime_tokens),
    peakDailyTokens: readNumber(stats?.peak_daily_tokens),
    longestRunningTurnSeconds: readNumber(stats?.longest_running_turn_sec),
    currentStreakDays: readNumber(stats?.current_streak_days),
    longestStreakDays: readNumber(stats?.longest_streak_days),
    dailyUsageBuckets,
  };
};

const decodeCodexAccount = (value: unknown) => {
  const input = readObject(value);
  const id = readString(input?.id);
  if (!input || !id) {
    return null;
  }
  return {
    id,
    name: readString(input.name),
    profilePictureUrl: readString(input.profile_picture_url),
    structure: readString(input.structure),
  };
};

export const decodeCodexAccounts = (value: unknown) => {
  const input = readObject(value);
  if (!input) {
    throw new Error("Codex accounts response is malformed");
  }
  const rawAccounts = Array.isArray(input.accounts)
    ? input.accounts
    : readObject(input.accounts)
      ? Object.values(input.accounts as Record<string, unknown>)
      : [];
  return {
    accounts: rawAccounts
      .map(decodeCodexAccount)
      .filter((account) => account !== null),
    accountOrdering: Array.isArray(input.account_ordering)
      ? input.account_ordering.filter(
          (entry): entry is string => typeof entry === "string"
        )
      : [],
    defaultAccountId: readString(input.default_account_id),
  };
};

export type CodexThreadUsageEntry = {
  threadId: string;
  estimatedUsageCreditsMicros: number | null;
  estimatedUsageUsdMicros: number | null;
  groups: Array<{
    model: string | null;
    reasoningEffort: string | null;
    speed: string | null;
    estimatedUsageCreditsMicros: number | null;
    netNewInputTokens: number | null;
    cachedInputTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  }>;
};

export const decodeCodexThreadUsage = (
  value: unknown
): CodexThreadUsageEntry[] => {
  const input = readObject(value);
  if (!input || !Array.isArray(input.threads)) {
    throw new Error("Codex thread usage response is malformed");
  }
  const threads: CodexThreadUsageEntry[] = [];
  for (const threadValue of input.threads) {
    const thread = readObject(threadValue);
    const threadId = readString(thread?.thread_id);
    if (!thread || !threadId) {
      continue;
    }
    const groups = Array.isArray(thread.groups)
      ? thread.groups.flatMap((groupValue) => {
          const group = readObject(groupValue);
          if (!group) {
            return [];
          }
          return [
            {
              model: readString(group.model),
              reasoningEffort: readString(group.reasoning_effort),
              speed: readString(group.speed),
              estimatedUsageCreditsMicros: readNumber(
                group.estimated_usage_credits_micros
              ),
              netNewInputTokens: readNumber(group.net_new_input_tokens),
              cachedInputTokens: readNumber(group.cached_input_tokens),
              inputTokens: readNumber(group.input_tokens),
              outputTokens: readNumber(group.output_tokens),
              totalTokens: readNumber(group.total_tokens),
            },
          ];
        })
      : [];
    threads.push({
      threadId,
      estimatedUsageCreditsMicros: readNumber(
        thread.estimated_usage_credits_micros
      ),
      estimatedUsageUsdMicros: readNumber(thread.estimated_usage_usd_micros),
      groups,
    });
  }
  return threads;
};

export const decodeCodexResetResult = (value: unknown) => {
  const input = readObject(value);
  const code = readString(input?.code);
  if (!input || !code) {
    throw new Error("Codex reset-credit consume response is malformed");
  }
  return { code, windowsReset: readNumber(input.windows_reset) };
};

export const buildCodexTrackingUrl = (
  operation:
    | "usage"
    | "rate-limit-reset-credits"
    | "rate-limit-reset-credits/consume"
    | "profiles/me"
    | "accounts/check"
    | "usage/thread_usage/query",
  baseUrl = CODEX_TRACKING_BASE_URL
): string => {
  const base = new URL(baseUrl);
  const isChatGpt = base.hostname === "chatgpt.com";
  base.pathname = isChatGpt
    ? `/backend-api/wham/${operation}`
    : `/api/codex/${operation}`;
  base.search = "";
  base.hash = "";
  return base.toString();
};

const codexHeaders = (accessToken: string, accountId: string | null) => {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "codex-cli",
  });
  if (accountId) {
    headers.set(CODEX_ACCOUNT_ID_HEADER, accountId);
  }
  return headers;
};

const getCodexJson = (
  operation: Parameters<typeof buildCodexTrackingUrl>[0],
  accessToken: string,
  accountId: string | null,
  timeoutMs = CODEX_USAGE_TIMEOUT_MS
) =>
  fetchTrackingJson({
    url: buildCodexTrackingUrl(operation),
    headers: codexHeaders(accessToken, accountId),
    timeoutMs,
    errorPrefix: `Codex ${operation} request failed`,
  });

export const fetchCodexUsageStatus = async (
  accessToken: string,
  accountId: string | null
) =>
  decodeCodexUsageStatus(await getCodexJson("usage", accessToken, accountId));

export const fetchCodexResetCredits = async (
  accessToken: string,
  accountId: string | null
) =>
  decodeCodexResetCredits(
    await getCodexJson(
      "rate-limit-reset-credits",
      accessToken,
      accountId,
      CODEX_CREDITS_TIMEOUT_MS
    )
  );

export const fetchCodexUsageProfile = async (
  accessToken: string,
  accountId: string | null
) =>
  decodeCodexUsageProfile(
    await getCodexJson("profiles/me", accessToken, accountId)
  );

export const fetchCodexAccounts = async (
  accessToken: string,
  accountId: string | null
) =>
  decodeCodexAccounts(
    await getCodexJson("accounts/check", accessToken, accountId)
  );

const postCodexJson = (
  operation: Parameters<typeof buildCodexTrackingUrl>[0],
  accessToken: string,
  accountId: string | null,
  body: Record<string, unknown>,
  timeoutMs: number
) => {
  const headers = codexHeaders(accessToken, accountId);
  headers.set("Content-Type", "application/json");
  return fetchTrackingJson({
    url: buildCodexTrackingUrl(operation),
    method: "POST",
    headers,
    body: JSON.stringify(body),
    timeoutMs,
    errorPrefix: `Codex ${operation} request failed`,
  });
};

export const fetchCodexThreadUsage = async (
  accessToken: string,
  accountId: string | null,
  threadIds: readonly string[]
) =>
  decodeCodexThreadUsage(
    await postCodexJson(
      "usage/thread_usage/query",
      accessToken,
      accountId,
      { thread_ids: threadIds },
      CODEX_THREAD_TIMEOUT_MS
    )
  );

export const consumeCodexResetCredit = async (input: {
  accessToken: string;
  accountId: string | null;
  redeemRequestId: string;
  creditId: string | null;
}) =>
  decodeCodexResetResult(
    await postCodexJson(
      "rate-limit-reset-credits/consume",
      input.accessToken,
      input.accountId,
      {
        redeem_request_id: input.redeemRequestId,
        ...(input.creditId ? { credit_id: input.creditId } : {}),
      },
      CODEX_USAGE_TIMEOUT_MS
    )
  );
