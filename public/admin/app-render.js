import {
  $,
  accountById,
  accountUsageForId,
  cacheReadRate,
  cancelOAuthFlow,
  completeOAuth,
  copyToClipboard,
  escapeHtml,
  formatCompact,
  formatCount,
  formatMetadataForInput,
  formatShortDate,
  dateInputValue,
  isKeyActive,
  keyAccessHtml,
  keyById,
  maskKey,
  modelsUrlForKey,
  normalizeUsage,
  relativeTime,
  requestUsageDetail,
  state,
  syncScopedAccountAvailability,
  tokenStatus,
  usageForKey,
  usageWindowLabel,
} from "./app-data.js";

const PROVIDERS = ["codex", "claude"];
const PROVIDER_NAMES = { codex: "Codex", claude: "Claude" };
const DAY_MS = 86_400_000;

const providerName = (provider) => PROVIDER_NAMES[provider] || provider;
const icon = (name) =>
  `<svg width="16" height="16" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const accountName = (account) =>
  account.label || account.accountId || maskKey(account.id);
const keyName = (key) => key.label || maskKey(key.key);
const shortDate = formatShortDate;
const hasTraffic = (usage) => normalizeUsage(usage).requestCount > 0;

function untilText(timestamp) {
  const diff = timestamp - Date.now();
  if (diff <= 0) return relativeTime(timestamp);
  if (diff < 60_000) return "in <1m";
  if (diff < 3_600_000) return `in ${Math.floor(diff / 60_000)}m`;
  if (diff < DAY_MS) return `in ${Math.floor(diff / 3_600_000)}h`;
  return `in ${Math.floor(diff / DAY_MS)}d`;
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
            detail.querySelectorAll(".facts > .fact, .usage-grid, .actions"),
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

function detailMotionKey(element) {
  return element.classList.contains("fact")
    ? `fact:${element.querySelector(".fact-label").textContent}`
    : element.classList.contains("actions")
      ? "actions"
      : "usage";
}

function animateDetailResize(detail, previous) {
  const height = detail.getBoundingClientRect().height;
  if (Math.abs(height - previous.height) < 1) return;
  const timing = { duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" };
  const animations = [];
  for (const element of detail.querySelectorAll(
    ".facts > .fact, .usage-grid, .actions"
  )) {
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
  `<span class="col d">Limits</span><span class="col num d">Token expires</span><span class="col num">${requests}</span><span></span>`;
const ACCOUNT_LOADING_HTML = PROVIDERS.map(
  (provider) =>
    `<div class="group t-acc"><span class="group-name"><span class="cap">${providerName(provider)}</span></span>${accountColumnsHtml()}</div><div class="group-rows">${listSkeletonRows("t-acc")}</div>`
).join("");
const KEY_LOADING_HTML = `<div class="row thead t-key"><span>Label</span><span class="d">Key</span><span class="d">Access</span><span class="num">Requests</span><span class="num d">Last used</span></div>${listSkeletonRows("t-key")}${listSkeletonRows("t-key")}`;

const kbd = (key) => `<span class="kbd" aria-hidden="true">${key}</span>`;

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

function requestsCellHtml(usage) {
  const metrics = normalizeUsage(usage);
  const failed = failedCount(metrics);
  const count = `<span${metrics.requestCount ? "" : ' class="muted"'}>${formatCount(metrics.requestCount)}</span>`;
  return failed
    ? `<span class="warn small">${formatCount(failed)} failed</span>&ensp;${count}`
    : count;
}

/* Accounts */

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

function needsReauthorization(account) {
  return (
    tokenStatus(account.expiresAt).class !== "active" ||
    (account.lastRefreshStatus && account.lastRefreshStatus !== "success") ||
    account.quota?.errorStatus === 401 ||
    account.quota?.errorStatus === 403
  );
}

function accountIssues(account) {
  const issues = [];
  if (tokenStatus(account.expiresAt).class === "expired") {
    issues.push({
      severity: "err",
      text: "token expired, reauthorize",
      when: `expired ${relativeTime(account.expiresAt)}`,
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
  const quota = account.quota;
  if (quota?.errorStatus === 401 || quota?.errorStatus === 403) {
    issues.push({
      severity: "err",
      text: `provider rejected the token (${quota.errorStatus}), reauthorize`,
      when: "",
    });
  } else if (quota?.error) {
    issues.push({ severity: "warn", text: "limit sync failed", when: "" });
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

function tokenCell(account) {
  if (!account.expiresAt) return { text: "\u2014", cls: "muted" };
  if (account.expiresAt <= Date.now()) return { text: "Expired", cls: "err" };
  return { text: untilText(account.expiresAt), cls: "muted" };
}

// Rows show the main windows (5h, 7d); model-specific windows stay in the
// expanded row.
const mainWindows = (account) =>
  accountWindows(account)
    .filter((window) => !window.named)
    .slice(0, 2);

function limitMetersHtml(account) {
  const windows = mainWindows(account);
  if (!windows.length) {
    if (account.quota?.error) return '<span class="warn">Sync failed</span>';
    return account.quota
      ? '<span class="muted">\u2014</span>'
      : '<span class="meter-pending" aria-label="Loading limits"></span>';
  }
  return windows
    .map((window) => {
      const severity = limitSeverity(window.percent);
      const percent = Math.round(window.percent);
      const reset =
        window.resetsAt && window.resetsAt > Date.now()
          ? `, resets ${untilText(window.resetsAt)}`
          : "";
      return `<span class="meter${severity ? ` ${severity}` : ""}" title="${escapeHtml(`${window.label} window at ${percent}%${reset}`)}"><span class="meter-label">${escapeHtml(window.label)}</span><span class="meter-bar"><i style="width:${window.percent}%"></i></span><span class="meter-pct">${percent}%</span></span>`;
    })
    .join("");
}

function limitSummaryText(account) {
  const windows = mainWindows(account);
  if (!windows.length) {
    return account.quota?.error ? '<span class="warn">sync failed</span>' : "";
  }
  return windows
    .map((window) => {
      const severity = limitSeverity(window.percent);
      const text = `${escapeHtml(window.label)} ${Math.round(window.percent)}%`;
      return severity ? `<span class="${severity}">${text}</span>` : text;
    })
    .join(" \u00b7 ");
}

function accountRowHtml(account, serving) {
  const name = accountName(account);
  const open = state.expandedAccountId === account.id;
  const issues = serving ? accountIssues(account) : [];
  let dot = "off";
  if (serving)
    dot = issues[0]?.severity || (account.isPrimary ? "primary" : "");
  const token = tokenCell(account);
  const usage = accountUsageForId(account.id);
  const phoneParts = [
    limitSummaryText(account),
    token.cls === "err"
      ? '<span class="err">token expired</span>'
      : `expires ${escapeHtml(token.text)}`,
  ].filter(Boolean);
  const cursor = state.cursorAccountId === account.id ? " cursor" : "";

  return `<div class="row t-acc${open ? " open" : ""}${serving ? "" : " dim"}${cursor}" data-account-id="${account.id}" data-flip="account:${account.id}" tabindex="0" role="button" aria-expanded="${open}">
    <span class="name"><span class="dot ${dot}"></span><span class="ellipsis">${escapeHtml(name)}</span>${account.isPrimary ? '<span class="tag tag-primary">Primary</span>' : ""}${account.enabled === false ? '<span class="tag">Disabled</span>' : ""}</span>
    <span class="meters d">${limitMetersHtml(account)}</span>
    <span class="num d ${token.cls}">${escapeHtml(token.text)}</span>
    <span class="num">${requestsCellHtml(usage)}</span>
    <button class="more" type="button" data-menu="account" data-account-id="${account.id}" aria-label="Actions for ${escapeHtml(name)}" aria-haspopup="menu" aria-expanded="false">${icon("more")}</button>
    <span class="l2">${phoneParts.join(" \u00b7 ")}</span>
  </div>${open ? accountDetailHtml(account) : ""}`;
}

function fact(label, value, subs = [], extra = "") {
  const lines = subs
    .filter(Boolean)
    .map((sub) => `<div class="fact-sub">${sub}</div>`)
    .join("");
  return `<div class="fact"><div class="fact-label">${label}</div><div class="fact-value">${value}</div>${lines}${extra}</div>`;
}

function resetText(window) {
  if (window.resetsAt) {
    return window.resetsAt > Date.now()
      ? `resets ${untilText(window.resetsAt)}`
      : "reset, waiting for sync";
  }
  return window.percent === 0 ? "not started" : "";
}

function limitFacts(account) {
  const quota = account.quota;
  if (!quota)
    return [
      fact("Rate limits", '<span class="muted">\u2014</span>', [
        "waiting for the first sync",
      ]),
    ];
  const facts = accountWindows(account).map((window) => {
    const severity = limitSeverity(window.percent);
    return fact(
      escapeHtml(window.named ? window.label : `${window.label} window`),
      `<span class="${severity}">${Math.round(window.percent)}%</span>`,
      [escapeHtml(resetText(window))],
      `<span class="bar${severity ? ` ${severity}` : ""}"><i style="width:${window.percent}%"></i></span>`
    );
  });
  if (quota.error)
    facts.push(
      `<div class="fact"><div class="fact-label">Limit sync</div><div class="fact-value err">Failed</div><div class="fact-sub clamp" title="${escapeHtml(quota.error)}">${escapeHtml(quota.error)}</div></div>`
    );
  else if (!facts.length)
    facts.push(fact("Rate limits", '<span class="muted">None reported</span>'));
  return facts;
}

function creditsFact(account) {
  const data = account.quota?.data;
  if (data?.provider !== "codex") return "";
  const credits = (data?.resetCredits?.credits || [])
    .filter((credit) => credit.status === "available")
    .sort(
      (a, b) =>
        (quotaTimestamp(a.expiresAt) ?? Number.POSITIVE_INFINITY) -
        (quotaTimestamp(b.expiresAt) ?? Number.POSITIVE_INFINITY)
    );
  const available =
    data?.resetCredits?.availableCount ?? data?.status?.resetCreditsAvailable;
  const count = Math.max(
    credits.length,
    typeof available === "number" ? available : 0
  );
  if (!count) return "";
  const next = credits[0];
  const expiry = quotaTimestamp(next?.expiresAt);
  const title = next
    ? `${next.title || "Reset credit"}: ${next.description || "restores this account's Codex limits"}`
    : "Consume a reset credit to restore limits";
  const use = `<button class="link small" type="button" data-action="redeem-reset-credit" data-account-id="${account.id}"${next ? ` data-credit-id="${escapeHtml(next.id)}"` : ""} title="${escapeHtml(title)}">Use one</button>`;
  let expiryText = "";
  if (next) {
    expiryText = expiry
      ? `${count > 1 ? "next expires" : "expires"} ${untilText(expiry)}`
      : "does not expire";
  }
  return fact(
    count === 1 ? "Reset credit" : "Reset credits",
    `${count}${use}`,
    [escapeHtml(expiryText)]
  );
}

function tokenFact(account) {
  const expired = tokenStatus(account.expiresAt).class === "expired";
  const refreshFailed =
    account.lastRefreshStatus && account.lastRefreshStatus !== "success";
  let value = "Active";
  if (account.enabled === false) value = "Disabled";
  else if (expired) value = '<span class="err">Expired</span>';
  else if (needsReauthorization(account)) {
    value = '<span class="err">Needs reauthorization</span>';
  }
  let expiry = "no expiry recorded";
  if (account.expiresAt) {
    expiry = expired
      ? `expired ${relativeTime(account.expiresAt)}`
      : `expires ${untilText(account.expiresAt)}`;
  }
  let refresh = "never refreshed";
  if (refreshFailed) {
    refresh = `<span class="err">refresh failed: ${escapeHtml(account.lastRefreshStatus)}</span>`;
  } else if (account.lastRefreshAt) {
    refresh = `refreshed ${escapeHtml(relativeTime(account.lastRefreshAt))}`;
  }
  return fact("Token", value, [escapeHtml(expiry), refresh]);
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

function accountFact(account) {
  const data = account.quota?.data;
  const added = account.createdAt
    ? `added ${shortDate(account.createdAt)}`
    : "";
  const id = account.accountId
    ? `<span class="mono" title="${escapeHtml(account.accountId)}">${escapeHtml(account.accountId)}</span>`
    : "";
  if (account.provider === "claude") {
    const extra = data?.subscription?.extraUsage;
    return fact(
      "Sign-in",
      account.metadata?.oauthMode === "console" ? "Console" : "claude.ai",
      [
        extra?.isEnabled &&
          (typeof extra.utilization === "number"
            ? `extra usage on \u00b7 ${Math.round(extra.utilization)}% used`
            : "extra usage on"),
        id,
        added,
      ]
    );
  }
  const plan =
    CODEX_PLAN_LABELS[data?.status?.planType] || data?.status?.planType;
  const lifetime = data?.profile?.lifetimeTokens;
  return fact("Plan", escapeHtml(plan || "Unknown"), [
    typeof lifetime === "number" &&
      `${formatCompact(lifetime)} lifetime tokens`,
    id,
    added,
  ]);
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

function accountEditHtml(account) {
  return `<div class="detail inline-form" data-form="account:${account.id}" data-detail-for="${account.id}">
    <div class="form-rows">
      ${formRow(
        "Label",
        "Shown in lists and usage.",
        `<input id="edit-account-label" class="field-input" type="text" maxlength="160" placeholder="${escapeHtml(account.metadata?.email || "my-main-account")}" autocomplete="off" value="${escapeHtml(account.label || "")}">`,
        "edit-account-label"
      )}
      ${formRow(
        "Account ID",
        "The provider\u2019s account ID. Leave empty to clear.",
        `<input id="edit-account-account-id" class="field-input mono" type="text" maxlength="200" placeholder="None" autocomplete="off" value="${escapeHtml(account.accountId || "")}">`,
        "edit-account-account-id"
      )}
      ${formRow(
        "Metadata",
        "Provider settings stored with the account.",
        `<details class="json-edit"><summary>Show JSON</summary><textarea id="edit-account-metadata" class="field-input" rows="7" aria-label="Metadata JSON" placeholder='{"chatgptAccountId":"org_123"}'>${escapeHtml(formatMetadataForInput(account.metadata))}</textarea><p class="field-hint">Must be a JSON object. Leave empty to clear.</p></details>`
      )}
    </div>
    ${formFoot(`<button id="btn-save-account" class="btn btn-primary btn-sm" data-action="save-account" data-account-id="${account.id}" type="button">Save</button>`, "cancel-edit-account")}
  </div>`;
}

function keyFormHtml(mode, key = null) {
  const create = mode === "create";
  const prefix = create ? "key-" : "edit-key-";
  const rows = [
    formRow(
      "Label",
      "Shown in lists and usage.",
      `<input id="${prefix}label" class="field-input" type="text" maxlength="120" placeholder="my-laptop" autocomplete="off" value="${escapeHtml(key?.label || "")}">`,
      `${prefix}label`
    ),
    formRow(
      "Access",
      "Switch a provider off to block it. Each provider uses its primary account unless you pick one.",
      `<div id="${prefix}account-scopes" class="access">${keyAccessHtml(mode, key)}</div>`
    ),
    formRow(
      "Models",
      "Comma separated. Leave empty to allow every model.",
      `<input id="${prefix}model-scopes" class="field-input mono" type="text" placeholder="All models" autocomplete="off" spellcheck="false" value="${escapeHtml(key?.modelScopes?.join(", ") || "")}">`,
      `${prefix}model-scopes`
    ),
    create
      ? ""
      : formRow(
          "Expires",
          "Leave empty for a key that never expires.",
          `<input id="edit-key-expires-at" class="field-input field-date" type="date" value="${key.expiresAt ? dateInputValue(key.expiresAt) : ""}">`,
          "edit-key-expires-at"
        ),
  ];
  const submit = create
    ? '<button id="btn-submit-key" class="btn btn-primary btn-sm" data-action="submit-key" type="button">Create key</button>'
    : `<button id="btn-save-key" class="btn btn-primary btn-sm" data-action="save-key" data-key-id="${key.id}" type="button">Save</button>`;
  return `<div class="${create ? "create-form" : "detail"} inline-form" data-form="${create ? "create-key" : `edit-key:${key.id}`}"${key ? ` data-detail-for="${key.id}"` : ""}>
    ${create ? '<div class="form-title">New API key</div>' : ""}
    <div class="form-rows">${rows.join("")}</div>
    ${formFoot(submit, create ? "cancel-create-key" : "cancel-edit-key")}
  </div>`;
}

function accountDetailHtml(account) {
  if (state.editingAccountId === account.id) return accountEditHtml(account);
  const supportsOAuth =
    account.provider === "codex" || account.provider === "claude";
  const button = (label, action, shortcut, cls = "btn btn-ghost btn-sm") =>
    `<button class="${cls}" data-action="${action}" data-account-id="${account.id}" type="button">${label}${kbd(shortcut)}</button>`;
  const synced = account.quota?.fetchedAt
    ? `<span>Limits synced ${escapeHtml(relativeTime(account.quota.fetchedAt))}</span>`
    : "";
  const entering =
    state.enteringDetail === `account:${account.id}` ? " entering" : "";
  return `<div class="detail${entering}" data-detail-for="${account.id}" data-flip="detail:${account.id}">
    <div class="facts">${[
      ...limitFacts(account),
      creditsFact(account),
      tokenFact(account),
      usageFact(accountUsageForId(account.id), state.accountUsageWindowMs),
      accountFact(account),
    ].join("")}</div>
    ${hasTraffic(accountUsageForId(account.id)) ? `<div class="usage-slot usage-grid" data-usage-for="account:${account.id}">${usageSlotHtml("account", account.id)}</div>` : ""}
    <div class="actions">
      ${needsReauthorization(account) && supportsOAuth ? button("Reauthorize", "reauthorize-account", "A", "btn btn-primary btn-sm") : ""}
      ${account.isPrimary ? "" : button("Make primary", "set-primary", "P")}
      ${button("Refresh token", "refresh-account", "R")}
      ${button("Edit", "edit-account", "E")}
      ${button("Remove", "delete-account", "Del", "btn btn-ghost btn-sm btn-remove")}
      <div class="right">${synced}<span>Collapse <span class="kbd">esc</span></span></div>
    </div>
  </div>`;
}

function accountMatches(account, filter) {
  return [
    account.label,
    account.accountId,
    account.id,
    account.provider,
    account.metadata?.email,
  ].some((value) => value && String(value).toLowerCase().includes(filter));
}

// Each provider's heading row also labels the columns below it.
function groupHtml(provider, status, count) {
  const enabled = status?.enabled !== false;
  const name = providerName(provider);
  return `<div class="group t-acc" data-flip="group:${provider}">
    <span class="group-name"><span class="cap">${escapeHtml(name)}</span><span class="muted small">${count}</span><button class="switch" type="button" role="switch" aria-checked="${enabled}" aria-label="${escapeHtml(name)} enabled" title="${enabled ? "Enabled" : "Disabled"}" data-action="toggle-provider" data-provider="${provider}" data-enabled="${enabled ? "false" : "true"}"></button>${enabled ? "" : '<span class="tag">Disabled</span>'}</span>
    ${accountColumnsHtml(`Requests ${escapeHtml(usageWindowLabel(state.accountUsageWindowMs))}`)}
  </div>`;
}

function renderAccounts() {
  renderAttention();
  renderReauthorizeList();
  const { accounts } = state;
  const filter = state.accountFilter.trim().toLowerCase();
  const matches = filter
    ? accounts.filter((account) => accountMatches(account, filter))
    : accounts;
  $("#accounts-count").textContent = filter
    ? `${matches.length} of ${accounts.length}`
    : accounts.length
      ? String(accounts.length)
      : "";

  if (!accounts.length) {
    $("#accounts-list").innerHTML =
      '<div class="empty-state"><p>No accounts connected yet.</p><button class="btn btn-primary btn-sm" type="button" data-action="go-connect">Connect an account</button></div>';
    return;
  }
  if (!matches.length) {
    $("#accounts-list").innerHTML =
      `<div class="empty-state"><p>No accounts match \u201c${escapeHtml(state.accountFilter.trim())}\u201d.</p><button class="link small" type="button" data-action="clear-filter">Clear filter</button></div>`;
    return;
  }

  const statuses = providerStatusMap();
  const providers = [
    ...new Set([...PROVIDERS, ...matches.map((account) => account.provider)]),
  ];
  const groups = providers
    .map((provider) => {
      const rows = matches
        .filter((account) => account.provider === provider)
        .sort(
          (a, b) =>
            Number(b.isPrimary) - Number(a.isPrimary) ||
            (a.createdAt ?? 0) - (b.createdAt ?? 0)
        );
      if (!rows.length) return "";
      return `${groupHtml(provider, statuses.get(provider), rows.length)}<div class="group-rows" data-flip="rows:${provider}">${rows
        .map((account) =>
          accountRowHtml(account, isAccountServing(account, statuses))
        )
        .join("")}</div>`;
    })
    .join("");

  const list = $("#accounts-list");
  renderWithMotion(list, () => renderPreservingForm(list, groups), {
    anchor: state.motionAnchor,
  });
  const expanded = state.expandedAccountId;
  if (
    expanded &&
    expanded !== state.editingAccountId &&
    hasTraffic(accountUsageForId(expanded))
  ) {
    requestUsageDetail("account", expanded);
  }
}

function accountMenuItems(account) {
  const supportsOAuth =
    account.provider === "codex" || account.provider === "claude";
  return [
    !account.isPrimary && {
      label: "Make primary",
      action: "set-primary",
      shortcut: "P",
    },
    { label: "Refresh token", action: "refresh-account", shortcut: "R" },
    supportsOAuth && {
      label: "Reauthorize",
      action: "reauthorize-account",
      shortcut: "A",
    },
    { label: "Edit", action: "edit-account", shortcut: "E" },
    "separator",
    {
      label: "Remove",
      action: "delete-account",
      shortcut: "Del",
      danger: true,
    },
  ];
}

function reauthorizeReason(account) {
  const status = account.quota?.errorStatus;
  if (tokenStatus(account.expiresAt).class === "expired") {
    return `expired ${relativeTime(account.expiresAt)}`;
  }
  if (account.lastRefreshStatus && account.lastRefreshStatus !== "success") {
    return "refresh failed";
  }
  if (status === 401 || status === 403) return `rejected (${status})`;
  return "no expiry recorded";
}

function renderReauthorizeList() {
  const el = $("#reauthorize-list");
  if (!el) return;
  const accounts = state.accounts.filter(
    (account) => account.provider === "codex" || account.provider === "claude"
  );
  if (!accounts.length) {
    el.innerHTML = '<p class="muted list-note">No accounts connected yet.</p>';
    return;
  }
  const flagged = accounts.filter(needsReauthorization);
  const others = accounts.filter((account) => !needsReauthorization(account));
  const shown = state.showAllReauthorize ? [...flagged, ...others] : flagged;
  const rows = shown.map((account) => {
    const reason = flagged.includes(account)
      ? reauthorizeReason(account)
      : providerName(account.provider);
    return `<button class="row reauth" type="button" data-action="reauthorize-account" data-account-id="${account.id}"><span class="name"><span class="dot ${flagged.includes(account) ? "err" : ""}"></span><span class="ellipsis">${escapeHtml(accountName(account))}</span></span><span class="small ${flagged.includes(account) ? "err" : "muted"}">${escapeHtml(reason)}</span>${icon("chev")}</button>`;
  });
  if (others.length) {
    rows.push(
      `<button class="row reauth" type="button" data-action="toggle-reauthorize-all"><span class="muted">${state.showAllReauthorize ? "Show fewer" : `${others.length} other account${others.length === 1 ? "" : "s"}`}</span><span></span>${icon("chev")}</button>`
    );
  }
  el.innerHTML = rows.join("");
}

/* Keys */

// Each provider the key may use and the account it goes through.
function keyAccess(key) {
  const pinned = new Map();
  for (const accountId of key.accountScopes || []) {
    const account = accountById(accountId);
    if (account) pinned.set(account.provider, account);
  }
  const providers = key.providerScopes?.length
    ? PROVIDERS.filter((provider) => key.providerScopes.includes(provider))
    : PROVIDERS;
  return {
    restricted: providers.length < PROVIDERS.length,
    routes: providers.map((provider) => ({
      provider,
      account: pinned.get(provider) ?? null,
    })),
  };
}

function routeText(route, { named = false } = {}) {
  if (route.account) return `via ${accountName(route.account)}`;
  const primary = named
    ? state.accounts.find(
        (account) => account.provider === route.provider && account.isPrimary
      )
    : null;
  return primary ? `via primary (${accountName(primary)})` : "via primary";
}

// null when the key can use every provider through its primary account.
function keyScopeParts(key) {
  const { restricted, routes } = keyAccess(key);
  if (!(restricted || routes.some((route) => route.account))) return null;
  return routes.map((route) => ({
    provider: `${providerName(route.provider)}${routes.length === 1 ? " only" : ""}`,
    via: routeText(route),
  }));
}

const modelCountText = (key) =>
  key.modelScopes?.length
    ? `${key.modelScopes.length} model${key.modelScopes.length === 1 ? "" : "s"}`
    : "";

function keyScopeHtml(key) {
  const parts = keyScopeParts(key);
  const access = parts
    ? parts
        .map(
          (part) =>
            `${escapeHtml(part.provider)} <span class="muted">${escapeHtml(part.via)}</span>`
        )
        .join('<span class="muted"> \u00b7 </span>')
    : "All providers";
  const models = modelCountText(key);
  return models
    ? `${access} <span class="muted" title="${escapeHtml(key.modelScopes.join(", "))}">\u00b7 ${models}</span>`
    : access;
}

function keyScopeText(key) {
  const parts = keyScopeParts(key);
  return [
    parts
      ? parts.map((part) => `${part.provider} ${part.via}`).join(" \u00b7 ")
      : "All providers",
    modelCountText(key),
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
}

function keyMatches(key, filter) {
  return [
    key.label,
    key.key,
    key.id,
    ...(key.providerScopes || []),
    ...(key.modelScopes || []),
  ].some((value) => value && String(value).toLowerCase().includes(filter));
}

function keyFacts(key) {
  const usage = normalizeUsage(usageForKey(key.id));
  const cached = cacheReadRate(usage.inputTotalTokens, usage.cacheReadTokens);
  const access = keyAccess(key);
  let expiry;
  if (key.revokedAt) {
    expiry = fact("Revoked", shortDate(key.revokedAt), [
      escapeHtml(relativeTime(key.revokedAt)),
    ]);
  } else if (key.expiresAt) {
    const expired = key.expiresAt <= Date.now();
    expiry = fact(
      "Expires",
      expired
        ? '<span class="err">Expired</span>'
        : escapeHtml(untilText(key.expiresAt)),
      [shortDate(key.expiresAt)]
    );
  } else {
    expiry = fact("Expires", "Never");
  }
  return [
    usageFact(usageForKey(key.id), state.keyUsageWindowMs),
    fact("Tokens", formatCompact(usage.totalTokens), [
      cached === null ? "" : `${cached}% cached input`,
      usage.outputTokens ? `${formatCompact(usage.outputTokens)} output` : "",
    ]),
    fact(
      "Access",
      escapeHtml(
        access.restricted
          ? `${access.routes.map((route) => providerName(route.provider)).join(", ")} only`
          : "All providers"
      ),
      [
        ...access.routes.map(
          (route) =>
            `${escapeHtml(providerName(route.provider))} ${escapeHtml(routeText(route, { named: true }))}`
        ),
        key.modelScopes?.length
          ? `<span title="${escapeHtml(key.modelScopes.join(", "))}">${escapeHtml(key.modelScopes.join(", "))}</span>`
          : "",
      ]
    ),
    expiry,
    fact("Created", key.createdAt ? shortDate(key.createdAt) : "\u2014", [
      `<span class="mono" title="${escapeHtml(key.id)}">${escapeHtml(key.id)}</span>`,
    ]),
  ].join("");
}

function keyDetailHtml(key) {
  if (state.editingKeyId === key.id) return keyFormHtml("edit", key);
  const revoked = Boolean(key.revokedAt);
  const revealed = state.revealedKeyIds.has(key.id);
  const button = (label, action, shortcut = "", cls = "btn btn-ghost btn-sm") =>
    `<button class="${cls}" data-action="${action}" data-key-id="${key.id}" type="button">${label}${shortcut ? kbd(shortcut) : ""}</button>`;
  const keyLine = revealed
    ? `<div class="key-line"><code>${escapeHtml(key.key)}</code>${button("Copy", "copy-key")}${button("Hide", "toggle-key")}</div>`
    : "";
  const actions = revoked
    ? [
        button("Edit", "edit-key", "E"),
        button(
          "Delete",
          "delete-key",
          "Del",
          "btn btn-ghost btn-sm btn-remove"
        ),
      ]
    : [
        button("Copy key", "copy-key", "C"),
        button(revealed ? "Hide key" : "Show key", "toggle-key", "S"),
        button("Edit", "edit-key", "E"),
        button("Rotate", "rotate-key", "R"),
        button(
          "Revoke",
          "revoke-key",
          "Del",
          "btn btn-ghost btn-sm btn-remove"
        ),
      ];
  const entering = state.enteringDetail === `key:${key.id}` ? " entering" : "";
  return `<div class="detail${entering}" data-detail-for="${key.id}" data-flip="detail:${key.id}">
    ${keyLine}
    <div class="facts">${keyFacts(key)}</div>
    ${hasTraffic(usageForKey(key.id)) ? `<div class="usage-slot usage-grid" data-usage-for="key:${key.id}">${usageSlotHtml("key", key.id)}</div>` : ""}
    <div class="actions">${actions.join("")}<div class="right"><span>Collapse <span class="kbd">esc</span></span></div></div>
  </div>`;
}

function keyRowHtml(key) {
  const revoked = Boolean(key.revokedAt);
  const active = isKeyActive(key);
  const open = state.expandedKeyId === key.id;
  const usage = usageForKey(key.id);
  const metrics = normalizeUsage(usage);
  const expiringSoon =
    active && key.expiresAt && key.expiresAt - Date.now() < 3 * DAY_MS;
  let dot = "";
  if (!active) dot = "off";
  else if (expiringSoon) dot = "warn";
  let tag = "";
  if (revoked) tag = "Revoked";
  else if (!active) tag = "Expired";
  else if (key.expiresAt) tag = `Expires ${untilText(key.expiresAt)}`;
  const lastUsed = metrics.lastRequestAt
    ? relativeTime(metrics.lastRequestAt)
    : "\u2014";
  const name = keyName(key);
  const cursor = state.cursorKeyId === key.id ? " cursor" : "";

  return `<div class="row t-key${open ? " open" : ""}${active || open ? "" : " dim"}${cursor}" data-key-id="${key.id}" data-flip="key:${key.id}" tabindex="0" role="button" aria-expanded="${open}">
    <span class="name"><span class="dot ${dot}"></span><span class="ellipsis">${escapeHtml(name)}</span>${tag ? `<span class="tag${expiringSoon ? " warn" : ""}">${escapeHtml(tag)}</span>` : ""}</span>
    <span class="mono muted ellipsis d">${escapeHtml(maskKey(key.key))}</span>
    <span class="ellipsis d">${keyScopeHtml(key)}</span>
    <span class="num">${revoked && !metrics.requestCount ? '<span class="muted">\u2014</span>' : requestsCellHtml(usage)}</span>
    <span class="num muted d">${escapeHtml(lastUsed)}</span>
    <button class="more" type="button" data-menu="key" data-key-id="${key.id}" aria-label="Actions for ${escapeHtml(name)}" aria-haspopup="menu" aria-expanded="false">${icon("more")}</button>
    <span class="l2">${escapeHtml([maskKey(key.key), keyScopeText(key), metrics.lastRequestAt ? lastUsed : ""].filter(Boolean).join(" \u00b7 "))}</span>
  </div>${open ? keyDetailHtml(key) : ""}`;
}

function keyActivity(key) {
  const metrics = normalizeUsage(usageForKey(key.id));
  return [metrics.requestCount, metrics.lastRequestAt ?? 0];
}

function compareKeys(a, b) {
  const rank = (key) => {
    if (key.revokedAt) return 2;
    return isKeyActive(key) ? 0 : 1;
  };
  const [aCount, aLast] = keyActivity(a);
  const [bCount, bLast] = keyActivity(b);
  return (
    rank(a) - rank(b) ||
    bCount - aCount ||
    bLast - aLast ||
    (b.createdAt ?? 0) - (a.createdAt ?? 0)
  );
}

function renderKeys() {
  const { keys, showRevokedKeys } = state;
  const activeCount = keys.filter(isKeyActive).length;
  const revokedCount = keys.filter((key) => key.revokedAt).length;
  const filter = state.keyFilter.trim().toLowerCase();
  $("#keys-count").textContent = keys.length
    ? `${activeCount} active \u00b7 ${keys.length} total`
    : "";

  let visible = keys.filter(
    (key) => showRevokedKeys || !key.revokedAt || key.id === state.expandedKeyId
  );
  if (filter) visible = visible.filter((key) => keyMatches(key, filter));
  visible = [...visible].sort(compareKeys);

  const visibleIds = new Set(visible.map((key) => key.id));
  for (const id of state.revealedKeyIds) {
    if (!visibleIds.has(id)) state.revealedKeyIds.delete(id);
  }

  const toggle = revokedCount
    ? ` \u00b7 <button class="link" type="button" data-action="${showRevokedKeys ? "hide-revoked" : "show-revoked"}">${showRevokedKeys ? "Hide revoked" : `Show ${revokedCount} revoked`}</button>`
    : "";
  let foot = "";
  if (filter) {
    foot = `${visible.length} match${visible.length === 1 ? "" : "es"}${toggle}`;
  } else if (keys.length) {
    foot = `Showing ${visible.length === keys.length ? "all " : ""}${visible.length}${visible.length === keys.length ? "" : ` of ${keys.length}`}, most active first${toggle}`;
  }
  $("#keys-foot").innerHTML = foot ? `<span>${foot}</span>` : "";

  const createForm = state.creatingKey ? keyFormHtml("create") : "";
  let body;
  if (!keys.length) {
    body = createForm
      ? ""
      : '<div class="empty-state"><p>No API keys yet.</p><button class="btn btn-primary btn-sm" type="button" data-action="open-create-key">Create a key</button></div>';
  } else if (visible.length) {
    body = `<div class="row thead t-key"><span>Label</span><span class="d">Key</span><span class="d">Access</span><span class="num">Requests ${escapeHtml(usageWindowLabel(state.keyUsageWindowMs))}</span><span class="num d">Last used</span><span></span></div>${visible.map(keyRowHtml).join("")}`;
  } else {
    body = filter
      ? `<div class="empty-state"><p>No keys match \u201c${escapeHtml(state.keyFilter.trim())}\u201d.</p><button class="link small" type="button" data-action="clear-filter">Clear filter</button></div>`
      : '<div class="empty-state"><p>No active API keys.</p><button class="btn btn-primary btn-sm" type="button" data-action="open-create-key">Create a key</button></div>';
  }

  const list = $("#keys-list");
  renderWithMotion(
    list,
    () => renderPreservingForm(list, `${createForm}${body}`),
    {
      anchor: state.motionAnchor,
    }
  );
  if (state.creatingKey) syncScopedAccountAvailability("create");
  if (state.editingKeyId) syncScopedAccountAvailability("edit");
  const expanded = state.expandedKeyId;
  if (
    expanded &&
    expanded !== state.editingKeyId &&
    visibleIds.has(expanded) &&
    hasTraffic(usageForKey(expanded))
  ) {
    requestUsageDetail("key", expanded);
  }
  if (state.setupOpen) renderOpenCodeSetup();
}

function keyMenuItems(key) {
  const revoked = Boolean(key.revokedAt);
  const active = isKeyActive(key);
  return [
    !revoked && { label: "Copy key", action: "copy-key", shortcut: "C" },
    active &&
      modelsUrlForKey(key) && {
        label: "Copy models URL",
        action: "copy-models-url",
        shortcut: "M",
      },
    !revoked && {
      label: state.revealedKeyIds.has(key.id) ? "Hide key" : "Show key",
      action: "toggle-key",
      shortcut: "S",
    },
    { label: "Edit", action: "edit-key", shortcut: "E" },
    !revoked && { label: "Rotate", action: "rotate-key", shortcut: "R" },
    active &&
      modelsUrlForKey(key) && {
        label: "Use with OpenCode",
        action: "open-setup",
        shortcut: "U",
      },
    "separator",
    revoked
      ? {
          label: "Delete",
          action: "delete-key",
          shortcut: "Del",
          danger: true,
        }
      : {
          label: "Revoke",
          action: "revoke-key",
          shortcut: "Del",
          danger: true,
        },
  ];
}

function menuHtml(kind, id) {
  const subject = kind === "account" ? accountById(id) : keyById(id);
  if (!subject) return "";
  const items = (
    kind === "account" ? accountMenuItems(subject) : keyMenuItems(subject)
  ).filter(Boolean);
  return items
    .map((item) => {
      if (item === "separator") return "<hr>";
      const shortcut = item.shortcut === "Del" ? "Backspace" : item.shortcut;
      return `<button class="menu-item${item.danger ? " danger" : ""}" type="button" role="menuitem" data-action="${item.action}" data-${kind}-id="${id}" data-shortcut="${shortcut}"><span>${item.label}</span><span class="kbd">${item.shortcut}</span></button>`;
    })
    .join("");
}

/* Usage inside expanded rows */

function usagePanelHtml(table, columns, message = "", loading = false) {
  const placeholder = loading
    ? Array.from(
        { length: 3 },
        () => `<div class="row skeleton"><span class="bone"></span></div>`
      ).join("")
    : `<p class="usage-note muted">${escapeHtml(message || "No usage in this window.")}</p>`;
  if (!(loading || message || table.body)) return "";
  const status = message
    ? ` <span class="usage-status err" title="${escapeHtml(message)}">Unavailable</span>`
    : "";
  return `<div class="usage-panel"><div class="list usage-table"><div class="row thead ${columns}"><span>${table.title}${status}</span>${table.head}</div>${table.body || placeholder}</div></div>`;
}

const DASHBOARD_LOADING_HTML = `<div class="kpis">${["Requests", "Success", "Tokens", "Cached input", "Avg latency"].map((label) => `<div class="kpi"><div class="kpi-label">${label}</div><div class="val"><span class="bone"></span></div><div class="sub">&nbsp;</div></div>`).join("")}</div><div class="chart"><div class="sh"><h2>Requests</h2></div><div class="plot"><span class="bone chart-bone"></span></div></div><div class="tables">${["By provider", "Top keys"].map((label) => `<div><div class="sh"><h2>${label}</h2></div><div class="list dashboard-table">${SKELETON_HTML}</div></div>`).join("")}</div>`;

function usageSlotHtml(kind, id) {
  const windowMs =
    kind === "account" ? state.accountUsageWindowMs : state.keyUsageWindowMs;
  const entry = state.usageDetails.get(`${kind}:${id}:${windowMs}`);
  const data = entry?.data || state.visibleUsageDetails.get(`${kind}:${id}`);
  if (entry?.data) state.visibleUsageDetails.set(`${kind}:${id}`, entry.data);
  const loading = !data && entry?.status !== "error";
  const message = entry?.status === "error" ? entry.error : "";
  return [
    kind === "account"
      ? keyListHtml(data?.apiKeys, data?.totals, message, loading)
      : accountListHtml(data?.accounts, data?.totals, message, loading),
    modelListHtml(data?.models, message, loading),
  ]
    .filter(Boolean)
    .join("");
}

function renderUsageSlot(kind, id) {
  const slot = document.querySelector(`[data-usage-for="${kind}:${id}"]`);
  if (!slot) return;
  const list = slot.closest?.("#accounts-list, #keys-list");
  const update = () => {
    slot.innerHTML = usageSlotHtml(kind, id);
  };
  if (list) renderWithMotion(list, update);
  else update();
}

function modelListHtml(rows, message, loading) {
  const body = [...(rows || [])]
    .sort((a, b) => (b.requestCount ?? 0) - (a.requestCount ?? 0))
    .map((row) => {
      const usage = normalizeUsage(row);
      const cached = cacheReadRate(
        usage.inputTotalTokens,
        usage.cacheReadTokens
      );
      return `<div class="row t-model"><span class="name"><span class="mono ellipsis">${escapeHtml(row.model?.trim() || "(unknown)")}</span><span class="tag d">${escapeHtml(`${providerName(row.provider)} \u00b7 ${row.endpoint}`)}</span></span><span class="num">${requestsCellHtml(row)}</span><span class="num muted">${formatCompact(usage.totalTokens)}</span><span class="num muted d">${cached === null ? "\u2014" : `${cached}%`}</span><span class="num muted d">${formatCount(usage.avgLatencyMs)} ms</span></div>`;
    })
    .join("");
  return usagePanelHtml(
    {
      title: "Model",
      head: '<span class="num">Requests</span><span class="num">Tokens</span><span class="num d">Cached</span><span class="num d">Latency</span>',
      body,
    },
    "t-model",
    message,
    loading
  );
}

function keyListHtml(rows, totals, message, loading) {
  const total = normalizeUsage(totals).requestCount;
  const body = [...(rows || [])]
    .sort((a, b) => (b.requestCount ?? 0) - (a.requestCount ?? 0))
    .map((row) => {
      const usage = normalizeUsage(row);
      const share = total
        ? `${((usage.requestCount / total) * 100).toFixed(1)}%`
        : "\u2014";
      const link = keyById(row.apiKeyId)
        ? ` data-key-id="${escapeHtml(row.apiKeyId)}" tabindex="0" role="button"`
        : "";
      return `<div class="row t-bykey"${link}><span class="ellipsis">${apiKeyDisplayHtml(row.apiKeyId)}</span><span class="num">${requestsCellHtml(row)}</span><span class="num muted">${share}</span><span class="num muted d">${formatCompact(usage.totalTokens)}</span><span class="num muted d">${formatCount(usage.avgLatencyMs)} ms</span></div>`;
    })
    .join("");
  return usagePanelHtml(
    {
      title: "Key",
      head: '<span class="num">Requests</span><span class="num">Share</span><span class="num d">Tokens</span><span class="num d">Latency</span>',
      body,
    },
    "t-bykey",
    message,
    loading
  );
}

// Requests refused before an account was chosen are stored under this id.
const NOT_ROUTED_ACCOUNT_ID = "__missing__";

function accountListHtml(rows, totals, message, loading) {
  const total = normalizeUsage(totals).requestCount;
  const body = (rows || [])
    .map((row) => {
      const usage = normalizeUsage(row);
      const share = total
        ? `${((usage.requestCount / total) * 100).toFixed(1)}%`
        : "\u2014";
      const account = accountById(row.providerAccountId);
      let name = `<span class="mono muted" title="${escapeHtml(row.providerAccountId)}">Removed account</span>`;
      if (row.providerAccountId === NOT_ROUTED_ACCOUNT_ID) {
        name =
          '<span class="muted" title="Refused before an account was chosen">Not routed</span>';
      } else if (account) {
        name = escapeHtml(accountName(account));
      }
      const link = account
        ? ` data-account-id="${account.id}" tabindex="0" role="button"`
        : "";
      return `<div class="row t-bykey"${link}><span class="name"><span class="ellipsis">${name}</span><span class="tag d">${escapeHtml(providerName(row.provider))}</span></span><span class="num">${requestsCellHtml(row)}</span><span class="num muted">${share}</span><span class="num muted d">${formatCompact(usage.totalTokens)}</span><span class="num muted d">${formatCount(usage.avgLatencyMs)} ms</span></div>`;
    })
    .join("");
  return usagePanelHtml(
    {
      title: "Account",
      head: '<span class="num">Requests</span><span class="num">Share</span><span class="num d">Tokens</span><span class="num d">Latency</span>',
      body,
    },
    "t-bykey",
    message,
    loading
  );
}

function apiKeyDisplayHtml(apiKeyId) {
  const key = keyById(apiKeyId);
  if (key) return escapeHtml(keyName(key));
  return `<span class="mono muted">${escapeHtml(apiKeyId.slice(0, 8))}\u2026</span>`;
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

/* OpenCode setup */

// OpenCode v2 loads models in its background service, so the URL goes into
// that service's environment; the key is entered with /connect.
function setupSnippet(key, { maskKey: masked = false } = {}) {
  return [
    "# Terminal",
    `opencode service set env OPENCODE_MODELS_URL "${modelsUrlForKey(key)}"`,
    "opencode",
    "",
    "# Inside OpenCode",
    "/connect",
    "# provider: kleis",
    `# key: ${masked ? maskKey(key.key) : key.key}`,
  ].join("\n");
}

