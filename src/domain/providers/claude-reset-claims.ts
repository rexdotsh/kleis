import type { Database } from "../../db";
import {
  type ClaudeResetClaimRow,
  type ClaudeResetClaimFenceRow,
  type ClaudeResetClaimIdentity,
  ClaudeResetReservationConflict,
  insertClaudeResetClaim,
  readClaudeResetClaimLedger,
  reopenClaudeResetClaim,
  settleClaudeResetClaim,
} from "../../db/repositories/claude-reset-claims";
import {
  findProviderAccountById,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import { claimClaudeResetCredit } from "../../providers/account-tracking/claude";
import {
  CLAUDE_RESET_PROGRAM,
  type ClaudeResetClaimReason,
  type ClaudeResetClaimResult,
  type ClaudeResetClaimResultCode,
  type ClaudeResetLimitType,
  type ClaudeResetOffer,
  type ClaudeResetUnavailableReason,
  summarizeClaudeResets,
} from "../../providers/account-tracking/claude-resets";
import { AccountTrackingHttpError } from "../../providers/account-tracking/http";
import { logInfo, logWarn } from "../../utils/log";
import {
  type ClaudeResetCredits,
  claudeOrganization,
  holdClaudeResetCredits,
  claudeResetIdentityBinding,
  peekClaudeResetCredits,
  refreshClaudeResetCredits,
  releaseClaudeResetCredits,
  replaceRejectedTrackingAccount,
  resolveTrackingAccount,
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
const UNCONFIRMED_REASONS = new Set<ClaudeResetClaimReason>([
  "stamp_indeterminate",
  "reset_unconfirmed",
]);

export const CLAUDE_RESET_CLAIM_LOOKBACK_MS = OFFER_MAX_AGE_MS;

export type ClaudeResetClaimConflictReason =
  | "organization_unknown"
  | "identity_unknown"
  | "identity_changed"
  | "claim_in_progress"
  | "claim_unconfirmed"
  | "stale"
  | "not_claimable"
  | "offer_changed";

export class ClaudeResetClaimConflict extends Error {
  readonly reason: ClaudeResetClaimConflictReason;

  constructor(reason: ClaudeResetClaimConflictReason, message: string) {
    super(message);
    this.name = "ClaudeResetClaimConflict";
    this.reason = reason;
  }
}

export type ClaudeResetClaimOutcome = {
  requestId: string;
  // completed: Anthropic gave a definite result. failed: it refused the
  // request, so nothing was used. ambiguous: the reset may have been used.
  status: "completed" | "failed" | "ambiguous";
  result: ClaudeResetClaimResultCode | null;
  reason: ClaudeResetClaimReason | null;
  resetsLeft: number | null;
  cleared: ClaudeResetLimitType[];
  weeklyResetsAt: string | null;
  httpStatus: number | null;
};

type OpenClaim = { row: ClaudeResetClaimRow; state: "pending" | "ambiguous" };

const bindOffer = (
  offer: ClaudeResetOffer,
  version: number,
  identity: ClaudeResetClaimIdentity
): ClaudeResetOffer => ({
  ...offer,
  key: Bun.CryptoHasher.hash(
    "sha256",
    JSON.stringify([
      offer.key,
      version,
      identity.accountIdentity,
      identity.organizationUuid,
    ]),
    "hex"
  ).slice(0, 32),
});

type ResetConfirmation = { grantId: string; offerKey: string };

const confirmedOffer = (
  credits: ClaudeResetCredits,
  version: number,
  identity: ClaudeResetClaimIdentity,
  confirmation: ResetConfirmation
): ClaudeResetOffer => {
  const { offer } = summarizeClaudeResets(credits.status, Date.now());
  if (!offer)
    throw new ClaudeResetClaimConflict(
      "not_claimable",
      "This account has no reset that can be used now"
    );
  const bound = bindOffer(offer, version, identity);
  if (
    bound.grantId !== confirmation.grantId ||
    bound.key !== confirmation.offerKey
  ) {
    throw new ClaudeResetClaimConflict(
      "offer_changed",
      "The reset on offer changed; review it again"
    );
  }
  return bound;
};

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

// Resets read for another OAuth identity, or before its latest
// claim settled (here or in another process), may show a used reset.
const isCurrent = (
  credits: ClaudeResetCredits,
  account: ProviderAccountRecord,
  claims: readonly ClaudeResetClaimRow[]
): boolean => {
  const organization = claudeOrganization(account);
  const latest = claims[0];
  return (
    "organizationUuid" in organization &&
    organization.accountUuid !== null &&
    credits.identity ===
      claudeResetIdentityBinding(
        organization.accountUuid,
        organization.organizationUuid
      ) &&
    (!latest || credits.observedAt >= latest.updatedAt)
  );
};

const claimsForIdentity = (
  claims: readonly ClaudeResetClaimRow[],
  account: ProviderAccountRecord
): ClaudeResetClaimRow[] => {
  const identity = claudeOrganization(account);
  if (!("organizationUuid" in identity) || !identity.accountUuid) return [];
  return claims
    .filter(
      (claim) =>
        claim.organizationUuid === identity.organizationUuid &&
        claim.accountIdentity === identity.accountUuid
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

export type ClaudeResetsView = {
  observedAt: number | null;
  saved: number;
  nextEndsAt: string | null;
  clears: ClaudeResetLimitType[];
  ineligibleReason: string | null;
  offer: ClaudeResetOffer | null;
  unavailable: ClaudeResetUnavailableReason | "checking" | null;
  claim: { status: "pending" | "ambiguous"; startedAt: number } | null;
};

const emptyView = (
  observedAt: number | null,
  unavailable: ClaudeResetsView["unavailable"],
  claim: ClaudeResetsView["claim"]
): ClaudeResetsView => ({
  observedAt,
  saved: 0,
  nextEndsAt: null,
  clears: [],
  ineligibleReason: null,
  offer: null,
  unavailable,
  claim,
});

// What the admin shows for an account's saved resets; null when there is
// nothing to show. `claims` are the account's recent and open claims.
export const describeClaudeResets = (
  account: ProviderAccountRecord,
  allClaims: readonly ClaudeResetClaimRow[],
  fences: readonly ClaudeResetClaimFenceRow[],
  now = Date.now()
): ClaudeResetsView | null => {
  if (account.provider !== "claude") {
    return null;
  }
  const credits = peekClaudeResetCredits(account);
  const claims = claimsForIdentity(allClaims, account);
  const open = findOpenClaim(claims, now);
  if (open && !isReconciled(open, credits)) {
    return emptyView(credits?.observedAt ?? null, null, {
      status: open.state,
      startedAt: open.row.createdAt,
    });
  }
  if (!credits) {
    return null;
  }
  if (!isCurrent(credits, account, claims)) {
    return emptyView(credits.observedAt, "checking", null);
  }
  const summary = summarizeClaudeResets(credits.status, now);
  const identity = claudeOrganization(account);
  if (!("organizationUuid" in identity) || !identity.accountUuid)
    return emptyView(credits.observedAt, "checking", null);
  const canonical = {
    accountIdentity: identity.accountUuid,
    organizationUuid: identity.organizationUuid,
  };
  const version =
    fences.find(
      (fence) =>
        fence.accountIdentity === identity.accountUuid &&
        fence.organizationUuid === identity.organizationUuid
    )?.version ?? 0;
  return {
    observedAt: credits.observedAt,
    ...summary,
    offer: summary.offer ? bindOffer(summary.offer, version, canonical) : null,
    claim: null,
  };
};

const failureDescription = (error: unknown): string => {
  if (error instanceof AccountTrackingHttpError) {
    return `HTTP ${error.status}`;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "Timed out";
  }
  return error instanceof Error && error.message.includes("malformed")
    ? "Unreadable response"
    : "Request failed";
};

const fromResult = (
  requestId: string,
  result: ClaudeResetClaimResult
): ClaudeResetClaimOutcome => ({
  requestId,
  status:
    result.result === "unavailable" ||
    (result.reason !== null && UNCONFIRMED_REASONS.has(result.reason))
      ? "ambiguous"
      : "completed",
  result: result.result,
  reason: result.reason,
  resetsLeft: result.resetsLeft,
  cleared: result.cleared,
  weeklyResetsAt: result.weeklyResetsAt,
  httpStatus: null,
});

const fromError = (
  requestId: string,
  error: unknown
): ClaudeResetClaimOutcome & { lastError: string } => {
  const httpStatus =
    error instanceof AccountTrackingHttpError ? error.status : null;
  return {
    requestId,
    status:
      httpStatus !== null && REJECTED_STATUSES.has(httpStatus)
        ? "failed"
        : "ambiguous",
    result: null,
    reason: null,
    resetsLeft: null,
    cleared: [],
    weeklyResetsAt: null,
    httpStatus,
    lastError: failureDescription(error),
  };
};

// Sends the claim once. A rejected token is refreshed and the same claim,
// with the same request ID, sent once more for the same organization.
const sendClaim = async (
  database: Database,
  account: ProviderAccountRecord,
  claim: ClaudeResetClaimIdentity & { grantId: string; requestId: string }
): Promise<ClaudeResetClaimOutcome & { lastError: string | null }> => {
  const send = async (current: ProviderAccountRecord) => ({
    ...fromResult(
      claim.requestId,
      await claimClaudeResetCredit({
        accessToken: current.accessToken,
        organizationUuid: claim.organizationUuid,
        grantId: claim.grantId,
        requestId: claim.requestId,
      })
    ),
    lastError: null,
  });
  try {
    return await send(account);
  } catch (error) {
    if (!(error instanceof AccountTrackingHttpError && error.status === 401)) {
      return fromError(claim.requestId, error);
    }
    const refreshed = await replaceRejectedTrackingAccount(
      database,
      account
    ).catch(() => null);
    const organization = refreshed && claudeOrganization(refreshed);
    if (
      !(
        refreshed &&
        organization &&
        "organizationUuid" in organization &&
        organization.organizationUuid === claim.organizationUuid &&
        organization.accountUuid === claim.accountIdentity
      )
    ) {
      return fromError(claim.requestId, error);
    }
    try {
      return await send(refreshed);
    } catch (retryError) {
      return fromError(claim.requestId, retryError);
    }
  }
};

const isUniqueViolation = (error: unknown): boolean => {
  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    if (current.message.includes("UNIQUE constraint failed")) {
      return true;
    }
  }
  return false;
};

// Records the claim, then reuses its request ID if an unconfirmed claim of
// the same reset is retried, so a claim that did go through can't spend a
// second reset.
const reserveClaim = async (
  database: Database,
  account: ProviderAccountRecord,
  input: {
    open: OpenClaim | null;
    identity: ClaudeResetClaimIdentity;
    version: number;
    offer: ClaudeResetOffer;
    now: number;
  }
): Promise<{ requestId: string; reused: boolean }> => {
  const { open, offer, now } = input;
  const reuse =
    open?.row.grantId === offer.grantId &&
    open.row.organizationUuid === input.identity.organizationUuid &&
    open.row.accountIdentity === input.identity.accountIdentity
      ? open.row
      : null;
  try {
    if (reuse) {
      await reopenClaudeResetClaim(
        database,
        {
          ...input.identity,
          requestId: reuse.requestId,
          updatedAt: reuse.updatedAt,
          offerKey: offer.key,
        },
        now,
        input.version
      );
      return { requestId: reuse.requestId, reused: true };
    }
    const requestId = crypto.randomUUID();
    await insertClaudeResetClaim(
      database,
      {
        requestId,
        providerAccountId: account.id,
        ...input.identity,
        program: CLAUDE_RESET_PROGRAM,
        grantId: offer.grantId,
        offerKey: offer.key,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      },
      open
        ? { requestId: open.row.requestId, updatedAt: open.row.updatedAt }
        : null,
      input.version
    );
    return { requestId, reused: false };
  } catch (error) {
    if (error instanceof ClaudeResetReservationConflict) {
      throw new ClaudeResetClaimConflict(
        "offer_changed",
        "Another reset claim changed this offer; review it again"
      );
    }
    if (isUniqueViolation(error)) {
      throw new ClaudeResetClaimConflict(
        "claim_in_progress",
        "A reset is already being claimed for this account"
      );
    }
    throw error;
  }
};

const settle = async (
  database: Database,
  account: ProviderAccountRecord,
  outcome: ClaudeResetClaimOutcome & { lastError: string | null }
): Promise<void> => {
  try {
    await settleClaudeResetClaim(database, outcome.requestId, {
      status: outcome.status,
      result: outcome.result,
      reason: outcome.reason,
      resetsLeft: outcome.resetsLeft,
      clearedJson: JSON.stringify(outcome.cleared),
      weeklyResetsAt: outcome.weeklyResetsAt,
      lastError: outcome.lastError,
      updatedAt: Date.now(),
    });
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
  input: ResetConfirmation
): Promise<ClaudeResetClaimOutcome | null> => {
  const stored = await findProviderAccountById(database, providerAccountId);
  if (stored?.provider !== "claude") {
    return null;
  }
  const organization = claudeOrganization(stored);
  if (!("organizationUuid" in organization)) {
    throw organization.problem === "mismatch"
      ? new ClaudeResetClaimConflict(
          "identity_changed",
          "This account's OAuth identity changed; reauthorize it first"
        )
      : new ClaudeResetClaimConflict(
          "organization_unknown",
          "This account's organization is unknown; reauthorize it first"
        );
  }
  if (!organization.accountUuid)
    throw new ClaudeResetClaimConflict(
      "identity_unknown",
      "This account's OAuth user identity is unknown; reauthorize it first"
    );
  const identity = {
    accountIdentity: organization.accountUuid,
    organizationUuid: organization.organizationUuid,
  };
  const now = Date.now();
  const ledger = await readClaudeResetClaimLedger(
    database,
    identity,
    now - CLAUDE_RESET_CLAIM_LOOKBACK_MS
  );
  const claims = ledger.claims;
  const open = findOpenClaim(claims, now);
  if (open?.state === "pending") {
    throw new ClaudeResetClaimConflict(
      "claim_in_progress",
      "A reset is already being claimed for this account"
    );
  }
  const isFresh = (value: ClaudeResetCredits | null) =>
    value !== null &&
    value.observedAt >= Date.now() - OFFER_MAX_AGE_MS &&
    value.observedAt <= Date.now() &&
    isCurrent(value, stored, claims);
  let credits = peekClaudeResetCredits(stored);
  // Only a read the admin could already see settles an unconfirmed claim.
  if (open && !isReconciled(open, credits)) {
    throw new ClaudeResetClaimConflict(
      "claim_unconfirmed",
      "An earlier reset claim couldn't be confirmed; check Claude settings"
    );
  }
  if (!isFresh(credits)) {
    credits = await refreshClaudeResetCredits(database, stored);
  }
  if (!(credits && isFresh(credits))) {
    throw new ClaudeResetClaimConflict(
      "stale",
      "Couldn't check this account's resets right now; try again shortly"
    );
  }
  confirmedOffer(credits, ledger.version, identity, input);

  const account = await resolveTrackingAccount(database, stored);
  if (!account) {
    throw new ClaudeResetClaimConflict(
      "stale",
      "Couldn't refresh this account's credentials; nothing was used"
    );
  }
  const resolvedIdentity = claudeOrganization(account);
  if (
    !("organizationUuid" in resolvedIdentity) ||
    resolvedIdentity.organizationUuid !== identity.organizationUuid ||
    resolvedIdentity.accountUuid !== identity.accountIdentity ||
    account.accountId !== stored.accountId
  ) {
    throw new ClaudeResetClaimConflict(
      "identity_changed",
      "This account's OAuth identity changed while refreshing; review it again"
    );
  }
  const currentCredits =
    account.accessToken !== stored.accessToken
      ? await refreshClaudeResetCredits(database, account)
      : peekClaudeResetCredits(account);
  if (!currentCredits || !isFresh(currentCredits))
    throw new ClaudeResetClaimConflict(
      "stale",
      "Couldn't recheck this account's resets; nothing was used"
    );
  const currentOffer = confirmedOffer(
    currentCredits,
    ledger.version,
    identity,
    input
  );
  const { requestId, reused } = await reserveClaim(database, account, {
    open,
    identity,
    version: ledger.version,
    offer: currentOffer,
    now: Date.now(),
  });
  holdClaudeResetCredits(account);
  const startedAt = Date.now();
  try {
    const outcome = await sendClaim(database, account, {
      ...identity,
      grantId: currentOffer.grantId,
      requestId,
    });
    await settle(database, account, outcome);
    (outcome.status === "completed" ? logInfo : logWarn)(
      "claude_reset_claim_settled",
      {
        providerAccountId: account.id,
        status: outcome.status,
        result: outcome.result,
        reason: outcome.reason,
        httpStatus: outcome.httpStatus,
        reusedRequestId: reused,
        durationMs: Date.now() - startedAt,
      }
    );
    const { lastError: _lastError, ...result } = outcome;
    return result;
  } finally {
    releaseClaudeResetCredits(database, account);
  }
};
