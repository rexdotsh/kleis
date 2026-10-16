import { claudeResets, claudeResetsFact } from "./app-claude-resets.js";
import { codexResets } from "./app-codex-resets.js";
import { escapeHtml, mutationAttributes } from "./app-core.js";
import { accountName, fact, kbd, providerLabel } from "./app-render-shared.js";

const resetProviders = { codex: codexResets, claude: claudeResets };

function resetOfferFor(account) {
  return resetProviders[account?.provider]?.offerFor(account) || null;
}

function resetCreditsFact(account) {
  const offer = resetOfferFor(account);
  if (!offer?.canUse) return claudeResetsFact(account);
  const use = `<button class="link small" type="button" data-action="redeem-reset-credit" data-account-id="${account.id}" ${mutationAttributes("redeem-reset-credit", account.id)} title="${escapeHtml(offer.title || offer.noun)}">${offer.retry ? "Retry reset" : offer.action}${kbd("U")}</button>`;
  return fact(
    `${offer.heading}${offer.count === 1 ? "" : "s"}`,
    `${offer.count ?? "\u2014"}${use}`,
    [
      escapeHtml(
        offer.scope ? `refills ${offer.scope}` : "Reset scope not reported"
      ),
      escapeHtml(offer.expiryText),
      offer.retry && '<span class="warn">reset not confirmed</span>',
    ]
  );
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
  resetCreditsFact,
  resetConfirmation,
  resetFeedback,
};