const setupKeys = () =>
  state.keys
    .filter((key) => isKeyActive(key) && modelsUrlForKey(key))
    .sort(
      (a, b) =>
        normalizeUsage(usageForKey(b.id)).requestCount -
        normalizeUsage(usageForKey(a.id)).requestCount
    );

function renderOpenCodeSetup() {
  const panel = $("#opencode-setup");
  $("#btn-opencode")?.setAttribute("aria-expanded", String(state.setupOpen));
  if (!panel) return;
  panel.hidden = !state.setupOpen;
  if (!state.setupOpen) {
    panel.innerHTML = "";
    return;
  }
  const keys = setupKeys();
  const key =
    keys.find((candidate) => candidate.id === state.setupKeyId) ?? keys[0];
  const options = keys
    .map(
      (candidate) =>
        `<option value="${candidate.id}"${candidate === key ? " selected" : ""}>${escapeHtml(keyName(candidate))}</option>`
    )
    .join("");
  const body = key
    ? `<pre class="snippet-block">${escapeHtml(setupSnippet(key, { maskKey: !state.revealedKeyIds.has(key.id) }))}</pre>
      <p class="setup-note">Then pick a model marked Kleis in <span class="mono">/models</span>. Needs OpenCode v2.</p>`
    : '<p class="setup-note">No active keys yet. Create one first.</p>';
  panel.innerHTML = `<div class="setup">
    <div class="setup-head">
      <span class="setup-title">Use with OpenCode</span>
      ${keys.length ? `<select id="setup-key" class="field-input" aria-label="Key">${options}</select>` : ""}
      <div class="right">
        ${key ? `<button class="link small" type="button" data-action="copy-setup" data-key-id="${key.id}">Copy commands</button>` : ""}
        <button class="link small" type="button" data-action="close-setup">Close</button>
      </div>
    </div>
    ${body}
  </div>`;
}

