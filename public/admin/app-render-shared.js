import { $, escapeHtml, mutationAttributes, state } from "./app-core.js";

function relativeTime(ts) {
  if (!ts) return "never";
  const d = ts - Date.now();
  const abs = Math.abs(d);
  if (abs < 60_000) return d >= 0 ? "in <1m" : "just now";
  if (abs < 3_600_000) {
    const minutes = Math.floor(abs / 60_000);
    return d >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  }
  if (abs < 86_400_000) {
    const hours = Math.floor(abs / 3_600_000);
    return d >= 0 ? `in ${hours}h` : `${hours}h ago`;
  }
  return shortDate(ts);
}

function tokenStatus(expiresAt) {
  if (!expiresAt) return { label: "unknown", class: "unknown" };
  return expiresAt > Date.now()
    ? { label: "active", class: "active" }
    : { label: "expired", class: "expired" };
}

function maskKey(k) {
  return k.length <= 14 ? k : `${k.slice(0, 9)}\u2026${k.slice(-4)}`;
}

function usageWindowLabel(windowMs) {
  if (windowMs % 86_400_000 === 0 && windowMs > 86_400_000) {
    return `${windowMs / 86_400_000}d`;
  }
  if (windowMs % 3_600_000 === 0) return `${windowMs / 3_600_000}h`;
  if (windowMs % 60_000 === 0) return `${windowMs / 60_000}m`;
  return `${Math.floor(windowMs / 1000)}s`;
}

function usageNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const countFormat = new Intl.NumberFormat("en-US");
const shortDateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

function formatCount(value) {
  return countFormat.format(usageNumber(value));
}

function shortDate(timestamp) {
  return shortDateFormat.format(timestamp);
}

function formatCompact(n) {
  const v = usageNumber(n);
  if (v >= 1_000_000_000_000) return `${(v / 1_000_000_000_000).toFixed(2)}T`;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(v);
}

function cacheReadRate(inputTotalTokens, cacheReadTokens) {
  return inputTotalTokens > 0
    ? Math.round((cacheReadTokens / inputTotalTokens) * 100)
    : null;
}

function normalizeUsage(rawUsage) {
  const usage = rawUsage || {};
  const metrics = {};
  for (const field of [
    "requestCount",
    "successCount",
    "clientErrorCount",
    "serverErrorCount",
    "authErrorCount",
    "rateLimitCount",
    "proxyErrorCount",
    "upstreamErrorCount",
    "avgLatencyMs",
    "maxLatencyMs",
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ]) {
    metrics[field] = usageNumber(usage[field]);
  }
  metrics.inputTotalTokens = usageNumber(
    usage.inputTotalTokens ??
      metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens
  );
  metrics.totalTokens = usageNumber(
    usage.totalTokens ?? metrics.inputTotalTokens + metrics.outputTokens
  );
  metrics.successRate =
    typeof usage.successRate === "number" && Number.isFinite(usage.successRate)
      ? Math.max(0, Math.min(100, Math.trunc(usage.successRate)))
      : null;
  metrics.unclassifiedFailureCount = Math.max(
    0,
    metrics.clientErrorCount +
      metrics.serverErrorCount +
      metrics.authErrorCount -
      metrics.proxyErrorCount -
      metrics.upstreamErrorCount
  );
  metrics.lastRequestAt = Number.isFinite(usage.lastRequestAt)
    ? usage.lastRequestAt
    : null;
  return metrics;
}

function formatMetadataForInput(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "";
  }

  return JSON.stringify(metadata, null, 2);
}

const shortId = (value) =>
  value && value.length > 14
    ? `${value.slice(0, 8)}\u2026${value.slice(-4)}`
    : value || "";

const accountLabel = (account) =>
  account.label || account.accountId || shortId(account.id);

