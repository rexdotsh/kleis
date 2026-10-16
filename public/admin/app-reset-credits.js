import { claudeResets } from "./app-claude-resets.js";
import { codexResets } from "./app-codex-resets.js";
import { escapeHtml, mutationAttributes } from "./app-core.js";
import {
  DAY_MS,
  accountName,
  fact,
  kbd,
  providerLabel,
  untilText,
} from "./app-render-shared.js";

const resetProviders = { codex: codexResets, claude: claudeResets };

function resetOfferFor(account) {
  return resetProviders[account?.provider]?.offerFor(account) || null;
}

function windowHours(window) {
  const span = window.label.match(/(\d+)([dh])$/);
  return span ? Number(span[1]) * (span[2] === "d" ? 24 : 1) : 0;
}

function resetCreditsDetail(account, windows) {
  const offer = resetOfferFor(account);
  if (!offer || (!offer.canUse && !offer.status)) return null;
  const covered = windows.filter(
    (window) =>
      (account.provider !== "codex" || !window.named) &&
      offer.windowLabels.includes(window.label)
  );
  const window = covered.sort(
    (a, b) => b.percent - a.percent || windowHours(b) - windowHours(a)
  )[0];
  const expiring = offer.expiresAt && offer.expiresAt - Date.now() < 3 * DAY_MS;
  const noun = account.provider === "codex" ? "credit" : offer.noun;
  const balance = `${offer.count ?? "\u2014"} ${noun}${offer.count === 1 ? "" : "s"}`;
  const text = offer.retry
    ? "reset not confirmed"
    : offer.status
      ? offer.status.replaceCount
        ? offer.status.label
        : balance
      : !offer.scope
        ? `${balance} \u00b7 scope not reported`
        : `${balance}${account.provider === "codex" && !expiring ? " to refill" : ""}`;
  const title = [
    text,
    offer.status && !offer.status.replaceCount && offer.status.label,
    offer.scope ? `refills ${offer.scope}` : "reset scope not reported",
    offer.expiryText,
    offer.title,
    offer.status?.description,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
  const action = offer.canUse
    ? `<button class="link small" type="button" data-action="redeem-reset-credit" data-account-id="${account.id}" ${mutationAttributes("redeem-reset-credit", account.id)} aria-label="${escapeHtml(offer.retry ? "Retry reset" : `Use ${offer.noun}`)}">${offer.retry ? "Retry" : "Use"}${kbd("U")}</button>`
    : offer.status?.link
      ? `<a class="link small" href="${offer.settingsUrl}" target="_blank" rel="noopener" aria-label="${escapeHtml(`${providerLabel(account.provider)} settings: ${offer.status.label}`)}">${escapeHtml(offer.status.link)}</a>`
      : "";
  const line = `<span class="reset-line${offer.retry || offer.status?.warning ? " warn" : ""}" title="${escapeHtml(title)}"><span class="reset-copy">${escapeHtml(text)}</span>${expiring ? `<span class="reset-expiry">\u00b7 expires ${escapeHtml(untilText(offer.expiresAt))}</span>` : ""}${action ? `<span aria-hidden="true">\u00b7</span>${action}` : ""}</span>`;
  return {
    window,
    line,
    fallback: window
      ? ""
      : fact(`${offer.heading}${offer.count === 1 ? "" : "s"}`, line),
  };
}

function earlyUseText(earlyUse) {
  if (!earlyUse) return "";
  if (earlyUse.scope && typeof earlyUse.percentUsed === "number") {
    return `You still have ${100 - earlyUse.percentUsed}% of the ${earlyUse.scope} left. Using the reset now spends it early.`;
  }
  return "You haven't reached a limit it refills yet. Using the reset now spends it early.";
}

function resetConfirmation(account, offer = resetOfferFor(account)) {
  if (!offer) return null;
  const name = accountName(account);
  if (offer.retry)
    return {
      title: `Retry ${providerLabel(account.provider)} reset?`,
      message: `Check the pending reset for "${name}". Retrying the same request cannot spend a second credit.`,
      action: "Retry reset",
      extrasHtml: "",
      danger: false,
    };
  const remaining = typeof offer.count === "number" ? offer.count - 1 : null;
  const balance =
    remaining === null
      ? ""
      : `${remaining} ${offer.noun}${remaining === 1 ? "" : "s"} left after this`;
  const context = [
    [balance, offer.expiryText].filter(Boolean).join(" \u00b7 "),
    ...offer.notes,
  ].filter(Boolean);
  const warning = earlyUseText(offer.earlyUse);
  return {
    title: `Use ${offer.noun}?`,
    message: `Spend 1 ${offer.noun} on "${name}" to refill ${offer.scope ? `its ${offer.scope}` : "its usage limits"} now. ${offer.scope ? "" : `${providerLabel(account.provider)} has not reported which windows will reset. `}This cannot be undone.`,
    action: offer.action,
    danger: Boolean(warning),
    extrasHtml: `<div class="confirm-notes">${warning ? `<p class="warn">${escapeHtml(warning)}</p>` : ""}${context.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>`,
  };
}

function resetFeedback(feedback, offer, refreshedAccount) {
  const remaining =
    feedback.remaining ??
    (feedback.showBalance ? resetOfferFor(refreshedAccount)?.count : null);
  const balance =
    typeof remaining === "number"
      ? ` \u00b7 ${remaining} ${offer.unit}${remaining === 1 ? "" : "s"} left`
      : "";
  return { ...feedback, message: `${feedback.message}${balance}` };
}

export {
  resetProviders,
  resetOfferFor,
  resetCreditsDetail,
  resetConfirmation,
  resetFeedback,
};
