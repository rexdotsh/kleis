import {
  CLAUDE_LIMIT_NAMES,
  claudeWindowLabel,
  needsReauthorization,
  quotaTimestamp,
  shortDate,
} from "./app-render-shared.js";

const CLAUDE_USAGE_SETTINGS_URL = "https://claude.ai/settings/usage";

const weekdayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

function limitsText(types) {
  const names = [
    ...new Set(types.map((type) => CLAUDE_LIMIT_NAMES[type])),
  ].filter(Boolean);
  if (!names.length) return "limits";
  const last = names.pop();
  return names.length
    ? `${names.join(", ")} and ${last} limits`
    : `${last} limit`;
}

function expiryText(endsAt) {
  const expiry = quotaTimestamp(endsAt);
  return expiry ? `use by ${shortDate(expiry)}` : "expiry not reported";
}

const UNAVAILABLE_TEXT = {
  paused: "paused",
  cooldown: "cooling down after a recent reset",
  not_usable: "unavailable right now",
  unsupported_limits: "can't confirm what it refills",
};

function claudeResetStatus(resets) {
  if (resets.unavailable === "checking") {
    return {
      label: "waiting for sync",
      replaceCount: true,
      description: "Checked again at the next scheduled poll.",
    };
  }
  if (resets.ineligibleReason === "surface") {
    return {
      label: "claude.ai only",
      replaceCount: true,
      link: "Settings",
      description: "Can't be used through Kleis.",
    };
  }
  if (resets.unavailable === "ineligible") {
    return {
      label: "not eligible",
      replaceCount: true,
      description: resets.ineligibleReason,
    };
  }
  if (!resets.saved || resets.offer) return null;
  if (resets.unavailable === "requires_limit") {
    return {
      label: "usable once a limit is hit",
      description:
        "Claude only uses this reset once you hit a limit it refills.",
    };
  }
  return {
    label: UNAVAILABLE_TEXT[resets.unavailable] || "unavailable right now",
    link: "Settings",
    description:
      resets.unavailable === "cooldown"
        ? "Another reset was just used. Try later."
        : "Check Claude settings for availability.",
  };
}

function claudeResetOffer(account) {
  const resets = account?.claudeResets;
  if (account?.provider !== "claude" || !resets) return null;
  const offer = resets.saved ? resets.offer : null;
  const status = claudeResetStatus(resets);
  if (!offer && !status) return null;
  const clears = offer?.clears || resets.clears;
  const windowLabels =
    resets.unavailable === "unsupported_limits"
      ? []
      : [
          ...new Set(
            clears.map((type) => claudeWindowLabel(type)).filter(Boolean)
          ),
        ];
  const endsAt = offer?.endsAt ?? resets.nextEndsAt;
  const weekly = quotaTimestamp(offer?.weeklyResetsAt);
  const state = offer
    ? "now"
    : resets.unavailable === "requires_limit"
      ? "at_limit"
      : "unavailable";
  return {
    count: resets.saved,
    unit: "reset",
    noun: "saved reset",
    heading: "Limit reset",
    action: "Use reset",
    state,
    canUse: state === "now",
    atLimitOnly: state === "at_limit",
    resetId: offer?.grantId,
    scope: windowLabels.length ? limitsText(clears) : null,
    expiresAt: quotaTimestamp(endsAt),
    expiryText: expiryText(endsAt),
    title: offer?.label,
    status,
    settingsUrl: CLAUDE_USAGE_SETTINGS_URL,
    description: "",
    earlyUse: offer?.earlyUse
      ? {
          scope: offer.earlyUse.limit
            ? `${CLAUDE_LIMIT_NAMES[offer.earlyUse.limit] || "covered"} limit`
            : null,
          percentUsed: offer.earlyUse.percentUsed,
        }
      : null,
    notes: [
      weekly && `Your weekly reset day stays ${weekdayFormat.format(weekly)}.`,
      "Applies to this Claude account everywhere: claude.ai, Claude Code and every Kleis key.",
    ].filter(Boolean),
    useful:
      Boolean(offer) &&
      !account.quota?.error &&
      !needsReauthorization(account) &&
      (!offer.earlyUse || offer.earlyUse.percentUsed >= 75),
  };
}

const NO_RESET_SPENT = "No reset was spent.";

const CLAIM_RESULT_TOASTS = {
  already_used: [
    "That reset was already used \u00b7 nothing more was spent",
    "info",
  ],
  not_limited: [
    `Nothing to reset yet: no limit this reset refills is hit. ${NO_RESET_SPENT}`,
    "info",
  ],
  cooldown: [
    `Another reset was used recently \u00b7 try again later. ${NO_RESET_SPENT}`,
    "info",
  ],
  ineligible: [
    `This reset can't be used on this account any more. ${NO_RESET_SPENT}`,
    "error",
  ],
};

const UNCONFIRMED_REASONS = new Set([
  "stamp_indeterminate",
  "reset_unconfirmed",
]);

function claimToast(claim) {
  if (UNCONFIRMED_REASONS.has(claim.reason)) {
    return {
      message:
        "Reset not confirmed yet \u00b7 the next limits check shows whether it was used",
      type: "info",
    };
  }
  if (claim.result === "unavailable") {
    return {
      message:
        "Couldn't confirm the reset \u00b7 the next limits check shows whether it was used",
      type: "error",
    };
  }
  if (claim.result === "reset") {
    return {
      message: `Refilled the ${limitsText(claim.cleared)} \u00b7 1 reset used`,
      type: "success",
      remaining: claim.resetsLeft,
      changed: true,
    };
  }
  const [message, type] = CLAIM_RESULT_TOASTS[claim.result] || [
    `Claude answered \u201c${claim.result}\u201d \u00b7 the next limits check shows whether a reset was used`,
    "info",
  ];
  return { message, type };
}

const claudeResets = { offerFor: claudeResetOffer, resultToast: claimToast };

export { claudeResets };
