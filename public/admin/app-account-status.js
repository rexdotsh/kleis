import { relativeTime, tokenStatus } from "./app-format.js";
import { DAY_MS, shortDate, untilText } from "./app-render-shared.js";
import { state } from "./app-state.js";

function quotaTimestamp(value) {
  if (typeof value === "number") {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const CODEX_PLAN_LABELS = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  self_serve_business_prolite: "Business Pro",
  self_serve_business_usage_based: "Business, usage-based",
  business: "Business",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise automation",
  enterprise_cbp_usage_based: "Enterprise, usage-based",
  enterprise: "Enterprise",
  edu: "Education",
  unknown: "Unknown",
};

function spanLabel(seconds, fallback) {
  if (typeof seconds !== "number" || seconds <= 0) return fallback;
  const hours = Math.round(seconds / 3600);
  return hours >= 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
}

function windowEntry(label, window, named = false) {
  const percent = window?.usedPercent ?? window?.utilization;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return {
    label,
    named,
    percent: Math.max(0, Math.min(100, percent)),
    resetsAt: quotaTimestamp(window?.resetAt ?? window?.resetsAt),
  };
}

function accountWindows(account) {
  const data = account.quota?.data;
  if (!data) return [];
  if (data.provider === "codex") {
    const status = data.status;
    return [
      windowEntry(
        spanLabel(status?.primaryWindow?.windowSeconds, "5h"),
        status?.primaryWindow
      ),
      windowEntry(
        spanLabel(status?.secondaryWindow?.windowSeconds, "7d"),
        status?.secondaryWindow
      ),
      ...(status?.additionalRateLimits || []).map((limit) =>
        windowEntry(
          limit.limitName || limit.meteredFeature || "Extra",
          limit.primaryWindow,
          true
        )
      ),
    ].filter(Boolean);
  }
  const subscription = data.subscription;
  return [
    windowEntry("5h", subscription?.fiveHour),
    windowEntry("7d", subscription?.sevenDay),
    ...(subscription?.limits || [])
      .filter((limit) => limit.kind === "weekly_scoped")
      .map((limit) =>
        windowEntry(
          `${limit.modelDisplayName || "Scoped"} 7d`,
          { utilization: limit.percent, resetsAt: limit.resetsAt },
          true
        )
      ),
  ].filter(Boolean);
}

function tightestWindow(account) {
  let tightest = null;
  for (const window of accountWindows(account)) {
    if (!tightest || window.percent > tightest.percent) tightest = window;
  }
  return tightest;
}

function limitSeverity(percent) {
  if (percent >= 100) return "err";
  return percent >= 75 ? "warn" : "";
}

const ACCOUNT_ON_HOLD = "account_on_hold";
const REAUTHORIZE_WARNING_MS = 7 * DAY_MS;
const isOnHold = (account) => account.lastRefreshStatus === ACCOUNT_ON_HOLD;

// Claude sign-ins last about a month; within a week of the end the account
// needs a new sign-in before the refresh token stops working.
function reauthorizeDeadline(account) {
  const at = account.metadata?.refreshTokenExpiresAt;
  return typeof at === "number" && at - Date.now() < REAUTHORIZE_WARNING_MS
    ? at
    : null;
}

function needsReauthorization(account) {
  return (
    tokenStatus(account.expiresAt).class !== "active" ||
    (account.lastRefreshStatus && account.lastRefreshStatus !== "success") ||
    account.quota?.errorStatus === 401 ||
    account.quota?.errorStatus === 403
  );
}

const isRateLimited = (quota) => quota?.errorStatus === 429;

// The provider asked us to slow down, but the last limits are still shown.
const isRateLimitedWithData = (quota) =>
  isRateLimited(quota) && Boolean(quota.fetchedAt);

const syncFailureText = (quota) =>
  isRateLimited(quota) ? "Rate limited" : "Sync failed";

function accountIssues(account) {
  const issues = [];
  if (tokenStatus(account.expiresAt).class === "expired") {
    issues.push({
      severity: "err",
      text: "token expired, reauthorize",
      when: `expired ${relativeTime(account.expiresAt)}`,
    });
  } else if (isOnHold(account)) {
    issues.push({
      severity: "err",
      text: "account on hold",
      when: account.lastRefreshAt ? relativeTime(account.lastRefreshAt) : "",
    });
  } else if (
    account.lastRefreshStatus &&
    account.lastRefreshStatus !== "success"
  ) {
    issues.push({
      severity: "err",
      text: `token refresh failed (${account.lastRefreshStatus})`,
      when: account.lastRefreshAt ? relativeTime(account.lastRefreshAt) : "",
    });
  }
  const deadline = reauthorizeDeadline(account);
  if (deadline && tokenStatus(account.expiresAt).class !== "expired") {
    issues.push({
      severity: "warn",
      text: "sign-in ends soon, reauthorize",
      when: `by ${shortDate(deadline)}`,
    });
  }
  const quota = account.quota;
  if (quota?.errorStatus === 401 || quota?.errorStatus === 403) {
    issues.push({
      severity: "err",
      text: `provider rejected the token (${quota.errorStatus}), reauthorize`,
      when: "",
    });
  } else if (quota?.error && !isRateLimitedWithData(quota)) {
    issues.push({
      severity: "warn",
      text: isRateLimited(quota) ? "limits rate limited" : "limit sync failed",
      when: "",
    });
  }
  const tightest = tightestWindow(account);
  const severity = tightest ? limitSeverity(tightest.percent) : "";
  if (severity) {
    issues.push({
      severity,
      text: `${tightest.named ? tightest.label : `${tightest.label} window`} at ${Math.round(tightest.percent)}%`,
      when:
        tightest.resetsAt && tightest.resetsAt > Date.now()
          ? `resets ${untilText(tightest.resetsAt)}`
          : "",
    });
  }
  return issues.sort(
    (a, b) => Number(b.severity === "err") - Number(a.severity === "err")
  );
}

function providerStatusMap() {
  return new Map(
    (state.providerStatuses || []).map((status) => [status.provider, status])
  );
}

function isAccountServing(account, statuses = providerStatusMap()) {
  return (
    account.enabled !== false &&
    statuses.get(account.provider)?.enabled !== false
  );
}

export {
  quotaTimestamp,
  CODEX_PLAN_LABELS,
  accountWindows,
  limitSeverity,
  isOnHold,
  reauthorizeDeadline,
  needsReauthorization,
  isRateLimited,
  isRateLimitedWithData,
  syncFailureText,
  accountIssues,
  providerStatusMap,
  isAccountServing,
};
