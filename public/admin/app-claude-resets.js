import {
  CLAUDE_LIMIT_NAMES,
  claudeWindowLabel,
  needsReauthorization,
  quotaTimestamp,
  relativeTime,
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
  if (resets.claim?.status === "pending") {
    return {
      label: "claiming reset\u2026",
      replaceCount: true,
      description: `started ${relativeTime(resets.claim.startedAt)}`,
    };
  }
  if (resets.claim?.status === "ambiguous") {
    return {
      label: "reset not confirmed",
      replaceCount: true,
      warning: true,
      link: "Check",
      description: "May have been used. Kleis checks again shortly.",
    };
  }
  if (resets.unavailable === "identity_unverified") {
    return {
      label: "identity not verified",
      replaceCount: true,
      description: "Reconnect or wait for sync.",
    };
  }
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
  const offer = !resets.claim && resets.saved ? resets.offer : null;
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
    retry: false,
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
  return [`Refilled the ${limitsText(claim.cleared)}`, type];
}

function claudeClaimState(claim, error) {
  if (!error) return claim.status === "ambiguous" ? "ambiguous" : null;
  if (error.status === 409) {
    if (error.body?.reason === "claim_in_progress") return "pending";
    return error.body?.reason === "claim_unconfirmed" ? "ambiguous" : null;
  }
  if ([400, 401, 403, 404, 422, 429].includes(error.status)) return null;
  return "ambiguous";
}

const claudeResets = {
  offerFor: claudeResetOffer,
  attemptFor(account) {
    const offer = account.claudeResets.offer;
    return { body: { grantId: offer.grantId, offerKey: offer.key } };
  },
  begin(account, attempt) {
    attempt.startedAt = Date.now();
    account.claudeResets = {
      ...account.claudeResets,
      offer: null,
      claim: { status: "pending", startedAt: attempt.startedAt },
    };
  },
  settle(account, attempt, response, error) {
    const claim = response?.claim || { status: "ambiguous" };
    const status = claudeClaimState(claim, error);
    account.claudeResets = {
      ...account.claudeResets,
      saved:
        typeof claim.resetsLeft === "number"
          ? claim.resetsLeft
          : (account.claudeResets?.saved ?? 0),
      offer: null,
      unavailable: "checking",
      claim: status ? { status, startedAt: attempt.startedAt } : null,
    };
    if (error)
      return {
        message: `${error.message}${status === "ambiguous" ? " The reset may have been used; check Claude settings." : ""}`,
        type: "error",
        refresh: true,
      };
    const [message, type] = claimToast(claim);
    return {
      message,
      type,
      refresh: true,
      remaining: type === "success" ? claim.resetsLeft : null,
    };
  },
};

export { claimToast, claudeResets, limitsText };
