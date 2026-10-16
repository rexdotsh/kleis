import { escapeHtml } from "./app-core.js";
import {
  fact,
  needsReauthorization,
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
  seven_day_cowork: "Cowork 7d",
  seven_day_omelette: "Omelette 7d",
  seven_day_oauth_apps: "OAuth apps 7d",
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
  unsupported_limits: "unrecognized limits",
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
  if (resets.unavailable === "identity_unverified") {
    return fact(
      "Limit resets",
      '<span class="muted">Identity not verified</span>',
      ["reconnect or wait for sync"]
    );
  }
  if (resets.ineligibleReason === "surface") {
    return fact("Limit resets", '<span class="muted">claude.ai only</span>', [
      "can't be used through Kleis",
      settingsLink(),
    ]);
  }
  if (!resets.saved) return "";
  if (resets.offer) return "";
  const reason = UNAVAILABLE_TEXT[resets.unavailable];
  return fact(
    resets.saved === 1 ? "Limit reset" : "Limit resets",
    String(resets.saved),
    [
      resets.unavailable !== "unsupported_limits" &&
        escapeHtml(`refills ${limitsText(resets.clears)}`),
      escapeHtml(expiryText(resets.nextEndsAt)),
      reason && escapeHtml(reason),
      reason && settingsLink(),
    ]
  );
}

function claudeResetOffer(account) {
  const resets = account?.claudeResets;
  const offer = resets?.offer;
  if (account?.provider !== "claude" || !offer || resets.claim || !resets.saved)
    return null;
  const weekly = quotaTimestamp(offer.weeklyResetsAt);
  return {
    count: resets.saved,
    unit: "reset",
    noun: "saved reset",
    heading: "Limit reset",
    action: "Use reset",
    canUse: true,
    retry: false,
    scope: limitsText(offer.clears),
    expiryText: expiryText(offer.endsAt),
    title: offer.label,
    description: "",
    earlyUse: offer.earlyUse
      ? {
          scope: offer.earlyUse.limit
            ? `${LIMIT_NAMES[offer.earlyUse.limit] || "covered"} limit`
            : null,
          percentUsed: offer.earlyUse.percentUsed,
        }
      : null,
    notes: [
      weekly && `Your weekly reset day stays ${weekdayFormat.format(weekly)}.`,
      "Applies to this Claude account everywhere: claude.ai, Claude Code and every Kleis key.",
    ].filter(Boolean),
    useful:
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

export { claimToast, claudeResets, claudeResetsFact, limitsText };
