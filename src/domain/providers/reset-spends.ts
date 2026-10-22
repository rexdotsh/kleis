import type { Database } from "../../db";
import {
  findProviderAccountById,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import {
  settleResetSpend,
  startResetSpend,
} from "../../db/repositories/reset-spends";
import { claimClaudeResetCredit } from "../../providers/account-tracking/claude";
import {
  type ClaudeResetClaimResult,
  type ClaudeResetSummary,
  summarizeClaudeResets,
} from "../../providers/account-tracking/claude-resets";
import { consumeCodexResetCredit } from "../../providers/account-tracking/codex";
import { AccountTrackingHttpError } from "../../providers/account-tracking/http";
import { errorLogFields, logWarn } from "../../utils/log";
import {
  claudeResetLimitUsage,
  invalidateResetCredits,
  isTrackingAccount,
  peekClaudeResetCredits,
  peekCodexResetCredits,
  reloadCodexQuota,
  resolveAccount,
  retryAfter401,
  scheduleConfirmingRead,
  type TrackingAccount,
} from "./provider-account-tracking";

// Claude resets are only spent against a read this recent.
const CLAUDE_OFFER_MAX_AGE_MS = 10 * 60_000;

export class ResetSpendConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetSpendConflict";
  }
}

export class ResetSpendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResetSpendError";
  }
}

const conflictMessages = {
  in_progress: "A reset is already in progress for this account.",
  stale: "Waiting for the next limits check before another reset can be used.",
  not_current: "That reset is no longer available.",
} as const;

const conflict = (reason: keyof typeof conflictMessages) =>
  new ResetSpendConflict(conflictMessages[reason]);

// Answered before anything is spent. A 409 or 429 may mean another request
// with this reset is still being processed.
const isRefusal = (error: unknown): boolean =>
  error instanceof AccountTrackingHttpError &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 409 &&
  error.status !== 429;

// Sends one spend, checked against discovery data read at `observedAt`. An
// unknown outcome, or an answer `settles` rejects, stays pending until it
// expires; the next limits check then shows what happened. Cached limits and
// resets are dropped unless the answer says nothing changed.
const spendReset = async <T>(
  database: Database,
  account: TrackingAccount,
  itemId: string,
  observedAt: number,
  send: (requestId: string) => Promise<T>,
  settles: (result: T) => boolean,
  unchanged: (result: T) => boolean
): Promise<T> => {
  const started = await startResetSpend(
    database,
    { provider: account.provider, providerAccountId: account.id, itemId },
    observedAt
  );
  if ("blocked" in started) throw conflict(started.blocked);
  const settle = (status: "completed" | "failed") =>
    settleResetSpend(database, started.requestId, status).catch(
      (error: unknown) =>
        logWarn("reset_spend_record_failed", {
          providerAccountId: account.id,
          ...errorLogFields(error),
        })
    );
  let result: { value: T } | null = null;
  try {
    result = { value: await send(started.requestId) };
    if (settles(result.value)) await settle("completed");
    return result.value;
  } catch (error) {
    if (!isRefusal(error)) {
      throw new ResetSpendError(
        "Couldn't confirm the reset. It may have been used; the next limits check will show it."
      );
    }
    await settle("failed");
    throw new ResetSpendError(
      `${error instanceof Error ? error.message : "Reset refused"}. Nothing was used.`
    );
  } finally {
    if (!(result && unchanged(result.value))) invalidateResetCredits(account);
  }
};

const loadAccount = async (
  database: Database,
  providerAccountId: string,
  provider: TrackingAccount["provider"]
): Promise<TrackingAccount | null> => {
  const stored = await findProviderAccountById(database, providerAccountId);
  return stored && isTrackingAccount(stored) && stored.provider === provider
    ? resolveAccount(database, stored)
    : null;
};

export const redeemCodexResetCredit = async (
  database: Database,
  providerAccountId: string,
  creditId: string
) => {
  const account = await loadAccount(database, providerAccountId, "codex");
  if (!account) return null;
  const credits = peekCodexResetCredits(account);
  if (!credits) throw conflict("stale");
  if (
    !credits.credits.some(
      (credit) => credit.id === creditId && credit.status === "available"
    )
  ) {
    throw conflict("not_current");
  }
  const result = await spendReset(
    database,
    account,
    creditId,
    credits.observedAt ?? 0,
    (redeemRequestId) =>
      retryAfter401(database, account, (current) =>
        consumeCodexResetCredit({
          accessToken: current.accessToken,
          accountId: current.accountId,
          redeemRequestId,
          creditId,
        })
      ),
    () => true,
    ({ code }) => code === "nothing_to_reset"
  ).catch(async (error: unknown) => {
    await reloadCodexQuota(database, account);
    throw error;
  });
  if (result.code === "nothing_to_reset") return result;
  await reloadCodexQuota(database, account);
  if (result.code === "reset" || result.code === "already_redeemed") {
    scheduleConfirmingRead(database, account);
  }
  return result;
};

const claudeSummary = (
  account: TrackingAccount,
  now = Date.now()
): ClaudeResetSummary | "checking" | null => {
  const credits = peekClaudeResetCredits(account);
  if (!credits) return null;
  if (credits.observedAt < now - CLAUDE_OFFER_MAX_AGE_MS) return "checking";
  return summarizeClaudeResets(
    credits.status,
    claudeResetLimitUsage(account, credits, now),
    now
  );
};

export type ClaudeResetsView = Omit<ClaudeResetSummary, "unavailable"> & {
  unavailable: ClaudeResetSummary["unavailable"] | "checking";
};

// What the admin shows for an account's saved resets; null when unknown.
export const describeClaudeResets = (
  account: ProviderAccountRecord
): ClaudeResetsView | null => {
  if (!isTrackingAccount(account) || account.provider !== "claude") return null;
  const summary = claudeSummary(account);
  return summary === "checking"
    ? {
        saved: 0,
        nextEndsAt: null,
        clears: [],
        ineligibleReason: null,
        offer: null,
        unavailable: "checking",
      }
    : summary;
};

const UNCONFIRMED_REASONS = new Set([
  "stamp_indeterminate",
  "reset_unconfirmed",
]);

const isConfirmed = ({ result, reason }: ClaudeResetClaimResult): boolean =>
  result !== "unavailable" && !UNCONFIRMED_REASONS.has(reason ?? "");

export const claimClaudeReset = async (
  database: Database,
  providerAccountId: string,
  grantId: string
) => {
  const account = await loadAccount(database, providerAccountId, "claude");
  if (!account) return null;
  const organizationUuid =
    account.metadata?.provider === "claude"
      ? account.metadata.organizationUuid
      : null;
  if (!organizationUuid) {
    throw new ResetSpendConflict(
      "This account's Claude organization isn't known. Reconnect the account."
    );
  }
  const credits = peekClaudeResetCredits(account);
  const summary = claudeSummary(account);
  if (!credits || summary === "checking") throw conflict("stale");
  if (summary?.offer?.grantId !== grantId) throw conflict("not_current");
  const claim = await spendReset(
    database,
    account,
    grantId,
    credits.observedAt,
    (requestId) =>
      retryAfter401(database, account, (current) =>
        claimClaudeResetCredit({
          accessToken: current.accessToken,
          organizationUuid,
          grantId,
          requestId,
        })
      ),
    isConfirmed,
    ({ result }) => result === "not_limited"
  );
  if (claim.result === "reset" && isConfirmed(claim)) {
    scheduleConfirmingRead(database, account);
  }
  return claim;
};
