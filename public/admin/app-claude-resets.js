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
  requires_limit: "at limit only",
  paused: "paused",
  cooldown: "try later",
  not_usable: "unavailable",
  checking: "checking",
  unsupported_limits: "scope not reported",
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
  const label = UNAVAILABLE_TEXT[resets.unavailable] || "waiting";
  return {
    label,
    link: label,
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
  return {
    count: resets.saved,
    unit: "reset",
    noun: "saved reset",
    heading: "Limit reset",
    action: "Use reset",
    canUse: Boolean(offer),
    resetId: offer?.grantId,
    scope: windowLabels.length ? limitsText(clears) : null,
    windowLabels,
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
  if (claim.result === "unavailable") {
    return {
      message:
        "Couldn't confirm the reset \u00b7 the next limits check will show whether it was used",
      type: "error",
    };
  }
  const [message, type] = CLAIM_RESULT_TOASTS[claim.result] || [
    "Reset finished",
    "info",
  ];
  return claim.result === "reset"
    ? {
        message: `Refilled the ${limitsText(claim.cleared)}`,
        type,
        remaining: claim.resetsLeft,
      }
    : { message, type };
}

const claudeResets = { offerFor: claudeResetOffer, resultToast: claimToast };

export { claudeResets };
