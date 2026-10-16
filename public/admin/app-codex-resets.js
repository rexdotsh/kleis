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
  const retry = state.pendingResetRedemptions.has(account.id);
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
  const next = credits[0] || null;
  const expiry = quotaTimestamp(next?.expiresAt);
  const windows = accountWindows(account).filter((window) => !window.named);
  const tightest = [...windows].sort((a, b) => b.percent - a.percent)[0];
  return {
    count,
    next,
    unit: "credit",
    noun: "reset credit",
    heading: "Reset credit",
    action: "Use credit",
    canUse: Boolean(count || retry),
    retry,
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
    earlyUse:
      tightest && tightest.percent < 100
        ? {
            scope: `${tightest.label} window`,
            percentUsed: Math.round(tightest.percent),
          }
        : null,
    notes: [],
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
    const pending = state.pendingResetRedemptions.get(account.id);
    const creditId = pending ? pending.creditId : offer.next?.id;
    return {
      body: {
        redeemRequestId: pending?.redeemRequestId || createResetRequestId(),
        ...(creditId ? { creditId } : {}),
      },
      retry: Boolean(pending),
    };
  },
  settle(account, attempt, response, error) {
    if (!error) {
      state.pendingResetRedemptions.delete(account.id);
      return { ...codexResultToast(response.result), refresh: true };
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
      retryAllowed: () =>
        state.pendingResetRedemptions.get(account.id) === retry,
    };
  },
};

export { codexResets, codexResetOffer, createResetRequestId };