function dateInputValue(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const PROVIDERS = ["codex", "claude"];
const PROVIDER_NAMES = { codex: "Codex", claude: "Claude" };
const DAY_MS = 86_400_000;

const providerName = (provider) => PROVIDER_NAMES[provider] || provider;
const providerLabel = (provider) => providerName(provider) || "";
const icon = (name) =>
  `<svg width="16" height="16" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const accountName = (account) =>
  account.label || account.accountId || maskKey(account.id);
const keyName = (key) => key.label || maskKey(key.key);
const hasTraffic = (usage) => normalizeUsage(usage).requestCount > 0;

const actionMutationAttributes = (action, target) =>
  mutationAttributes(
    action === "revoke-key" ? [action, "revoke-key-request"] : action,
    target
  );

function untilText(timestamp) {
  const diff = timestamp - Date.now();
  if (diff <= 0) return relativeTime(timestamp);
  if (diff < 60_000) return "in <1m";
  if (diff < 3_600_000) return `in ${Math.floor(diff / 60_000)}m`;
  if (diff < DAY_MS) return `in ${Math.floor(diff / 3_600_000)}h`;
  return `in ${Math.floor(diff / DAY_MS)}d`;
}

const SKELETON_HTML = Array.from(
  { length: 6 },
  (_, index) =>
    `<div class="row skeleton"><span class="bone" style="width:${[46, 38, 52, 34, 44, 40][index]}%"></span></div>`
).join("");

const listSkeletonRows = (columns) =>
  Array.from(
    { length: 3 },
    () =>
      `<div class="row skeleton ${columns}"><span class="bone"></span><span class="l2">&nbsp;</span></div>`
  ).join("");
const accountColumnsHtml = (requests = "Requests") =>
  `<span class="col d">Limits</span><span class="col num d">Resets</span><span class="col num">${requests}</span><span></span>`;
const ACCOUNT_LOADING_HTML = PROVIDERS.map(
  (provider) =>
    `<div class="group t-acc"><span class="group-name"><span class="cap">${providerName(provider)}</span></span>${accountColumnsHtml()}</div><div class="group-rows">${listSkeletonRows("t-acc")}</div>`
).join("");
const KEY_LOADING_HTML = `<div class="row thead t-key"><span>Label</span><span class="d">Key</span><span class="d">Access</span><span class="num">Requests</span><span class="num d">Last used</span></div>${listSkeletonRows("t-key")}${listSkeletonRows("t-key")}`;

const kbd = (key) => `<span class="kbd" aria-hidden="true">${key}</span>`;

function disclosureHeadingHtml({
  id,
  label,
  count,
  open,
  cursor,
  action,
  note = "",
}) {
  return `<button class="disclosure-heading ${id}-heading${cursor === `${id}-group` ? " cursor" : ""}" type="button" data-cursor-id="${id}-group" data-action="${action}" aria-expanded="${open}" aria-controls="${id}-rows"><span class="group-name"><span class="cap">${escapeHtml(label)}</span><span class="muted small">${count}</span><span class="disclosure-chevron">${icon("chev")}</span></span>${note ? `<span class="disclosure-note">${escapeHtml(note)}</span>` : ""}</button>`;
}

function requestsCellHtml(usage) {
  const metrics = normalizeUsage(usage);
  const failed = failedCount(metrics);
  const count = `<span${metrics.requestCount ? "" : ' class="muted"'}>${formatCount(metrics.requestCount)}</span>`;
  return failed
    ? `<span class="warn small">${formatCount(failed)} failed</span>&ensp;${count}`
    : count;
}

function fact(label, value, subs = [], extra = "") {
  const lines = subs
    .filter(Boolean)
    .map((sub) => `<div class="fact-sub">${sub}</div>`)
    .join("");
  return `<div class="fact"><div class="fact-label">${label}</div><div class="fact-value">${value}</div>${lines}${extra}</div>`;
}

function usageFact(rawUsage, windowMs) {
  const usage = normalizeUsage(rawUsage);
  const failed = failedCount(usage);
  const label = `Last ${escapeHtml(usageWindowLabel(windowMs))}`;
  if (!usage.requestCount) return fact(label, "0 requests", ["no traffic"]);
  const problems = [
    failed && `${formatCount(failed)} failed`,
    usage.rateLimitCount && `${formatCount(usage.rateLimitCount)} rate-limited`,
  ].filter(Boolean);
  return fact(
    label,
    `${formatCount(usage.requestCount)} request${usage.requestCount === 1 ? "" : "s"}`,
    [
      `${successRateText(usage)} success \u00b7 ${formatCount(usage.avgLatencyMs)} ms avg`,
      problems.length
        ? `<span class="warn">${problems.join(" \u00b7 ")}</span>`
        : usage.lastRequestAt &&
          `last request ${escapeHtml(relativeTime(usage.lastRequestAt))}`,
    ]
  );
}

function formRow(label, description, control, forId = "") {
  const title = forId
    ? `<label for="${forId}">${label}</label>`
    : `<span>${label}</span>`;
  return `<div class="form-row"><div class="form-row-label">${title}${description ? `<p>${description}</p>` : ""}</div><div class="form-row-control">${control}</div></div>`;
}

function formFoot(primaryButton, cancelAction) {
  return `<div class="form-foot"><div></div><div class="form-foot-buttons">${primaryButton}<button class="btn btn-ghost btn-sm" data-action="${cancelAction}" type="button">Cancel</button></div></div>`;
}

/* Inline forms survive list re-renders */

function fieldKey(input) {
  if (input.type === "checkbox" || input.type === "radio") {
    return `${input.name || input.className}:${input.value}`;
  }
  return input.id || `${input.className}:${input.dataset.provider ?? ""}`;
}

const isChoice = (input) => input.type === "checkbox" || input.type === "radio";

function renderPreservingForm(container, html) {
  const form = container.querySelector?.(".inline-form");
  const saved = form
    ? {
        id: form.dataset.form,
        focus: form.contains(document.activeElement)
          ? fieldKey(document.activeElement)
          : null,
        fields: new Map(
          Array.from(
            form.querySelectorAll("input, textarea, select"),
            (input) => [
              fieldKey(input),
              isChoice(input) ? input.checked : input.value,
            ]
          )
        ),
      }
    : null;
  container.innerHTML = html;
  const next = saved && container.querySelector(".inline-form");
  if (!next || next.dataset.form !== saved.id) return;
  for (const input of next.querySelectorAll("input, textarea, select")) {
    const key = fieldKey(input);
    if (saved.fields.has(key)) {
      if (isChoice(input)) input.checked = saved.fields.get(key);
      else input.value = saved.fields.get(key);
    }
    if (key === saved.focus) input.focus();
  }
}

function showLoading(containerId) {
  const el = $(`#${containerId}`);
  if (el && !el.querySelector(".skeleton")) {
    el.innerHTML =
      containerId === "accounts-list" ? ACCOUNT_LOADING_HTML : KEY_LOADING_HTML;
  }
}