/* Connect */

function renderOAuthLoading(provider, isDevice) {
  const target = accountById(state.reauthorizeAccountId);
  const name = target ? accountName(target) : null;
  const container = $("#oauth-flow-active");
  container.innerHTML = `<div class="flow" aria-busy="true"><p class="flow-title">${name ? `Reauthorizing <strong>${escapeHtml(name)}</strong>` : `Signing in to ${escapeHtml(providerName(provider))}`}</p><div class="field"><span class="field-label">1 \u00b7 Open this link and approve</span><div class="input-row"><span class="bone flow-url-skeleton"></span><button class="btn btn-ghost btn-sm" type="button" disabled>Copy</button></div></div><div class="field"><span class="field-label">2 \u00b7 ${isDevice ? "Enter this code on that page" : "Paste the code you get back"}</span>${isDevice ? '<div class="device-code"><span class="bone"></span></div>' : '<div class="field-input flow-input-skeleton"><span class="bone"></span></div>'}</div><div class="flow-actions"><button class="btn btn-primary btn-block" type="button" disabled>${isDevice ? "I\u2019ve approved it" : "Connect account"}</button><button id="btn-oauth-loading-cancel" class="btn btn-ghost" type="button">Start over</button></div></div>`;
  $("#btn-oauth-loading-cancel").addEventListener?.("click", cancelOAuthFlow);
}

