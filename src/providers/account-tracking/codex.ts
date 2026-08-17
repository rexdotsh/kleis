import { CODEX_ACCOUNT_ID_HEADER } from "../constants";
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

const CODEX_TRACKING_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_USAGE_TIMEOUT_MS = 10_000;
const CODEX_CREDITS_TIMEOUT_MS = 5000;
const CODEX_THREAD_TIMEOUT_MS = 60_000;

export type CodexRateLimitWindow = {
  usedPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
};

const decodeWindow = (value: unknown): CodexRateLimitWindow | null =>
  decodeFields(value, {
    usedPercent: ["used_percent", readNumber],
    windowSeconds: ["limit_window_seconds", readNumber],
    resetAfterSeconds: ["reset_after_seconds", readNumber],
    resetAt: ["reset_at", readNumber],
  });

const decodeAdditionalRateLimit = (value: unknown) => {
  const input = readObject(value);
  if (!input) {
    return null;
  }
  const rateLimit = readObject(input.rate_limit) ?? input;
  return {
    ...decodeFields(input, {
      meteredFeature: ["metered_feature", readString],
      limitName: ["limit_name", readString],
    }),
    ...decodeFields(rateLimit, {
      allowed: ["allowed", readBoolean],
      limitReached: ["limit_reached", readBoolean],
      primaryWindow: ["primary_window", decodeWindow],
      secondaryWindow: ["secondary_window", decodeWindow],
    }),
  };
};

export type CodexUsageStatus = ReturnType<typeof decodeCodexUsageStatus>;

export const decodeCodexUsageStatus = (value: unknown) => {
  const input = requireObject(value, "Codex usage response is malformed");
  const rateLimit = readObject(input.rate_limit);
  const credits = readObject(input.credits);
  const spendControl = readObject(input.spend_control);
  const resetCredits = readObject(input.rate_limit_reset_credits);

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
    additionalRateLimits: decodeArray(
      input.additional_rate_limits,
      decodeAdditionalRateLimit
    ),
    rateLimitReachedType: readString(input.rate_limit_reached_type),
    resetCreditsAvailable: readNumber(resetCredits?.available_count),
  };
};

const decodeResetCredit = (value: unknown) => {
  const input = readObject(value);
  const id = readString(input?.id);
  return input && id
    ? {
        id,
        ...decodeFields(input, {
          resetType: ["reset_type", readString],
          status: ["status", readString],
          grantedAt: ["granted_at", readString],
          expiresAt: ["expires_at", readString],
          title: ["title", readString],
          description: ["description", readString],
        }),
      }
    : null;
};

export const decodeCodexResetCredits = (value: unknown) => {
  const input = requireObject(
    value,
    "Codex reset-credit response is malformed"
  );
  return {
    availableCount: readNumber(input.available_count),
    credits: decodeArray(input.credits, decodeResetCredit),
  };
};

export type CodexResetCredits = ReturnType<typeof decodeCodexResetCredits>;

export const decodeCodexUsageProfile = (value: unknown) => {
  const input = requireObject(
    value,
    "Codex usage profile response is malformed"
  );
  const stats = readObject(input.stats);
  return {
    lifetimeTokens: readNumber(stats?.lifetime_tokens),
    peakDailyTokens: readNumber(stats?.peak_daily_tokens),
    longestRunningTurnSeconds: readNumber(stats?.longest_running_turn_sec),
    currentStreakDays: readNumber(stats?.current_streak_days),
    longestStreakDays: readNumber(stats?.longest_streak_days),
    dailyUsageBuckets: decodeArray(stats?.daily_usage_buckets, (valueEntry) => {
      const entry = readObject(valueEntry);
      const startDate = readString(entry?.start_date);
      const tokens = readNumber(entry?.tokens);
      return startDate && tokens !== null ? { startDate, tokens } : null;
    }),
  };
};

export type CodexUsageProfile = ReturnType<typeof decodeCodexUsageProfile>;

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
  const input = requireObject(value, "Codex accounts response is malformed");
  const rawAccounts = Array.isArray(input.accounts)
    ? input.accounts
    : readObject(input.accounts)
      ? Object.values(input.accounts as Record<string, unknown>)
      : [];
  return {
    accounts: decodeArray(rawAccounts, decodeCodexAccount),
    accountOrdering: Array.isArray(input.account_ordering)
      ? input.account_ordering.filter(
          (entry): entry is string => typeof entry === "string"
        )
      : [],
    defaultAccountId: readString(input.default_account_id),
  };
};

export type CodexAccounts = ReturnType<typeof decodeCodexAccounts>;