function failedCount(metrics) {
  return (
    metrics.proxyErrorCount +
    metrics.upstreamErrorCount +
    metrics.unclassifiedFailureCount
  );
}

function successRateText(metrics) {
  if (!metrics.requestCount) return "\u2014";
  const rate = (metrics.successCount / metrics.requestCount) * 100;
  return rate >= 100 ? "100%" : `${(Math.floor(rate * 10) / 10).toFixed(1)}%`;
}

const prefersMotion = () =>
  globalThis.matchMedia?.("(prefers-reduced-motion: no-preference)").matches ??
  false;
const detailResizes = new WeakMap();

// Re-renders replace the list's HTML, so rows are moved from where they were
// to where they now are (FLIP); rows that are new simply appear.
const flipAnimations = new WeakMap();

// `anchor` names a row (its data-flip key) that should stay put on screen;
// the page scrolls to absorb height changes above it.
function renderWithMotion(container, update, { anchor = null } = {}) {
  const anchorTop = anchor
    ? container
        .querySelector?.(`[data-flip="${anchor}"]`)
        ?.getBoundingClientRect().top
    : undefined;
  const before = new Map();
  const details = new Map();
  const animate = prefersMotion() && container.querySelectorAll;
  if (animate) {
    for (const element of container.querySelectorAll("[data-flip]")) {
      before.set(element.dataset.flip, element.getBoundingClientRect().top);
    }
    for (const detail of container.querySelectorAll(
      ".detail:not(.inline-form)"
    )) {
      details.set(detail.dataset.detailFor, {
        height: detail.getBoundingClientRect().height,
        children: new Map(
          Array.from(
            detail.querySelectorAll(DETAIL_MOTION_SELECTOR),
            (element) => [
              detailMotionKey(element),
              element.getBoundingClientRect().top,
            ]
          )
        ),
      });
    }
  }
  // Snapshot the currently displayed geometry before interrupting a resize.
  for (const detail of container.querySelectorAll?.(".detail") || []) {
    detailResizes.get(detail)?.();
  }
  update();
  if (anchorTop !== undefined) {
    const top = container
      .querySelector(`[data-flip="${anchor}"]`)
      ?.getBoundingClientRect().top;
    if (top !== undefined && Math.abs(top - anchorTop) >= 1) {
      window.scrollBy({ top: top - anchorTop, behavior: "instant" });
    }
  }
  if (!(animate && before.size)) return;
  // Positions were read mid-slide; stop those slides so the new layout is
  // measured where it really is, and the next slide starts from where the
  // element was shown.
  for (const element of container.querySelectorAll("[data-flip]")) {
    flipAnimations.get(element)?.cancel();
  }
  let resizing = false;
  for (const detail of container.querySelectorAll(
    ".detail:not(.inline-form)"
  )) {
    const previous = details.get(detail.dataset.detailFor);
    if (previous) resizing = animateDetailResize(detail, previous) || resizing;
  }
  let lead = null;
  let leadDistance = 0;
  const offsets = new Map();
  for (const element of container.querySelectorAll("[data-flip]")) {
    const top = before.get(element.dataset.flip);
    // A newly opened detail travels with the row it belongs to.
    const offset =
      top === undefined
        ? (offsets.get(element.previousElementSibling) ?? 0)
        : top - element.getBoundingClientRect().top;
    if (Math.abs(offset) < 1) continue;
    offsets.set(element, offset);
    // Moving rows are opaque so they slide over the rows they pass.
    element.classList.add("flipping");
    const slide = element.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: "none" }],
      {
        duration: resizing ? 200 : 260,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      }
    );
    flipAnimations.set(element, slide);
    const done = () => {
      if (flipAnimations.get(element) !== slide) return;
      flipAnimations.delete(element);
      element.classList.remove("flipping", "flipping-lead");
    };
    slide.finished.then(done, done);
    if (Math.abs(offset) > leadDistance) {
      lead = element;
      leadDistance = Math.abs(offset);
    }
  }
  lead?.classList.add("flipping-lead");
}

