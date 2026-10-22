import { claudeResets } from "./app-claude-resets.js";
import { codexResets } from "./app-codex-resets.js";
import { escapeHtml, mutationAttributes } from "./app-core.js";
import {
  DAY_MS,
  accountName,
  kbd,
  needsReauthorization,
  providerLabel,
  untilText,
} from "./app-render-shared.js";

const resetProviders = { codex: codexResets, claude: claudeResets };
const EXPIRING_SOON_MS = 2 * DAY_MS;

function resetOfferFor(account) {
  return resetProviders[account?.provider]?.offerFor(account) || null;
}

function expiringResets(account) {
  const offer = resetOfferFor(account);
  const left = offer?.expiresAt - Date.now();
  if (
    !(offer?.canUse || offer?.atLimitOnly) ||
    !offer.count ||
    !(left > 0 && left < EXPIRING_SOON_MS) ||
    needsReauthorization(account)
  )
    return null;
  const hours = Math.floor(left / 3_600_000);
  const time = hours
    ? `${hours}h`
    : untilText(offer.expiresAt).replace(/^in /, "");
  const balance = `${offer.count} ${offer.noun}${offer.count === 1 ? "" : "s"}`;
  return {
    tag: `${balance} \u00b7 ${time} left`,
    text: `${balance}${offer.count === 1 ? "" : ", next"} expires in ${time}${offer.atLimitOnly ? ", usable at limit" : ""}`,
  };
}

// The account's resets on one line: the balance, what the owner can do with
// it now, and what it refills.
function resetCreditsDetail(account) {
  const offer = resetOfferFor(account);
  if (!offer || (!offer.canUse && !offer.status)) return "";
  const { status } = offer;
  const balance = `${offer.count ?? "\u2014"} ${offer.unit}${offer.count === 1 ? "" : "s"}`;
  const value = status?.replaceCount ? status.label : balance;
  const left =
    offer.expiresAt && offer.expiresAt - Date.now() < 3 * DAY_MS
      ? `${untilText(offer.expiresAt).replace(/^in /, "")} left`
      : null;
  const scope = offer.scope ? `refills ${offer.scope}` : "scope not reported";
  const title = [
    value,
    status && !status.replaceCount && status.label,
    scope,
    offer.expiryText,
    offer.title,
    status?.description,
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
  const action = offer.canUse
    ? `<button class="link small" type="button" data-action="redeem-reset-credit" data-account-id="${account.id}" ${mutationAttributes("redeem-reset-credit", account.id)} aria-label="${escapeHtml(`Use ${offer.noun}`)}">Use${kbd("U")}</button>`
    : status?.link
      ? `<a class="link small" href="${offer.settingsUrl}" target="_blank" rel="noopener" aria-label="${escapeHtml(`${providerLabel(account.provider)} settings: ${status.label}`)}">${escapeHtml(status.link)}</a>`
      : "";
  const details = status?.replaceCount
    ? [status.description]
    : [
        status?.label,
        offer.canUse && offer.earlyUse && "usable early",
        left,
        scope,
      ];
  return `<div class="resets" title="${escapeHtml(title)}"><span class="fact-label">${escapeHtml(`${offer.heading}s`)}</span><span class="resets-copy"><span class="resets-value">${escapeHtml(value)}</span>${details
    .filter(Boolean)
    .map((detail) => ` \u00b7 ${escapeHtml(detail)}`)
    .join(
      ""
    )}</span>${action ? `<span class="resets-action">${action}</span>` : ""}</div>`;
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
  expiringResets,
  resetCreditsDetail,
  resetConfirmation,
  resetFeedback,
};