function renderOAuthFlow(data, provider) {
  const container = $("#oauth-flow-active");
  container.style.display = "block";
  $("#btn-oauth-start").style.display = "none";

  const isDevice = data.method === "auto";
  const target = state.activeOAuth?.accountName;
  const url = escapeHtml(data.authorizationUrl);
  const deviceCode = isDevice
    ? (data.instructions || "").replace(/^Enter code:\s*/i, "")
    : "";

  const steps = [
    `<div class="field"><span class="field-label">1 \u00b7 Open this link and approve</span><div class="input-row"><a class="mono ellipsis" href="${url}" target="_blank" rel="noopener">${url}</a><button class="btn btn-ghost btn-sm" type="button" id="btn-oauth-copy-url">Copy</button></div></div>`,
  ];
  if (isDevice) {
    steps.push(
      `<div class="field"><span class="field-label">2 \u00b7 Enter this code on that page</span><div class="device-code">${escapeHtml(deviceCode)}</div></div>`
    );
  } else {
    steps.push(
      `<div class="field"><label class="field-label" for="oauth-code">2 \u00b7 Paste the code you get back</label><input id="oauth-code" class="field-input mono" type="text" placeholder="${provider === "codex" ? "Code or callback URL" : "Authorization code"}" autocomplete="off" spellcheck="false"></div>`
    );
  }

  container.innerHTML = `<div class="flow">
    <p class="flow-title">${target ? `Reauthorizing <strong>${escapeHtml(target)}</strong>` : `Signing in to ${escapeHtml(providerName(provider))}`}</p>
    ${steps.join("")}
    <p id="oauth-flow-error" class="oauth-flow-error" role="alert" hidden></p>
    <div class="flow-actions">
      <button class="btn btn-primary btn-block" type="button" id="btn-oauth-complete">${isDevice ? "I\u2019ve approved it" : "Connect account"}</button>
      <button class="btn btn-ghost" type="button" id="btn-oauth-cancel">Start over</button>
    </div>
  </div>`;

  $("#btn-oauth-complete").addEventListener("click", completeOAuth);
  $("#btn-oauth-cancel").addEventListener("click", cancelOAuthFlow);
  const copyUrl = $("#btn-oauth-copy-url");
  copyUrl.addEventListener("click", () =>
    copyToClipboard(data.authorizationUrl, copyUrl)
  );
  ($("#oauth-code") || $("#btn-oauth-complete")).focus();
}

