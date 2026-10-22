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
  const expiries = [];
  for (const credit of credits) {
    const at = quotaTimestamp(credit.expiresAt);
    const last = expiries.at(-1);
    if (last && last.at === at) last.count++;
    else expiries.push({ at, count: 1 });
  }
  const expiry = quotaTimestamp(next?.expiresAt);
  const windows = accountWindows(account).filter((window) => !window.named);
  const state = !count
    ? "unavailable"
    : account.codexResets?.unavailable === "requires_limit"
      ? "at_limit"
      : "now";
  return {
    count,
    next,
    unit: "credit",
    noun: "reset credit",
    heading: "Reset credit",
    action: "Use credit",
    state,
    canUse: state === "now" && Boolean(next),
    atLimitOnly: state === "at_limit",
    resetId: next?.id,
    scope:
      next?.resetType === "codex_rate_limits"
        ? windows.length
          ? `${windows.map((window) => window.label).join(" + ")} windows`
          : "Codex rate-limit windows"
        : null,
    expiresAt: expiry,
    expiries,
    expiryText: expiry
      ? `${count > 1 ? "next expires" : "expires"} ${untilText(expiry)}`
      : "expiry not reported",
    title: next?.title,
    status:
      state === "at_limit"
        ? {
            label: "usable once a limit is hit",
            description: "Codex only uses a credit once you hit a limit.",
          }
        : null,
    earlyUse: null,
    notes: [],
    useful:
      state === "now" &&
      !account.quota?.error &&
      !needsReauthorization(account) &&
      windows.some(
        (window) =>
          limitSeverity(window.percent) &&
          (!window.resetsAt || window.resetsAt > Date.now())
      ),
  };
}

const NO_CREDIT_SPENT = "No credit was spent.";

function codexResultToast(result) {
  switch (result?.code) {
    case "reset":
      return {
        message: "Limits reset \u00b7 1 credit used",
        type: "success",
        showBalance: true,
        changed: true,
      };
    case "nothing_to_reset":
      return {
        message: `Nothing to reset yet: Codex only uses a credit once you hit a limit. ${NO_CREDIT_SPENT}`,
        type: "info",
      };
    case "no_credit":
      return {
        message: `That credit is no longer available. ${NO_CREDIT_SPENT}`,
        type: "error",
      };
    case "already_redeemed":
      return {
        message:
          "This credit already reset your limits \u00b7 nothing more was used",
        type: "info",
        showBalance: true,
        changed: true,
      };
    default:
      return {
        message: `Codex answered \u201c${result?.code || "unknown"}\u201d \u00b7 the next limits check shows whether a credit was used`,
        type: "info",
      };
  }
}

const codexResets = {
  offerFor: codexResetOffer,
  resultToast: codexResultToast,
};

export { codexResets };
