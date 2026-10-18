import {
  accountWindows,
  limitSeverity,
  needsReauthorization,
  quotaTimestamp,
  untilText,
} from "./app-render-shared.js";

function codexResetOffer(account) {
  if (account?.provider !== "codex") return null;
  const data = account.quota?.data;
  if (
    !data?.resetCredits &&
    typeof data?.status?.resetCreditsAvailable !== "number"
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
    canUse: Boolean(count && next),
    resetId: next?.id,
    scope:
      next?.resetType === "codex_rate_limits"
        ? windows.length
          ? `${windows.map((window) => window.label).join(" + ")} windows`
          : "Codex rate-limit windows"
        : null,
    windowLabels:
      next?.resetType === "codex_rate_limits"
        ? windows.map((window) => window.label)
        : [],
    expiresAt: expiry,
    expiryText: expiry
      ? `${count > 1 ? "next expires" : "expires"} ${untilText(expiry)}`
      : "expiry not reported",
    title: next?.title,
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
  resultToast: codexResultToast,
};

export { codexResets };
