import type { Database } from "../../db";
import {
  type ClaudeResetClaimFenceRow,
  type ClaudeResetClaimIdentity,
  type ClaudeResetClaimRow,
  ClaudeResetReservationConflict,
  listProviderAccountsWithClaudeResetClaims,
  readClaudeResetClaimLedger,
  reserveClaudeResetClaim,
  settleClaudeResetClaim,
} from "../../db/repositories/claude-reset-claims";
import {
  findProviderAccountById,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import { claimClaudeResetCredit } from "../../providers/account-tracking/claude";
import {
  type ClaudeResetClaimResult,
  type ClaudeResetClaimResultCode,
  type ClaudeResetLimitType,
  type ClaudeResetSummary,
  summarizeClaudeResets,
} from "../../providers/account-tracking/claude-resets";
import { AccountTrackingHttpError } from "../../providers/account-tracking/http";
import { logInfo, logWarn } from "../../utils/log";
import {
  type ClaudeResetCredits,
  claudeResetIdentity,
  claudeResetLimitUsage,
  isTrackingAccount,
  peekClaudeResetCredits,
  refreshClaudeResetCredits,
  reloadClaudeResetCredits,
  resolveAccount,
  retryAfter401,
  type TrackingAccount,
} from "./provider-account-tracking";

// A confirmation is only acted on against resets read this recently.
const OFFER_MAX_AGE_MS = 10 * 60_000;
// An unconfirmed claim blocks the account until a read made at least this
// long after it shows where its reset stands.
const RECONCILE_AFTER_MS = 2 * 60_000;
// Past this, a pending claim's process died mid-request: it may have sent.
const PENDING_ORPHANED_MS = 2 * 60_000;
// Anthropic answers these before acting on a claim, so nothing was used.
const REJECTED_STATUSES = new Set([400, 401, 403, 404, 422, 429]);
const UNCONFIRMED_REASONS = new Set([
  "stamp_indeterminate",
  "reset_unconfirmed",
]);

const conflictMessages = {
  identity_unverified:
    "This credential's Claude identity isn't verified; reconnect the account or wait for profile sync",
  identity_changed: "This account's OAuth identity changed; review it again",
  claim_in_progress: "A reset is already being claimed for this account",
  claim_unconfirmed:
    "An earlier reset claim couldn't be confirmed; check Claude settings",
  stale: "Couldn't check this account's resets right now; nothing was used",
  not_claimable: "This account has no reset that can be used now",
  offer_changed: "The reset on offer changed; review it again",
} as const;

export class ClaudeResetClaimConflict extends Error {
  constructor(readonly reason: keyof typeof conflictMessages) {
    super(conflictMessages[reason]);
    this.name = "ClaudeResetClaimConflict";
  }
}

export type ClaudeResetClaimOutcome = {
  requestId: string;
  // completed: Anthropic gave a definite result. failed: it refused the
  // request, so nothing was used. ambiguous: the reset may have been used.
  status: "completed" | "failed" | "ambiguous";
  result: ClaudeResetClaimResultCode | null;
  resetsLeft: number | null;
  cleared: ClaudeResetLimitType[];
  httpStatus: number | null;
};

type OpenClaim = { row: ClaudeResetClaimRow; state: "pending" | "ambiguous" };

const findOpenClaim = (
  claims: readonly ClaudeResetClaimRow[],
  now: number
): OpenClaim | null => {
  const row = claims.find(
    (claim) => claim.status === "pending" || claim.status === "ambiguous"
  );
  if (!row) {
    return null;
  }
  const orphaned =
    row.status === "pending" && row.updatedAt < now - PENDING_ORPHANED_MS;
  return {
    row,
    state: row.status === "ambiguous" || orphaned ? "ambiguous" : "pending",
  };
};

const isReconciled = (
  claim: OpenClaim,
  credits: ClaudeResetCredits | null
): boolean =>
  claim.state === "ambiguous" &&
  credits !== null &&
  credits.observedAt >= claim.row.updatedAt + RECONCILE_AFTER_MS;

// Resets read before the identity's latest claim settled, here or in another
// process, may still show the reset it used. `claims` are newest first.
const isCurrent = (
  credits: ClaudeResetCredits,
  claims: readonly ClaudeResetClaimRow[]
): boolean => !claims[0] || credits.observedAt >= claims[0].updatedAt;

const isSameIdentity = (
  a: ClaudeResetClaimIdentity | null,
  b: ClaudeResetClaimIdentity
): boolean =>
  a?.accountIdentity === b.accountIdentity &&
  a.organizationUuid === b.organizationUuid;

// The identity's fence version is part of the offer key, so any reservation
// for that OAuth identity invalidates earlier confirmations.
const summarize = (
  account: TrackingAccount,
  credits: ClaudeResetCredits,
  version: number,
  identity: ClaudeResetClaimIdentity,
  now: number
): ClaudeResetSummary =>
  summarizeClaudeResets(
    credits.status,
    claudeResetLimitUsage(account, credits, now),
    [version, identity.accountIdentity, identity.organizationUuid],
    now
  );

export type ClaudeResetsView = Omit<ClaudeResetSummary, "unavailable"> & {
  unavailable:
    | ClaudeResetSummary["unavailable"]
    | "checking"
    | "identity_unverified";
  claim: { status: OpenClaim["state"]; startedAt: number } | null;
};

const emptyView = (
  unavailable: ClaudeResetsView["unavailable"],
  claim: ClaudeResetsView["claim"] = null
): ClaudeResetsView => ({
  saved: 0,
  nextEndsAt: null,
  clears: [],
  ineligibleReason: null,
  offer: null,
  unavailable,
  claim,
});

// What the admin shows for an account's saved resets; null when there is
// nothing to show. `claims` are the recent and open claims, newest first.
const describeClaudeResets = (
  account: ProviderAccountRecord,
  claims: readonly ClaudeResetClaimRow[],
  fences: readonly ClaudeResetClaimFenceRow[],
  now = Date.now()
): ClaudeResetsView | null => {
  if (!isTrackingAccount(account) || account.provider !== "claude") {
    return null;
  }
  const credits = peekClaudeResetCredits(account);
  const identity = claudeResetIdentity(account);
  if (!identity) {
    return credits && emptyView("identity_unverified");
  }
  const own = claims.filter((claim) => isSameIdentity(claim, identity));
  const open = findOpenClaim(own, now);
  if (open && !isReconciled(open, credits)) {
    return emptyView(null, {
      status: open.state,
      startedAt: open.row.createdAt,
    });
  }
  if (!credits) {
    return null;
  }
  if (!isCurrent(credits, own)) {
    return emptyView("checking");
  }
  const version =
    fences.find((fence) => isSameIdentity(fence, identity))?.version ?? 0;
  return {
    ...summarize(account, credits, version, identity, now),
    claim: null,
  };
};

// Lists accounts with a describer for their saved resets. Describe after
// reading quotas, so the view reflects them.
export const listAccountsWithClaudeResets = async (database: Database) => {
  const { accounts, claims, fences } =
    await listProviderAccountsWithClaudeResetClaims(
      database,
      Date.now() - OFFER_MAX_AGE_MS
    );
  return {
    accounts,
    describe: (account: ProviderAccountRecord) =>
      describeClaudeResets(account, claims, fences),
  };
};

const fromResult = (
  requestId: string,
  { result, reason, resetsLeft, cleared }: ClaudeResetClaimResult
): ClaudeResetClaimOutcome => ({
  requestId,
  status:
    result === "unavailable" || UNCONFIRMED_REASONS.has(reason ?? "")
      ? "ambiguous"
      : "completed",
  result,
  resetsLeft,
  cleared,
  httpStatus: null,
});

const fromError = (
  requestId: string,
  error: unknown
): ClaudeResetClaimOutcome => {
  const httpStatus =
    error instanceof AccountTrackingHttpError ? error.status : null;
  return {
    requestId,
    status:
      httpStatus !== null && REJECTED_STATUSES.has(httpStatus)
        ? "failed"
        : "ambiguous",
    result: null,
    resetsLeft: null,
    cleared: [],
    httpStatus,
  };
};

const settle = async (
  database: Database,
  account: TrackingAccount,
  requestId: string,
  status: ClaudeResetClaimOutcome["status"]
): Promise<void> => {
  try {
    await settleClaudeResetClaim(database, requestId, status);
  } catch (error) {
    // The claim stays pending and is treated as unconfirmed once orphaned.
    logWarn("claude_reset_claim_record_failed", {
      providerAccountId: account.id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
};

// Uses the saved reset the admin confirmed. Never retried with a new request
// ID; an unconfirmed outcome blocks further claims until a later read shows
// where the reset stands.
export const claimClaudeReset = async (
  database: Database,
  providerAccountId: string,
  confirmation: { grantId: string; offerKey: string }
): Promise<ClaudeResetClaimOutcome | null> => {
  const stored = await findProviderAccountById(database, providerAccountId);
  if (!stored || !isTrackingAccount(stored) || stored.provider !== "claude") {
    return null;
  }
  const identity = claudeResetIdentity(stored);
  if (!identity) {
    throw new ClaudeResetClaimConflict("identity_unverified");
  }
  const { version, claims } = await readClaudeResetClaimLedger(
    database,
    identity,
    Date.now() - OFFER_MAX_AGE_MS
  );
  const open = findOpenClaim(claims, Date.now());
  if (open?.state === "pending") {
    throw new ClaudeResetClaimConflict("claim_in_progress");
  }
  // Only a read the admin could already see settles an unconfirmed claim.
  if (open && !isReconciled(open, peekClaudeResetCredits(stored))) {
    throw new ClaudeResetClaimConflict("claim_unconfirmed");
  }
  const account = await resolveAccount(database, stored);
  const isFresh = (
    credits: ClaudeResetCredits | null
  ): credits is ClaudeResetCredits =>
    credits !== null &&
    credits.observedAt >= Date.now() - OFFER_MAX_AGE_MS &&
    credits.observedAt <= Date.now() &&
    isCurrent(credits, claims);
  let credits = account && peekClaudeResetCredits(account);
  if (account && !isFresh(credits)) {
    credits = await refreshClaudeResetCredits(database, account);
  }
  if (!(account && isFresh(credits))) {
    throw new ClaudeResetClaimConflict("stale");
  }
  // Runs before reserving and again right before each send, including after
  // a token refresh: the identity, offer and current limits must still match.
  const check = (
    current: TrackingAccount,
    latest: ClaudeResetCredits | null
  ) => {
    if (
      current.accountId !== stored.accountId ||
      !isSameIdentity(claudeResetIdentity(current), identity)
    ) {
      throw new ClaudeResetClaimConflict("identity_changed");
    }
    if (!isFresh(latest)) {
      throw new ClaudeResetClaimConflict("stale");
    }
    const { offer } = summarize(current, latest, version, identity, Date.now());
    if (!offer) {
      throw new ClaudeResetClaimConflict("not_claimable");
    }
    if (
      offer.grantId !== confirmation.grantId ||
      offer.key !== confirmation.offerKey
    ) {
      throw new ClaudeResetClaimConflict("offer_changed");
    }
  };
  check(account, credits);

  // Retrying an unconfirmed claim of the same reset reuses its request ID, so
  // a claim that did go through can't spend a second reset.
  const reused = open?.row.grantId === confirmation.grantId;
  const requestId = open && reused ? open.row.requestId : crypto.randomUUID();
  const now = Date.now();
  try {
    await reserveClaudeResetClaim(
      database,
      {
        requestId,
        ...identity,
        grantId: confirmation.grantId,
        createdAt: now,
        updatedAt: now,
      },
      version,
      open?.row ?? null
    );
  } catch (error) {
    if (error instanceof ClaudeResetReservationConflict) {
      throw new ClaudeResetClaimConflict("offer_changed");
    }
    throw error;
  }

  const latest = peekClaudeResetCredits(account);
  let outcome: ClaudeResetClaimOutcome;
  try {
    outcome = fromResult(
      requestId,
      await retryAfter401(database, account, async (current) => {
        check(current, latest);
        return claimClaudeResetCredit({
          accessToken: current.accessToken,
          organizationUuid: identity.organizationUuid,
          grantId: confirmation.grantId,
          requestId,
        });
      })
    );
  } catch (error) {
    if (error instanceof ClaudeResetClaimConflict) {
      await settle(
        database,
        account,
        requestId,
        reused ? "ambiguous" : "failed"
      );
      reloadClaudeResetCredits(database, account);
      throw error;
    }
    outcome = fromError(requestId, error);
  }
  await settle(database, account, requestId, outcome.status);
  reloadClaudeResetCredits(database, account);
  (outcome.status === "completed" ? logInfo : logWarn)(
    "claude_reset_claim_settled",
    {
      providerAccountId: account.id,
      status: outcome.status,
      result: outcome.result,
      httpStatus: outcome.httpStatus,
      reusedRequestId: reused,
      durationMs: Date.now() - now,
    }
  );
  return outcome;
};
