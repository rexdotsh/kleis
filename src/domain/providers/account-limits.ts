import type { ProviderAccountRecord } from "../../db/repositories/provider-accounts";
import { toMillisecondsTimestamp } from "../../utils/timestamp";
import {
  getCachedProviderAccountQuota,
  isTrackingAccount,
  peekCodexResetCredits,
} from "./provider-account-tracking";
import { describeClaudeResets } from "./reset-spends";

type LimitWindow = {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
};

export type AccountLimits = {
  id: string;
  provider: ProviderAccountRecord["provider"];
  label: string | null;
  fetchedAt: number | null;
  windows: LimitWindow[];
  savedResets: number | null;
};

type RawWindow = {
  usedPercent?: number | null;
  utilization?: number | null;
  windowSeconds?: number | null;
  resetAt?: number | null;
  resetAfterSeconds?: number | null;
  resetsAt?: string | null;
} | null;

const spanLabel = (seconds: number | null | undefined, fallback: string) => {
  if (typeof seconds !== "number" || seconds <= 0) return fallback;
  const hours = Math.round(seconds / 3600);
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
};

const claudeWindowLabel = (key: string): string =>
  key === "seven_day_overage_included"
    ? "7d incl. extra"
    : `${key.replace(/^seven_day_/u, "").replaceAll("_", " ")} 7d`;

const toWindow = (
  label: string,
  window: RawWindow | undefined,
  fetchedAt: number | null
): LimitWindow | null => {
  const percent = window?.usedPercent ?? window?.utilization;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  let resetsAt: number | null = null;
  if (typeof window?.resetAt === "number") {
    resetsAt = toMillisecondsTimestamp(window.resetAt);
  } else if (window?.resetsAt) {
    const parsed = Date.parse(window.resetsAt);
    resetsAt = Number.isFinite(parsed) ? parsed : null;
  } else if (
    fetchedAt !== null &&
    typeof window?.resetAfterSeconds === "number"
  ) {
    resetsAt = fetchedAt + window.resetAfterSeconds * 1000;
  }
  return {
    label,
    usedPercent: Math.max(0, Math.min(100, percent)),
    resetsAt,
  };
};

// Limits from the cached snapshot only; reading them never contacts a
// provider. Shared by every endpoint that shows limits outside the admin.
export const describeAccountLimits = (
  account: ProviderAccountRecord
): AccountLimits => {
  const tracked = isTrackingAccount(account) ? account : null;
  const quota = tracked ? getCachedProviderAccountQuota(tracked) : null;
  const fetchedAt = quota?.fetchedAt ?? null;
  const data = quota?.data;
  const windows: [string, RawWindow | undefined][] = [];
  let savedResets: number | null = null;
  if (data?.provider === "codex") {
    const status = data.status;
    windows.push(
      [
        spanLabel(status?.primaryWindow?.windowSeconds, "5h"),
        status?.primaryWindow,
      ],
      [
        spanLabel(status?.secondaryWindow?.windowSeconds, "7d"),
        status?.secondaryWindow,
      ]
    );
    for (const limit of status?.additionalRateLimits ?? []) {
      const name = limit.limitName ?? limit.meteredFeature ?? "Extra";
      windows.push(
        [
          `${name} ${spanLabel(limit.primaryWindow?.windowSeconds, "5h")}`,
          limit.primaryWindow,
        ],
        [
          `${name} ${spanLabel(limit.secondaryWindow?.windowSeconds, "7d")}`,
          limit.secondaryWindow,
        ]
      );
    }
    savedResets =
      (tracked ? peekCodexResetCredits(tracked)?.availableCount : null) ??
      status?.resetCreditsAvailable ??
      null;
  } else if (data?.provider === "claude") {
    const usage = data.subscription;
    windows.push(["5h", usage?.fiveHour], ["7d", usage?.sevenDay]);
    for (const [key, window] of Object.entries(usage?.modelWindows ?? {})) {
      windows.push([claudeWindowLabel(key), window]);
    }
    for (const limit of usage?.limits ?? []) {
      if (limit.kind === "weekly_scoped") {
        windows.push([
          `${limit.modelDisplayName ?? limit.modelId ?? "Scoped"} 7d`,
          {
            utilization: limit.percent ?? null,
            resetsAt: limit.resetsAt ?? null,
          },
        ]);
      }
    }
    const resets = describeClaudeResets(account);
    savedResets =
      resets && resets.unavailable !== "checking" ? resets.saved : null;
  }
  return {
    id: account.id,
    provider: account.provider,
    label: account.label,
    fetchedAt,
    windows: windows
      .map(([label, window]) => toWindow(label, window, fetchedAt))
      .filter((window): window is LimitWindow => window !== null),
    savedResets,
  };
};
