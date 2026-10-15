import { escapeHtml, mutationAttributes } from "./app-core.js";
import {
  fact,
  quotaTimestamp,
  relativeTime,
  shortDate,
} from "./app-render-shared.js";

const CLAUDE_USAGE_SETTINGS_URL = "https://claude.ai/settings/usage";

const LIMIT_NAMES = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_overage_included: "7d",
  seven_day_opus: "Opus 7d",
  seven_day_sonnet: "Sonnet 7d",
};

const weekdayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

const settingsLink = (label = "Claude settings") =>
  `<a class="link small" href="${CLAUDE_USAGE_SETTINGS_URL}" target="_blank" rel="noopener">${label}</a>`;

function limitsText(types) {
  const names = [...new Set(types.map((type) => LIMIT_NAMES[type]))].filter(
    Boolean
  );
  if (!names.length) return "limits";
  const last = names.pop();
  return names.length
    ? `${names.join(", ")} and ${last} limits`
    : `${last} limit`;
}

function expiryText(endsAt) {
  const expiry = quotaTimestamp(endsAt);
  return expiry ? `use by ${shortDate(expiry)}` : "";
}

const UNAVAILABLE_TEXT = {
  requires_limit: "saved for when you hit a limit",
  paused: "paused",
  cooldown: "another reset was just used \u00b7 try later",
  not_usable: "can't be used right now",
  checking: "checking again",
};

// Claude's saved limit resets ("Reset for free" in Claude settings).
function claudeResetsFact(account) {
  const resets = account.claudeResets;
  if (account.provider !== "claude" || !resets) return "";
  if (resets.claim?.status === "pending") {
    return fact("Limit reset", '<span class="muted">Claiming\u2026</span>', [
      `started ${escapeHtml(relativeTime(resets.claim.startedAt))}`,
    ]);
  }
  if (resets.claim?.status === "ambiguous") {
    return fact("Limit reset", '<span class="warn">May have been used</span>', [
      "claim not confirmed",
      settingsLink("Check Claude settings"),
      "Kleis checks again shortly",
    ]);
  }
  if (resets.ineligibleReason === "surface") {
    return fact("Limit resets", '<span class="muted">claude.ai only</span>', [
      "can't be used through Kleis",
      settingsLink(),
    ]);
  }
  if (!resets.saved) return "";
  const offer = resets.offer;
  const use = offer
    ? `<button class="link small" type="button" data-action="claim-claude-reset" data-account-id="${account.id}" ${mutationAttributes("claim-claude-reset", account.id)} title="${escapeHtml(offer.label || "Saved limit reset")}">Use one</button>`
    : "";
  const reason = UNAVAILABLE_TEXT[resets.unavailable];
  return fact(
    resets.saved === 1 ? "Limit reset" : "Limit resets",
    `${resets.saved}${use}`,
    [
      escapeHtml(`refills ${limitsText(offer?.clears || resets.clears)}`),
      escapeHtml(expiryText(offer?.endsAt ?? resets.nextEndsAt)),
      reason && escapeHtml(reason),
      reason && settingsLink(),
    ]
  );
}

function earlyUseText(earlyUse) {
  if (!earlyUse) return "";
  if (earlyUse.limit && typeof earlyUse.percentUsed === "number") {
    return `You still have ${100 - earlyUse.percentUsed}% of the ${LIMIT_NAMES[earlyUse.limit] || "covered"} limit left. Using the reset now spends it early.`;
  }
  return "You haven't reached a limit it refills yet. Using the reset now spends it early.";
}

function confirmNotesHtml(resets) {
  const offer = resets.offer;
  const weekly = quotaTimestamp(offer.weeklyResetsAt);
  const left = resets.saved - 1;
  const notes = [
    earlyUseText(offer.earlyUse) &&
      `<p class="warn">${escapeHtml(earlyUseText(offer.earlyUse))}</p>`,
    `<p>${escapeHtml(
      [
        `${left} saved reset${left === 1 ? "" : "s"} left after this`,
        expiryText(offer.endsAt),
      ]
        .filter(Boolean)
        .join(" \u00b7 ")
    )}</p>`,
    weekly &&
      `<p>Your weekly reset day stays ${escapeHtml(weekdayFormat.format(weekly))}.</p>`,
    "<p>Can't be undone, and applies to this Claude account everywhere: claude.ai, Claude Code and every Kleis key.</p>",
  ];
  return `<div class="confirm-notes">${notes.filter(Boolean).join("")}</div>`;
}

const CLAIM_RESULT_TOASTS = {
  reset: ["Limits reset", "success"],
  already_used: [
    "That reset was already used \u00b7 nothing changed now",
    "info",
  ],
  not_limited: ["Nothing was used \u00b7 no limit needed a reset", "info"],
  cooldown: ["Another reset was just used \u00b7 nothing was used now", "info"],
  ineligible: [
    "This reset isn't available any more \u00b7 nothing was used",
    "info",
  ],
};

function claimToast(claim) {
  if (claim.status === "ambiguous") {
    return [
      "Couldn't confirm the reset \u00b7 it may have been used, check Claude settings",
      "error",
    ];
  }
  if (claim.status === "failed") {
    return [
      `Anthropic refused the reset${claim.httpStatus ? ` (${claim.httpStatus})` : ""} \u00b7 nothing was used`,
      "error",
    ];
  }
  const [message, type] = CLAIM_RESULT_TOASTS[claim.result] || [
    "Reset finished",
    "info",
  ];
  if (claim.result !== "reset") return [message, type];
  const left =
    typeof claim.resetsLeft === "number"
      ? ` \u00b7 ${claim.resetsLeft} left`
      : "";
  return [`Refilled the ${limitsText(claim.cleared)}${left}`, type];
}

export { claimToast, claudeResetsFact, confirmNotesHtml, limitsText };