/* Overview */

function renderAttention() {
  const el = $("#attention");
  if (!el || !state.overviewReady) return;
  const statuses = providerStatusMap();
  const items = [];
  for (const account of state.accounts) {
    if (!isAccountServing(account, statuses)) continue;
    const issues = accountIssues(account);
    if (!issues.length) continue;
    items.push({
      severity: issues[0].severity,
      name: accountName(account),
      text: `${providerName(account.provider)} \u00b7 ${issues.map((issue) => issue.text).join(", ")}`,
      when: issues.find((issue) => issue.when)?.when || "",
      accountId: account.id,
    });
  }

  const totals = state.dashboardData?.totals;
  if (totals) {
    const metrics = normalizeUsage(totals);
    const failed =
      metrics.upstreamErrorCount + metrics.unclassifiedFailureCount;
    const errorRate = metrics.requestCount
      ? (failed + metrics.proxyErrorCount + metrics.rateLimitCount) /
        metrics.requestCount
      : 0;
    if (metrics.proxyErrorCount > 0 || errorRate >= 0.01) {
      items.push({
        severity: "warn",
        name: "Request errors",
        text: `${formatCount(failed)} upstream fails \u00b7 ${formatCount(metrics.rateLimitCount)} rate-limited (429) \u00b7 ${formatCount(metrics.proxyErrorCount)} proxy fails`,
        when: `last ${usageWindowLabel(state.dashboardWindowMs)}`,
        accountId: null,
      });
    }
  }

  items.sort(
    (a, b) => Number(b.severity === "err") - Number(a.severity === "err")
  );
  el.innerHTML = items.length
    ? `<div class="sh"><h2>Needs attention</h2><span class="muted">${items.length}</span></div><div class="list">${items
        .map(
          (item) =>
            `<div class="row attn${item.accountId ? "" : " static"}"${item.accountId ? ` data-account-id="${item.accountId}" tabindex="0" role="button"` : ""}><span class="dot ${item.severity}"></span><span class="ellipsis">${escapeHtml(item.name)}</span><span class="muted ellipsis d">${escapeHtml(item.text)}</span><span class="num muted small">${escapeHtml(item.when)}</span>${item.accountId ? icon("chev") : "<span></span>"}<span class="l2">${escapeHtml(item.text)}</span></div>`
        )
        .join("")}</div>`
    : "";
}