const DETAIL_MOTION_SELECTOR =
  ".facts > .fact, .daily-tokens, .usage-grid, .actions";

function detailMotionKey(element) {
  if (element.classList.contains("fact"))
    return `fact:${element.querySelector(".fact-label").textContent}`;
  if (element.classList.contains("actions")) return "actions";
  return element.classList.contains("daily-tokens") ? "daily" : "usage";
}

function animateDetailResize(detail, previous) {
  const height = detail.getBoundingClientRect().height;
  if (Math.abs(height - previous.height) < 1) return;
  const timing = { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
  const animations = [];
  for (const element of detail.querySelectorAll(DETAIL_MOTION_SELECTOR)) {
    const top = previous.children.get(detailMotionKey(element));
    if (top === undefined) continue;
    const offset = top - element.getBoundingClientRect().top;
    if (Math.abs(offset) >= 1)
      animations.push(
        element.animate(
          [{ transform: `translateY(${offset}px)` }, { transform: "none" }],
          timing
        )
      );
  }
  // The temporary shell keeps sibling FLIP motion compositor-only while the
  // detail itself grows; it is removed as soon as the resize finishes.
  // Moving the detail into the shell would replay its opening animation; the
  // height animation below continues the reveal instead.
  detail.classList.remove("entering");
  const shell = document.createElement("div");
  shell.className = "detail-resize";
  shell.style.height = `${height}px`;
  detail.replaceWith(shell);
  shell.append(detail);
  detail.style.position = "absolute";
  detail.style.width = "100%";
  detail.style.overflow = "hidden";
  const finish = () => {
    if (!detailResizes.has(detail)) return;
    detailResizes.delete(detail);
    for (const animation of animations) animation.cancel();
    detail.style.position = "";
    detail.style.width = "";
    detail.style.overflow = "";
    shell.replaceWith(detail);
  };
  detailResizes.set(detail, finish);
  const animation = detail.animate(
    [{ height: `${previous.height}px` }, { height: `${height}px` }],
    timing
  );
  animations.push(animation);
  animation.finished.then(finish, finish);
  return true;
}

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

function windowEntry(label, window, named = false, fetchedAt = null) {
  const percent = window?.usedPercent ?? window?.utilization;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  let resetsAt = quotaTimestamp(window?.resetAt ?? window?.resetsAt);
  if (
    resetsAt === null &&
    Number.isFinite(fetchedAt) &&
    Number.isFinite(window?.resetAfterSeconds)
  ) {
    // Relative resets belong to the snapshot, not the time of each render.
    resetsAt = fetchedAt + window.resetAfterSeconds * 1000;
  }
  return {
    label,
    named,
    percent: Math.max(0, Math.min(100, percent)),
    resetsAt,
  };
}

const CLAUDE_LIMIT_NAMES = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_overage_included: "7d",
  seven_day_opus: "Opus 7d",
  seven_day_sonnet: "Sonnet 7d",
  seven_day_cowork: "Cowork 7d",
  seven_day_omelette: "Omelette 7d",
  seven_day_oauth_apps: "OAuth apps 7d",
};

