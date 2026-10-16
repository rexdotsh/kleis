import { state } from "./app-core.js";
import {
  accountWindows,
  limitSeverity,
  needsReauthorization,
  quotaTimestamp,
  untilText,
} from "./app-render-shared.js";

function createResetRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // randomUUID requires HTTPS; getRandomValues also supports self-hosted HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] % 16) + 64;
  bytes[8] = (bytes[8] % 64) + 128;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function codexResetOffer(account) {
  if (account?.provider !== "codex") return null;
  const data = account.quota?.data;
  const action = data?.resetCreditAction;
  const confirmation = action?.kind === "offer" ? action : action?.recovery;
  const retry =
    action?.kind === "pending" || state.pendingResetRedemptions.has(account.id);
  const fresh =
    confirmation &&
    confirmation.observedAt <= Date.now() &&
    confirmation.observedAt >= Date.now() - 10 * 60_000 &&
    (confirmation.mode !== "spend" ||
      confirmation.expiresAt === null ||
      confirmation.expiresAt > Date.now());
  if (!fresh && !retry) return null;
  if (
    !data?.resetCredits &&
    typeof data?.status?.resetCreditsAvailable !== "number" &&
    !retry
  )
    return null;
  const listed = data?.resetCredits?.credits || [];
  const credits = listed
    .filter((credit) => {
      const expiry = quotaTimestamp(credit.expiresAt);
      return (
        credit.status === "available" &&
        (expiry === null || expiry > Date.now())
      );
    })
    .sort(
      (a, b) =>
        (quotaTimestamp(a.expiresAt) ?? Number.POSITIVE_INFINITY) -
        (quotaTimestamp(b.expiresAt) ?? Number.POSITIVE_INFINITY)
    );
  const available =
    data?.resetCredits?.availableCount ?? data?.status?.resetCreditsAvailable;
  const count = listed.length
    ? credits.length
    : typeof available === "number"
      ? Math.max(0, available)
      : null;
  const next = credits.find((credit) => credit.id === action?.creditId) || null;
  const expiry = quotaTimestamp(next?.expiresAt);
  const windows = accountWindows(account).filter((window) => !window.named);
  return {
    key: fresh ? confirmation.offerKey : null,
    count,
    next,
    unit: "credit",
    noun: "reset credit",
    heading: "Reset credit",
    action:
      confirmation?.mode === "review"
        ? "Mark reviewed"
        : retry && confirmation?.mode === "spend"
          ? "Retry original credit"
          : "Use credit",
    canUse: Boolean((fresh && next && count) || retry),
    retry,
    requiresConfirmation: retry && fresh && confirmation.mode === "spend",
    review: retry && fresh && confirmation.mode === "review",
    scope:
      next?.resetType === "codex_rate_limits"
        ? windows.length
          ? `${windows.map((window) => window.label).join(" + ")} windows`
          : "Codex rate-limit windows"
        : null,
    expiryText: expiry
      ? `${count > 1 ? "next expires" : "expires"} ${untilText(expiry)}`
      : "expiry not reported",
    title: next?.title,
    description: next?.description,
    earlyUse: fresh ? confirmation.earlyUse : null,
    notes: retry
      ? [
          confirmation?.mode === "review"
            ? "Verify this is the original login and check its reset status in Codex settings. Marking reviewed closes the old record without sending a reset request or spending a credit."
            : "Reuses the original request and credit. A new request ID will not be created.",
        ]
      : [],
    useful:
      count > 0 &&
      !account.quota?.error &&
      !needsReauthorization(account) &&
      windows.some(
        (window) =>
          limitSeverity(window.percent) &&
          (!window.resetsAt || window.resetsAt > Date.now())
      ),
  };
}

function codexResultToast(result) {
  const windows =
    typeof result?.windowsReset === "number" && result.windowsReset > 0
      ? ` (${result.windowsReset} window${result.windowsReset === 1 ? "" : "s"} reset)`
      : "";
  switch (result?.code) {
    case "reset":
      return {
        message: `Limits restored${windows}`,
        type: "success",
        showBalance: true,
      };
    case "nothing_to_reset":
      return {
        message: "Nothing to reset - limits are already clear",
        type: "info",
      };
    case "no_credit":
      return {
        message: "No reset credit available on this account",
        type: "error",
      };
    case "already_redeemed":
      return { message: `Credit was already redeemed${windows}`, type: "info" };
    case "reconciled":
      return {
        message: "Reset marked reviewed; no credit was spent",
        type: "info",
      };
    default:
      return {
        message: `Codex reset result: ${result?.code || "complete"}`,
        type: "info",
      };
  }
}

const codexResets = {
  offerFor: codexResetOffer,
  attemptFor(account, offer) {
    const action = account.quota?.data?.resetCreditAction;
    const pending =
      action?.kind === "pending"
        ? action
        : state.pendingResetRedemptions.get(account.id);
    return {
      body: pending
        ? {
            redeemRequestId: pending.redeemRequestId,
            ...((offer.requiresConfirmation || offer.review) && {
              offerKey: offer.key,
            }),
          }
        : {
            redeemRequestId: createResetRequestId(),
            creditId: offer.next.id,
            offerKey: offer.key,
          },
      retry: Boolean(pending),
    };
  },
  settle(account, attempt, response, error) {
    if (!error) {
      state.pendingResetRedemptions.delete(account.id);
      return { ...codexResultToast(response.result), refresh: true };
    }
    if (error.body?.retryable === false) {
      state.pendingResetRedemptions.delete(account.id);
      return { message: error.message, type: "error", refresh: true };
    }
    if (
      !(
        error.body?.redeemRequestId ||
        !error.status ||
        error.status >= 500 ||
        attempt.retry
      )
    )
      return { message: error.message, type: "error" };
    const retry = {
      creditId: attempt.body.creditId,
      redeemRequestId:
        error.body?.redeemRequestId || attempt.body.redeemRequestId,
    };
    state.pendingResetRedemptions.set(account.id, retry);
    return {
      message: `${error.message} Reset not confirmed; retry safely with the same request.`,
      type: "error",
      refresh: true,
      retryAllowed: () =>
        state.pendingResetRedemptions.get(account.id) === retry,
    };
  },
};

export { codexResets, codexResetOffer, createResetRequestId };