function deltaText(current, previous) {
  if (!previous) return "";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "0%";
  return `${pct > 0 ? "+" : "\u2212"}${Math.abs(pct)}%`;
}

function kpisHtml(metrics, previous, windowLabel) {
  const cached = cacheReadRate(
    metrics.inputTotalTokens,
    metrics.cacheReadTokens
  );
  const errors = Math.max(0, metrics.requestCount - metrics.successCount);
  const requestsDelta = deltaText(metrics.requestCount, previous.requestCount);
  const kpis = [
    [
      "Requests",
      formatCompact(metrics.requestCount),
      requestsDelta ? `${requestsDelta} vs previous ${windowLabel}` : "",
    ],
    [
      "Success",
      successRateText(metrics),
      errors ? `${formatCount(errors)} errors` : "No errors",
    ],
    [
      "Tokens",
      formatCompact(metrics.totalTokens),
      deltaText(metrics.totalTokens, previous.totalTokens),
    ],
    [
      "Cached input",
      cached === null ? "\u2014" : `${cached}%`,
      cached === null ? "" : "of input tokens",
    ],
    [
      "Avg latency",
      `${formatCount(metrics.avgLatencyMs)}<span class="unit">ms</span>`,
      deltaText(metrics.avgLatencyMs, previous.avgLatencyMs),
    ],
  ];
  return `<div class="kpis">${kpis
    .map(
      ([label, value, sub]) =>
        `<div class="kpi"><div class="kpi-label">${label}</div><div class="val">${value}</div><div class="sub">${sub}</div></div>`
    )
    .join("")}</div>`;
}

