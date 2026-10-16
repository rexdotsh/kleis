import { escapeHtml, mutationAttributes, state } from "./app-core.js";
import {
  accountWindows,
  fact,
  kbd,
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

function resetCreditsFor(account) {
  const data = account?.quota?.data;
  if (data?.provider !== "codex") return null;
  if (
    !data.resetCredits &&
    typeof data.status?.resetCreditsAvailable !== "number"
  )
    return null;
  const listed = data.resetCredits?.credits || [];
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
    data.resetCredits?.availableCount ?? data.status?.resetCreditsAvailable;
  const count = listed.length
    ? credits.length
    : Math.max(0, typeof available === "number" ? available : 0);
  const next = credits[0] || null;
  const expiry = quotaTimestamp(next?.expiresAt);
  const expiryText = next
    ? expiry
      ? `${count > 1 ? "next expires" : "expires"} ${untilText(expiry)}`
      : "no expiry reported"
    : "expiry not reported";
  const windows = accountWindows(account).filter((window) => !window.named);
  const scope =
    next?.resetType === "codex_rate_limits"
      ? windows.length
        ? `${windows.map((window) => window.label).join(" + ")} windows`
        : "Codex rate-limit windows"
      : null;
  const useful =
    count > 0 &&
    !account.quota.error &&
    !needsReauthorization(account) &&
    windows.some(
      (window) =>
        limitSeverity(window.percent) &&
        (!window.resetsAt || window.resetsAt > Date.now())
    );
  return { count, next, expiryText, scope, useful };
}

function resetCreditsFact(account) {
  const credits = resetCreditsFor(account);
  const pending = state.pendingResetRedemptions.has(account.id);
  if (!credits?.count && !pending) return "";
  const use = `<button class="link small" type="button" data-action="redeem-reset-credit" data-account-id="${account.id}" ${mutationAttributes("redeem-reset-credit", account.id)}>${pending ? "Retry reset" : "Use credit"}${kbd("U")}</button>`;
  return fact(
    credits?.count === 1 ? "Reset credit" : "Reset credits",
    `${credits?.count ?? "\u2014"}${use}`,
    [
      escapeHtml(credits?.scope || "Reset scope not reported"),
      escapeHtml(credits?.expiryText),
      pending && '<span class="warn">reset not confirmed</span>',
    ]
  );
}

function resetCreditConfirmation(account, retry) {
  const credits = resetCreditsFor(account);
  const label = account.label || account.accountId || account.id;
  if (retry) {
    return {
      title: "Retry Codex reset?",
      message: `Check the pending reset for "${label}". Retrying the same request cannot spend a second credit.`,
      action: "Retry reset",
      extrasHtml: "",
    };
  }
  const scope = credits?.scope;
  const description = credits?.next?.description;
  const context = [
    credits?.next?.title,
    description,
    credits?.expiryText,
  ].filter(Boolean);
  return {
    title: "Use reset credit?",
    message: `Spend 1 reset credit on "${label}" to reset ${scope ? `its ${scope}` : "its Codex usage limits"} now. ${scope ? "" : "Codex has not reported which windows will reset. "}This cannot be undone.`,
    action: "Use credit",
    extrasHtml: `<p class="popover-text">${context.map(escapeHtml).join("<br>")}</p>`,
  };
}

export {
  createResetRequestId,
  resetCreditsFor,
  resetCreditsFact,
  resetCreditConfirmation,
};
