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
  type ClaudeResetSummary,
  summarizeClaudeResets,
} from "../../providers/account-tracking/claude-resets";
import { consumeCodexResetCredit } from "../../providers/account-tracking/codex";
import { AccountTrackingHttpError } from "../../providers/account-tracking/http";
import { errorLogFields, logWarn } from "../../utils/log";
import {
  claudeResetLimitUsage,
  invalidateClaudeResetCredits,
  isTrackingAccount,
  peekClaudeResetCredits,
  peekCodexResetCredits,
  reloadCodexQuota,
  resolveAccount,
  retryAfter401,
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

const notCurrent = () =>
  new ResetSpendConflict(
    "That reset is no longer available. Wait for the next sync and try again."
  );

// A 4xx other than 429 is answered before anything is spent.
const isRefusal = (error: unknown): boolean =>
  error instanceof AccountTrackingHttpError &&
  error.status >= 400 &&
  error.status < 500 &&
  error.status !== 429;

// Records the spend before sending it. An answer that `settles` rejects
// leaves the spend pending, like a timeout.
const spendReset = async <T>(
  database: Database,
  account: TrackingAccount,
  itemId: string,
  send: (requestId: string) => Promise<T>,
  settles: (result: T) => boolean
): Promise<T> => {
  const requestId = await startResetSpend(database, {
    provider: account.provider,
    providerAccountId: account.id,
    itemId,
  });
  if (!requestId) {
    throw new ResetSpendConflict(
      "A reset is already in progress for this account."
    );
  }
  const settle = (status: "completed" | "failed") =>
    settleResetSpend(database, requestId, status).catch((error: unknown) =>
      logWarn("reset_spend_record_failed", {
        providerAccountId: account.id,
        ...errorLogFields(error),
      })
    );
  let result: T;
  try {
    result = await send(requestId);
  } catch (error) {
    if (!isRefusal(error)) {
      throw new ResetSpendError(
        "Couldn't confirm the reset. Try again in a few minutes; a retry can't spend it twice."
      );
    }
    await settle("failed");
    throw new ResetSpendError(
      `${error instanceof Error ? error.message : "Reset refused"}. Nothing was used.`
    );
  }
  if (settles(result)) await settle("completed");
  return result;
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
  const listed = peekCodexResetCredits(account)?.credits ?? [];
  if (
    !listed.some(
      (credit) => credit.id === creditId && credit.status === "available"
    )
  ) {
    throw notCurrent();
  }
  try {
    return await spendReset(
      database,
      account,
      creditId,
      (redeemRequestId) =>
        retryAfter401(database, account, (current) =>
          consumeCodexResetCredit({
            accessToken: current.accessToken,
            accountId: current.accountId,
            redeemRequestId,
            creditId,
          })
        ),
      () => true
    );
  } finally {
    await reloadCodexQuota(database, account);
  }
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
  const summary = claudeSummary(account);
  if (summary === "checking" || summary?.offer?.grantId !== grantId) {
    throw notCurrent();
  }
  try {
    return await spendReset(
      database,
      account,
      grantId,
      (requestId) =>
        retryAfter401(database, account, (current) =>
          claimClaudeResetCredit({
            accessToken: current.accessToken,
            organizationUuid,
            grantId,
            requestId,
          })
        ),
      ({ result, reason }) =>
        result !== "unavailable" && !UNCONFIRMED_REASONS.has(reason ?? "")
    );
  } finally {
    invalidateClaudeResetCredits(account);
  }
};