const TICK_STEPS_MS = [
  5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440, 2880, 7200, 10_080,
].map((minutes) => minutes * 60_000);

function chartTicks(start, end, plotWidth) {
  const maxTicks = Math.max(2, Math.min(8, Math.floor(plotWidth / 80)));
  const step =
    TICK_STEPS_MS.find((ms) => (end - start) / ms <= maxTicks) ??
    TICK_STEPS_MS.at(-1);
  const ticks = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  if (step >= DAY_MS) {
    if (cursor.getTime() < start) cursor.setDate(cursor.getDate() + 1);
    while (cursor.getTime() <= end) {
      ticks.push({ at: cursor.getTime(), date: true });
      cursor.setDate(cursor.getDate() + step / DAY_MS);
    }
    return ticks;
  }
  for (let at = cursor.getTime(); at <= end; at += step) {
    if (at < start) continue;
    const date = new Date(at);
    ticks.push({
      at,
      date: date.getHours() === 0 && date.getMinutes() === 0,
    });
  }
  return ticks;
}

function bucketLabel(bucketSizeMs) {
  const minutes = Math.round(bucketSizeMs / 60_000);
  if (minutes === 1) return "minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "hour" : `${hours} hours`;
}

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});
const dayFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});
const timeLabel = (timestamp) => timeFormat.format(timestamp);

const chart = {
  slots: [],
  current: [],
  previous: null,
  width: 0,
  plotWidth: 0,
  x: () => 0,
  y: () => 0,
};

function niceCeil(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (factor * magnitude >= value) return factor * magnitude;
  }
  return 10 * magnitude;
}

function requestChartHtml(data, width) {
  const size = data.bucketSizeMs;
  const buckets = data.buckets || [];
  if (!size || !buckets.length) return emptyChartHtml();
  const windowMs = data.windowMs ?? state.dashboardWindowMs;
  const end =
    typeof data.now === "number" ? data.now : buckets.at(-1).bucketStart + size;
  const since = typeof data.since === "number" ? data.since : end - windowMs;
  const first = Math.floor(since / size) * size;
  const last = Math.floor((end - 1) / size) * size;
  const slots = [];
  for (let at = first; at <= last; at += size) slots.push(at);
  if (slots.length < 2) return emptyChartHtml();

  const counts = new Map(
    buckets.map((bucket) => [bucket.bucketStart, bucket.requestCount])
  );
  const previousCounts = new Map(
    (data.previousBuckets || []).map((bucket) => [
      bucket.bucketStart + windowMs,
      bucket.requestCount,
    ])
  );
  const current = slots.map((at) => counts.get(at) ?? 0);
  const previous = data.previousBuckets?.length
    ? slots.map((at) => previousCounts.get(at) ?? 0)
    : null;

  const height = width < 640 ? 128 : 160;
  const top = 8;
  const plotWidth = width - 48;
  const plotHeight = height - top - 24;
  const step = niceCeil(Math.max(3, ...current, ...(previous || [])) / 3);
  const yMax = step * 3;
  const x = (index) => (index / (slots.length - 1)) * plotWidth;
  const y = (value) => top + (1 - value / yMax) * plotHeight;
  const points = (series) =>
    series
      .map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
      .join(" ");
  Object.assign(chart, { slots, current, previous, width, plotWidth, x, y });

  let svg = `<svg class="plot-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Requests per ${bucketLabel(size)}"><g class="grid">`;
  for (let k = 0; k <= 3; k++) {
    const gy = Math.round(y(step * k)) + 0.5;
    const label = formatCompact(step * k).replace(/\.0(?=[KMBT])/, "");
    svg += `<line x1="0" x2="${plotWidth}" y1="${gy}" y2="${gy}"/><text x="${width}" y="${gy + 4}" text-anchor="end">${label}</text>`;
  }
  svg += "</g><g>";
  for (const tick of chartTicks(first, last, plotWidth)) {
    const tx = ((tick.at - first) / (last - first)) * plotWidth;
    if (tx > plotWidth - 40) continue;
    svg += `<text x="${tx.toFixed(1)}" y="${height - 4}">${escapeHtml(tick.date ? shortDate(tick.at) : timeLabel(tick.at))}</text>`;
  }
  svg += "</g>";
  if (previous)
    svg += `<polyline class="line-prev" points="${points(previous)}"/>`;
  svg += `<polyline class="line" points="${points(current)}"/><g class="hover" visibility="hidden"><line class="hover-line" y1="${top}" y2="${top + plotHeight}"/><circle class="hover-dot" r="3"/></g></svg>`;

  const windowLabel = usageWindowLabel(windowMs);
  const range =
    windowMs >= 2 * DAY_MS
      ? `${shortDate(first)} \u2013 ${shortDate(end)}`
      : `Last ${windowLabel}`;
  return `<div class="chart">
    <div class="sh"><h2>Requests</h2><span class="muted small">per ${bucketLabel(size)}</span>
      <div class="right legend"><span><i class="sw"></i>${escapeHtml(range)}</span>${previous ? `<span><i class="sw prev"></i>Previous ${escapeHtml(windowLabel)}</span>` : ""}</div>
    </div>
    <div class="plot">${svg}<div class="tip" hidden></div></div>
  </div>`;
}