const decodeThreadGroup = (value: unknown) => {
  const input = readObject(value);
  return input
    ? decodeFields(input, {
        model: ["model", readString],
        reasoningEffort: ["reasoning_effort", readString],
        speed: ["speed", readString],
        estimatedUsageCreditsMicros: [
          "estimated_usage_credits_micros",
          readNumber,
        ],
        netNewInputTokens: ["net_new_input_tokens", readNumber],
        cachedInputTokens: ["cached_input_tokens", readNumber],
        inputTokens: ["input_tokens", readNumber],
        outputTokens: ["output_tokens", readNumber],
        totalTokens: ["total_tokens", readNumber],
      })
    : null;
};

const decodeThread = (value: unknown) => {
  const input = readObject(value);
  const threadId = readString(input?.thread_id);
  return input && threadId
    ? {
        threadId,
        ...decodeFields(input, {
          estimatedUsageCreditsMicros: [
            "estimated_usage_credits_micros",
            readNumber,
          ],
          estimatedUsageUsdMicros: ["estimated_usage_usd_micros", readNumber],
        }),
        groups: decodeArray(input.groups, decodeThreadGroup),
      }
    : null;
};

export type CodexThreadUsageEntry = NonNullable<
  ReturnType<typeof decodeThread>
>;

export const decodeCodexThreadUsage = (
  value: unknown
): CodexThreadUsageEntry[] => {
  const input = requireObject(
    value,
    "Codex thread usage response is malformed"
  );
  if (!Array.isArray(input.threads)) {
    throw new Error("Codex thread usage response is malformed");
  }
  return decodeArray(input.threads, decodeThread);
};

export const decodeCodexResetResult = (value: unknown) => {
  const input = requireObject(
    value,
    "Codex reset-credit consume response is malformed"
  );
  const code = readString(input?.code);
  if (!code) {
    throw new Error("Codex reset-credit consume response is malformed");
  }
  return { code, windowsReset: readNumber(input.windows_reset) };
};

type CodexTrackingOperation =
  | "usage"
  | "rate-limit-reset-credits"
  | "rate-limit-reset-credits/consume"
  | "profiles/me"
  | "accounts/check"
  | "usage/thread_usage/query";

export const buildCodexTrackingUrl = (
  operation: CodexTrackingOperation,
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

const requestCodex = async <T>(
  operation: CodexTrackingOperation,
  accessToken: string,
  accountId: string | null,
  decode: (value: unknown) => T,
  options?: { body?: Record<string, unknown>; timeoutMs?: number }
): Promise<T> => {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "codex-cli",
  });
  if (accountId) {
    headers.set(CODEX_ACCOUNT_ID_HEADER, accountId);
  }
  if (options?.body) {
    headers.set("Content-Type", "application/json");
  }
  const value = await fetchTrackingJson({
    url: buildCodexTrackingUrl(operation),
    headers,
    ...(options?.body
      ? { method: "POST" as const, body: JSON.stringify(options.body) }
      : {}),
    timeoutMs: options?.timeoutMs ?? CODEX_USAGE_TIMEOUT_MS,
    errorPrefix: `Codex ${operation} request failed`,
  });
  return decode(value);
};

export const fetchCodexUsageStatus = async (
  accessToken: string,
  accountId: string | null
) => requestCodex("usage", accessToken, accountId, decodeCodexUsageStatus);

export const fetchCodexResetCredits = async (
  accessToken: string,
  accountId: string | null
) =>
  requestCodex(
    "rate-limit-reset-credits",
    accessToken,
    accountId,
    decodeCodexResetCredits,
    { timeoutMs: CODEX_CREDITS_TIMEOUT_MS }
  );

export const fetchCodexUsageProfile = async (
  accessToken: string,
  accountId: string | null
) =>
  requestCodex("profiles/me", accessToken, accountId, decodeCodexUsageProfile);

export const fetchCodexAccounts = async (
  accessToken: string,
  accountId: string | null
) =>
  requestCodex("accounts/check", accessToken, accountId, decodeCodexAccounts);

export const fetchCodexThreadUsage = async (
  accessToken: string,
  accountId: string | null,
  threadIds: readonly string[]
) =>
  requestCodex(
    "usage/thread_usage/query",
    accessToken,
    accountId,
    decodeCodexThreadUsage,
    {
      body: { thread_ids: threadIds },
      timeoutMs: CODEX_THREAD_TIMEOUT_MS,
    }
  );

export const consumeCodexResetCredit = async (input: {
  accessToken: string;
  accountId: string | null;
  redeemRequestId: string;
  creditId: string | null;
}) =>
  requestCodex(
    "rate-limit-reset-credits/consume",
    input.accessToken,
    input.accountId,
    decodeCodexResetResult,
    {
      body: {
        redeem_request_id: input.redeemRequestId,
        ...(input.creditId ? { credit_id: input.creditId } : {}),
      },
    }
  );