function claudeNamedWindows(subscription) {
  const windows = new Map();
  const add = (label, window) => {
    if (!Number.isFinite(window?.utilization)) return;
    const key = label.toLowerCase();
    const previous = windows.get(key)?.[1];
    windows.set(key, [
      label,
      {
        ...window,
        utilization: Math.max(previous?.utilization ?? 0, window.utilization),
        resetsAt:
          previous?.utilization > window.utilization
            ? (previous.resetsAt ?? window.resetsAt)
            : (window.resetsAt ?? previous?.resetsAt),
      },
    ]);
  };
  for (const limit of subscription?.limits || []) {
    if (limit.kind === "weekly_scoped")
      add(`${limit.modelDisplayName || limit.modelId || "Scoped"} 7d`, {
        utilization: limit.percent,
        resetsAt: limit.resetsAt,
      });
  }
  for (const [key, window] of Object.entries(
    subscription?.modelWindows || {}
  )) {
    const label =
      key === "seven_day_overage_included"
        ? "7d incl. extra"
        : CLAUDE_LIMIT_NAMES[key] ||
          `${key.replace(/^seven_day_/, "").replaceAll("_", " ")} 7d`;
    add(label, window);
  }
  return [...windows.values()];
}

function accountWindows(account) {
  const data = account.quota?.data;
  if (!data) return [];
  const primary = data.status?.primaryWindow || data.subscription?.fiveHour;
  const secondary = data.status?.secondaryWindow || data.subscription?.sevenDay;
  const named =
    data.provider === "codex"
      ? (data.status?.additionalRateLimits || []).flatMap((limit) => {
          const label = limit.limitName || limit.meteredFeature || "Extra";
          return [limit.primaryWindow, limit.secondaryWindow].map((window) => [
            limit.secondaryWindow
              ? `${label} ${spanLabel(window?.windowSeconds, window === limit.primaryWindow ? "5h" : "7d")}`
              : label,
            window,
          ]);
        })
      : claudeNamedWindows(data.subscription);
  return [
    [spanLabel(primary?.windowSeconds, "5h"), primary, false],
    [spanLabel(secondary?.windowSeconds, "7d"), secondary, false],
    ...named.map(([label, window]) => [label, window, true]),
  ]
    .map(([label, window, named]) =>
      windowEntry(label, window, named, account.quota.fetchedAt)
    )
    .filter(Boolean);
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
  return percent >= 80 ? "warn" : "";
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

function hasTokenFailure(account) {
  return (
    (account.lastRefreshStatus && account.lastRefreshStatus !== "success") ||
    account.quota?.errorStatus === 401 ||
    account.quota?.errorStatus === 403
  );
}

function needsReauthorization(account) {
  return (
    tokenStatus(account.expiresAt).class !== "active" ||
    hasTokenFailure(account)
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
  CLAUDE_LIMIT_NAMES,
  relativeTime,
  tokenStatus,
  maskKey,
  usageWindowLabel,
  formatCount,
  formatCompact,
  cacheReadRate,
  normalizeUsage,
  formatMetadataForInput,
  shortId,
  accountLabel,
  dateInputValue,
  providerLabel,
  PROVIDERS,
  DAY_MS,
  providerName,
  icon,
  accountName,
  keyName,
  shortDate,
  hasTraffic,
  actionMutationAttributes,
  untilText,
  SKELETON_HTML,
  accountColumnsHtml,
  kbd,
  disclosureHeadingHtml,
  requestsCellHtml,
  fact,
  usageFact,
  formRow,
  formFoot,
  renderPreservingForm,
  showLoading,
  successRateText,
  renderWithMotion,
  quotaTimestamp,
  CODEX_PLAN_LABELS,
  accountWindows,
  limitSeverity,
  isOnHold,
  reauthorizeDeadline,
  needsReauthorization,
  hasTokenFailure,
  isRateLimited,
  isRateLimitedWithData,
  syncFailureText,
  accountIssues,
  providerStatusMap,
  isAccountServing,
};