function emptyChartHtml() {
  return '<div class="chart"><div class="sh"><h2>Requests</h2></div><div class="plot"><p class="usage-note muted">No usage in this window.</p></div></div>';
}

function showChartHover(plot, clientX) {
  if (chart.slots.length < 2) return;
  const offset = clientX - plot.getBoundingClientRect().left;
  const index = Math.max(
    0,
    Math.min(
      chart.slots.length - 1,
      Math.round((offset / chart.plotWidth) * (chart.slots.length - 1))
    )
  );
  const hx = chart.x(index);
  const hover = plot.querySelector(".hover");
  hover.setAttribute("visibility", "visible");
  const line = hover.querySelector(".hover-line");
  line.setAttribute("x1", String(Math.round(hx) + 0.5));
  line.setAttribute("x2", String(Math.round(hx) + 0.5));
  const dot = hover.querySelector(".hover-dot");
  dot.setAttribute("cx", hx.toFixed(1));
  dot.setAttribute("cy", chart.y(chart.current[index]).toFixed(1));

  const at = new Date(chart.slots[index]);
  const day = dayFormat.format(at);
  const tip = plot.querySelector(".tip");
  tip.innerHTML = `<span class="muted">${escapeHtml(`${day} \u00b7 ${timeLabel(at)}`)}</span><span>${formatCount(chart.current[index])} requests</span>${chart.previous ? `<span class="muted">prev ${formatCount(chart.previous[index])}</span>` : ""}`;
  tip.hidden = false;
  const tipWidth = tip.offsetWidth;
  const left =
    hx + 12 + tipWidth > chart.plotWidth ? hx - 12 - tipWidth : hx + 12;
  tip.style.left = `${Math.max(0, left)}px`;
}

function hideChartHover(plot) {
  plot.querySelector(".hover")?.setAttribute("visibility", "hidden");
  const tip = plot.querySelector(".tip");
  if (tip) tip.hidden = true;
}

function providerTableHtml(data, metrics) {
  const providers = data.byProvider || [];
  const models = new Map();
  for (const row of data.byModel || []) {
    const name = row.model?.trim() || "(unknown)";
    const group = models.get(row.provider) ?? new Map();
    const entry = group.get(name) ?? {
      requestCount: 0,
      totalTokens: 0,
      inputTotalTokens: 0,
      cacheReadTokens: 0,
    };
    const usage = normalizeUsage(row);
    entry.requestCount += usage.requestCount;
    entry.totalTokens += usage.totalTokens;
    entry.inputTotalTokens += usage.inputTotalTokens;
    entry.cacheReadTokens += usage.cacheReadTokens;
    group.set(name, entry);
    models.set(row.provider, group);
  }
  const cachedText = (usage) => {
    const rate = cacheReadRate(usage.inputTotalTokens, usage.cacheReadTokens);
    return rate === null ? "\u2014" : `${rate}%`;
  };

  const rows = providers
    .map((row) => {
      const usage = normalizeUsage(row);
      const share = metrics.requestCount
        ? Math.round((usage.requestCount / metrics.requestCount) * 100)
        : 0;
      const modelRows = Array.from(models.get(row.provider) ?? [])
        .sort((a, b) => b[1].requestCount - a[1].requestCount)
        .map(
          ([name, entry]) =>
            `<div class="row t-prov"><span class="model ellipsis">${escapeHtml(name)}</span><span class="num muted">${formatCount(entry.requestCount)}</span><span></span><span class="num muted d">${formatCompact(entry.totalTokens)}</span><span class="num muted d">${cachedText(entry)}</span></div>`
        )
        .join("");
      return `<div class="row t-prov"><span>${escapeHtml(providerName(row.provider))}</span><span class="num">${formatCount(usage.requestCount)}</span><span class="num muted">${share}%</span><span class="num d">${formatCompact(usage.totalTokens)}</span><span class="num muted d">${cachedText(usage)}</span></div>${modelRows}`;
    })
    .join("");

  return `<div><div class="sh"><h2>By provider</h2></div><div class="list dashboard-table" tabindex="0" aria-label="Usage by provider"><div class="row thead t-prov"><span>Provider</span><span class="num">Requests</span><span class="num">Share</span><span class="num d">Tokens</span><span class="num d">Cached</span></div>${rows || '<p class="list-note muted">No usage in this window.</p>'}</div></div>`;
}

function topKeysHtml(data, metrics) {
  const rows = (data.byKey || []).slice(0, 5);
  const body = rows
    .map((row) => {
      const share = metrics.requestCount
        ? ((row.requestCount / metrics.requestCount) * 100).toFixed(1)
        : "0.0";
      return `<div class="row t-keys" data-key-id="${escapeHtml(row.apiKeyId)}" tabindex="0" role="button"><span class="ellipsis">${apiKeyDisplayHtml(row.apiKeyId)}</span><span class="num">${formatCount(row.requestCount)}</span><span class="num muted">${share}%</span></div>`;
    })
    .join("");
  return `<div><div class="sh"><h2>Top keys</h2><div class="right"><button class="link small" type="button" data-action="go-keys">View all keys</button></div></div><div class="list dashboard-table" tabindex="0" aria-label="Top keys"><div class="row thead t-keys"><span>Key</span><span class="num">Requests</span><span class="num">Share</span></div>${body || '<p class="list-note muted">No usage in this window.</p>'}</div></div>`;
}

function renderDashboard(rawData) {
  if (!state.accountsLoaded) return;
  state.overviewReady = true;
  $("#overview-loading").hidden = true;
  $("#attention").hidden = false;
  $("#dash-content").hidden = false;
  renderAttention();
  const el = $("#dash-content");
  const data = rawData || {};
  const metrics = normalizeUsage(data?.totals);

  const width = el.clientWidth || 1200;
  const windowLabel = usageWindowLabel(
    data.windowMs ?? state.dashboardWindowMs
  );
  el.innerHTML = [
    kpisHtml(metrics, normalizeUsage(data.previousTotals), windowLabel),
    requestChartHtml(data, width),
    `<div class="tables">${providerTableHtml(data, metrics)}${topKeysHtml(data, metrics)}</div>`,
  ].join("");

  const plot = el.querySelector(".plot");
  if (plot?.querySelector(".plot-svg")) {
    let frame = 0;
    let pointerX = 0;
    plot.addEventListener("pointermove", (event) => {
      pointerX = event.clientX;
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        showChartHover(plot, pointerX);
      });
    });
    plot.addEventListener("pointerleave", () => {
      cancelAnimationFrame(frame);
      frame = 0;
      hideChartHover(plot);
    });
  }
}

export {
  renderOAuthLoading,
  ACCOUNT_LOADING_HTML,
  DASHBOARD_LOADING_HTML,
  KEY_LOADING_HTML,
  SKELETON_HTML,
  menuHtml,
  renderAccounts,
  renderAttention,
  renderDashboard,
  renderKeys,
  renderOAuthFlow,
  renderUsageSlot,
  renderOpenCodeSetup,
  setupSnippet,
};
