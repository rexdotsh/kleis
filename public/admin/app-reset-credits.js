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

const expiryFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const counted = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const timeLeft = (at) => {
  const hours = Math.floor((at - Date.now()) / 3_600_000);
  return hours ? `${hours}h` : untilText(at).replace(/^in /, "");
};

const knownExpiries = (offer) =>
  (offer?.expiries || []).filter((group) => group.at !== null);

// Resets about to expire. Only ones usable now ask for attention; the rest
// say a limit has to be hit first.
function expiringResets(account) {
  const offer = resetOfferFor(account);
  const soonest = knownExpiries(offer)[0];
  const left = soonest?.at - Date.now();
  if (
    !(offer?.state === "now" || offer?.state === "at_limit") ||
    !offer.count ||
    !(left > 0 && left < EXPIRING_SOON_MS) ||
    needsReauthorization(account)
  )
    return null;
  const time = timeLeft(soonest.at);
  if (offer.state === "now") {
    return {
      actionable: true,
      tag: `${counted(offer.count, offer.unit)} \u00b7 ${time} left`,
      text: `${counted(offer.count, offer.noun)}${offer.count === 1 ? "" : ", next"} expires in ${time}`,
    };
  }
  const text = `${counted(soonest.count, offer.unit)} expire${soonest.count === 1 ? "s" : ""} in ${time} \u00b7 usable once a limit is hit`;
  return { actionable: false, tag: text, text };
}

function expiriesText(offer) {
  const known = knownExpiries(offer);
  if (!known.length) return null;
  const total = known.reduce((sum, group) => sum + group.count, 0);
  const times = known.map(
    (group) =>
      `${untilText(group.at).replace(/^in /, "")}${group.count > 1 ? ` (${group.count})` : ""}`
  );
  return `${total === 1 ? "expires" : "expire"} in ${times.join(", ")}`;
}

function expiryDates(offer) {
  const known = knownExpiries(offer);
  return known.length
    ? `expire ${known.map((group) => `${expiryFormat.format(group.at)}${group.count > 1 ? ` (${group.count})` : ""}`).join(", ")}`
    : offer.expiryText;
}

// The account's resets on one line: the balance, what the owner can do with
// it now, and what it refills.
function resetCreditsDetail(account) {
  const offer = resetOfferFor(account);
  if (!offer || (!offer.canUse && !offer.status)) return "";
  const { status } = offer;
  const balance = `${offer.count ?? "\u2014"} ${offer.unit}${offer.count === 1 ? "" : "s"}`;
  const value = status?.replaceCount ? status.label : balance;
  const scope = offer.scope ? `refills ${offer.scope}` : "scope not reported";
  const title = [
    value,
    status && !status.replaceCount && status.label,
    scope,
    expiryDates(offer),
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
        expiriesText(offer),
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
