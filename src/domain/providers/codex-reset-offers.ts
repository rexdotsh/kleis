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

export type CodexResetConfirmation = {
  mode: "spend" | "resolve" | "review";
  accountIdentity: string;
  creditId: string | null;
  offerKey: string;
  generation: number;
  observedAt: number;
  expiresAt: number | null;
  earlyUse: EarlyUse;
};

type PendingAction = {
  kind: "pending";
  accountIdentity: string;
  generation: number;
  observedAt: number;
  creditId: string | null;
  redeemRequestId: string;
  updatedAt: number;
  knownResult: boolean;
  inFlight: boolean;
  identityUnverified: boolean;
  recovery: CodexResetConfirmation | null;
};
export type CodexResetAction =
  | PendingAction
  | (CodexResetConfirmation & { kind: "offer"; creditId: string });

const isFresh = (observedAt: number, now: number) =>
  observedAt <= now && observedAt >= now - CODEX_RESET_OFFER_MAX_AGE_MS;

const pendingAction = (
  pending: PendingAction,
  credits: Awaited<ReturnType<typeof fetchCodexResetCredits>> | undefined,
  status: CodexUsageStatus | undefined,
  now: number
): PendingAction => {
  const action = { ...pending, recovery: null } as PendingAction;
  if (
    pending.knownResult ||
    !isFresh(pending.observedAt, now) ||
    pending.observedAt < pending.updatedAt ||
    (pending.inFlight && pending.updatedAt > now - 120_000) ||
    !credits
  )
    return action;
  const credit = credits.credits.find((entry) => entry.id === pending.creditId);
  const available =
    credit?.status === "available" &&
    (!credit.expiresAt || Date.parse(credit.expiresAt) > now);
  const authoritative =
    credits.availableCount !== null &&
    credits.availableCount ===
      credits.credits.filter(
        (entry) =>
          entry.status === "available" &&
          (!entry.expiresAt || Date.parse(entry.expiresAt) > now)
      ).length;
  let mode: CodexResetConfirmation["mode"];
  if (pending.identityUnverified || pending.creditId === null) mode = "review";
  else if (available) mode = "spend";
  else if (
    authoritative &&
    (!credit ||
      ["consumed", "redeemed", "used", "expired", "ineligible"].includes(
        credit.status ?? ""
      ))
  )
    mode = "resolve";
  else mode = "review";
  if (
    mode !== "spend" &&
    (pending.observedAt < pending.updatedAt + 120_000 ||
      (mode === "resolve" && !authoritative))
  )
    return action;
  const warning = mode === "spend" ? earlyUse(status, now) : null;
  const offerKey = Bun.CryptoHasher.hash(
    "sha256",
    JSON.stringify([
      pending.accountIdentity,
      pending.generation,
      pending.redeemRequestId,
      pending.updatedAt,
      mode,
      credit,
      warning,
      credits,
    ]),
    "hex"
  );
  action.recovery = {
    mode,
    accountIdentity: pending.accountIdentity,
    creditId: pending.creditId,
    offerKey,
    generation: pending.generation,
    observedAt: pending.observedAt,
    earlyUse: warning,
    expiresAt: credit?.expiresAt ? Date.parse(credit.expiresAt) : null,
  };
  return action;
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
    return pendingAction(
      {
        kind: "pending",
        accountIdentity,
        generation: state.generation,
        observedAt,
        creditId: state.pending.creditId,
        redeemRequestId: state.pending.redeemRequestId,
        updatedAt: state.pending.updatedAt,
        knownResult: state.pending.resultCode !== null,
        inFlight: state.pending.executionToken !== null,
        identityUnverified: state.unverified,
        recovery: null,
      },
      credits,
      status,
      now
    );
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
    mode: "spend",
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
        { generation: action.generation, pending: null, unverified: false },
        data.resetCredits,
        action.observedAt,
        data.status,
        now
      )
    : action?.kind === "pending"
      ? pendingAction(action, data.resetCredits, data.status, now)
      : null;
};
