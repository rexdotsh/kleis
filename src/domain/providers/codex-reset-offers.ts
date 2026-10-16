import type { readCodexResetCreditState } from "../../db/repositories/codex-reset-redemptions";
import type {
  fetchCodexResetCredits,
  CodexUsageStatus,
} from "../../providers/account-tracking/codex";
import { toMillisecondsTimestamp } from "../../utils/timestamp";

export const CODEX_RESET_OFFER_MAX_AGE_MS = 10 * 60_000;
type EarlyUse = { scope: string | null; percentUsed: number | null } | null;

const earlyUse = (
  status: CodexUsageStatus | undefined,
  now: number
): EarlyUse => {
  const windows = [status?.primaryWindow, status?.secondaryWindow].map(
    (window, index) => {
      const seconds = window?.windowSeconds;
      const scope = seconds
        ? `${seconds >= 86400 ? `${seconds / 86400}d` : `${seconds / 3600}h`} window`
        : index === 0
          ? "short window"
          : "long window";
      const percent =
        window?.resetAt != null &&
        toMillisecondsTimestamp(window.resetAt) <= now
          ? 0
          : window?.usedPercent;
      return {
        scope,
        percentUsed:
          typeof percent === "number" &&
          Number.isFinite(percent) &&
          percent >= 0
            ? Math.min(100, percent)
            : null,
      };
    }
  );
  if (windows.some((window) => window.percentUsed === 100)) return null;
  const highest = windows
    .filter((window) => window.percentUsed !== null)
    .sort((a, b) => (b.percentUsed ?? 0) - (a.percentUsed ?? 0))[0] ?? {
    scope: null,
    percentUsed: null,
  };
  return {
    ...highest,
    percentUsed:
      highest.percentUsed === null ? null : Math.round(highest.percentUsed),
  };
};

export type CodexResetAction =
  | { kind: "pending"; creditId: string | null; redeemRequestId: string }
  | {
      kind: "offer";
      accountIdentity: string;
      creditId: string;
      offerKey: string;
      generation: number;
      observedAt: number;
      expiresAt: number | null;
      earlyUse: EarlyUse;
    };

export const describeCodexResetAction = (
  accountIdentity: string,
  state: Awaited<ReturnType<typeof readCodexResetCreditState>>,
  credits: Awaited<ReturnType<typeof fetchCodexResetCredits>> | undefined,
  observedAt: number,
  status?: CodexUsageStatus,
  now = observedAt
): CodexResetAction | null => {
  if (state.pending) {
    return {
      kind: "pending",
      creditId: state.pending.creditId,
      redeemRequestId: state.pending.redeemRequestId,
    };
  }
  if (observedAt > now || observedAt < now - CODEX_RESET_OFFER_MAX_AGE_MS)
    return null;
  const available = credits?.credits.filter(
    (credit) =>
      credit.status === "available" &&
      (!credit.expiresAt || Date.parse(credit.expiresAt) > now)
  );
  const credit = available?.sort(
    (a, b) =>
      (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) -
      (b.expiresAt ? Date.parse(b.expiresAt) : Infinity)
  )[0];
  if (!credit) return null;
  const warning = earlyUse(status, now);
  const offerKey = Bun.CryptoHasher.hash(
    "sha256",
    JSON.stringify({
      accountIdentity,
      generation: state.generation,
      credit,
      earlyUse: warning,
      count: credits?.availableCount,
      ids: available
        ?.map((entry) => entry.id)
        .sort((a, b) => a.localeCompare(b)),
    }),
    "hex"
  );
  return {
    kind: "offer",
    accountIdentity,
    creditId: credit.id,
    offerKey,
    generation: state.generation,
    observedAt,
    earlyUse: warning,
    expiresAt: credit.expiresAt ? Date.parse(credit.expiresAt) : null,
  };
};

export const currentCodexResetAction = (
  data: {
    resetCreditAction?: CodexResetAction | null;
    resetCredits?: Awaited<ReturnType<typeof fetchCodexResetCredits>>;
    status?: CodexUsageStatus;
  },
  now: number
): CodexResetAction | null => {
  const action = data.resetCreditAction;
  return action?.kind === "offer"
    ? describeCodexResetAction(
        action.accountIdentity,
        { generation: action.generation, pending: null },
        data.resetCredits,
        action.observedAt,
        data.status,
        now
      )
    : (action ?? null);
};
