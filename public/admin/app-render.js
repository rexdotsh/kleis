import {
  $,
  accountById,
  accountUsageForId,
  activeKeysWithModelsUrl,
  api,
  cacheReadRate,
  cancelOAuthFlow,
  completeOAuth,
  copyToClipboard,
  escapeHtml,
  formatCompact,
  formatCount,
  hasUsageMetrics,
  isKeyActive,
  keyById,
  maskKey,
  modelsUrlForKey,
  normalizeUsage,
  openModal,
  relativeTime,
  state,
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
const shortDate = (timestamp) =>
  new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

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

function windowEntry(label, window) {
  const percent = window?.usedPercent ?? window?.utilization;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return {
    label,
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
          limit.primaryWindow
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
        windowEntry(limit.modelDisplayName || "Scoped 7d", {
          utilization: limit.percent,
          resetsAt: limit.resetsAt,
        })
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
      text: `${tightest.label} window at ${Math.round(tightest.percent)}%`,
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

function accountRowHtml(account, serving) {
  const name = accountName(account);
  const open = state.expandedAccountId === account.id;
  const issues = serving ? accountIssues(account) : [];
  const dot = serving ? issues[0]?.severity || "" : "off";
  const tightest = tightestWindow(account);
  const limitClass = tightest ? limitSeverity(tightest.percent) || "muted" : "";
  const limitText = tightest
    ? `${escapeHtml(tightest.label)} ${Math.round(tightest.percent)}%`
    : account.quota?.error
      ? "Sync failed"
      : "\u2014";
  const token = tokenCell(account);
  const usage = accountUsageForId(account.id);
  const phoneParts = [
    `<span class="${limitClass || (account.quota?.error ? "warn" : "")}">${limitText}</span>`,
    token.cls === "err"
      ? '<span class="err">token expired</span>'
      : `expires ${escapeHtml(token.text)}`,
  ];

  return `<div class="row t-acc${open ? " open" : ""}${serving ? "" : " dim"}" data-account-id="${account.id}" tabindex="0" role="button" aria-expanded="${open}">
    <span class="name"><span class="dot ${dot}"></span><span class="ellipsis">${escapeHtml(name)}</span>${account.isPrimary ? '<span class="tag">Primary</span>' : ""}${account.enabled === false ? '<span class="tag">Disabled</span>' : ""}</span>
    <span class="num d ${limitClass || (account.quota?.error ? "warn" : "muted")}">${limitText}</span>
    <span class="num d ${token.cls}">${escapeHtml(token.text)}</span>
    <span class="num">${requestsCellHtml(usage)}</span>
    <button class="more" type="button" data-menu="account" data-account-id="${account.id}" aria-label="Actions for ${escapeHtml(name)}" aria-haspopup="menu" aria-expanded="false">${icon("more")}</button>
    <span class="l2">${phoneParts.join(" \u00b7 ")}</span>
  </div>${open ? accountDetailHtml(account) : ""}`;
}

function dl(entries) {
  return `<dl class="dl">${entries
    .filter(Boolean)
    .map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`)
    .join("")}</dl>`;
}

function resetCreditsHtml(account) {
  const data = account.quota?.data;
  if (data?.provider !== "codex") return "";
  const credits = (data.resetCredits?.credits || [])
    .filter((credit) => credit.status === "available")
    .sort(
      (a, b) =>
        (quotaTimestamp(a.expiresAt) ?? Number.POSITIVE_INFINITY) -
        (quotaTimestamp(b.expiresAt) ?? Number.POSITIVE_INFINITY)
    );
  const available =
    data.resetCredits?.availableCount ?? data.status?.resetCreditsAvailable;
  const items = credits.map((credit) => {
    const expiry = quotaTimestamp(credit.expiresAt);
    const description =
      credit.description || "Consume a reset credit to restore limits";
    return `<button class="btn btn-sm" data-action="redeem-reset-credit" data-account-id="${account.id}" data-credit-id="${escapeHtml(credit.id)}" type="button" title="${escapeHtml(description)}">${escapeHtml(credit.title || "Restore limits")}</button><span class="muted small">${expiry ? `credit expires ${escapeHtml(untilText(expiry))}` : "credit does not expire"}</span>`;
  });
  if (!items.length && typeof available === "number" && available > 0) {
    items.push(
      `<button class="btn btn-sm" data-action="redeem-reset-credit" data-account-id="${account.id}" type="button" title="Consume a reset credit to restore limits">Restore limits${available > 1 ? ` (${available})` : ""}</button>`
    );
  }
  return items.length ? `<div class="credits">${items.join("")}</div>` : "";
}

function limitsHtml(account) {
  const quota = account.quota;
  if (!quota) return '<p class="muted">Waiting for the first sync</p>';
  const rows = accountWindows(account)
    .map((window) => {
      const severity = limitSeverity(window.percent);
      let reset = "";
      if (window.resetsAt) {
        reset =
          window.resetsAt > Date.now()
            ? `resets ${untilText(window.resetsAt)}`
            : "reset";
      } else if (window.percent === 0) {
        reset = "not started";
      }
      return `<span class="muted ellipsis" title="${escapeHtml(window.label)}">${escapeHtml(window.label)}</span><span class="bar${severity ? ` ${severity}` : ""}"><i style="width:${window.percent}%"></i></span><span class="num${severity ? ` ${severity}` : ""}">${Math.round(window.percent)}%</span><span class="muted ellipsis">${escapeHtml(reset)}</span>`;
    })
    .join("");
  const sync = quota.error
    ? `<p class="sync err" title="${escapeHtml(quota.error)}">Sync failed: ${escapeHtml(quota.error)}</p>`
    : `<p class="sync muted">Synced ${escapeHtml(relativeTime(quota.fetchedAt))}</p>`;
  return `${rows ? `<div class="win">${rows}</div>` : '<p class="muted">No limits reported</p>'}${resetCreditsHtml(account)}${sync}`;
}

function accountDetailHtml(account) {
  const token = tokenStatus(account.expiresAt);
  const reauthorize = needsReauthorization(account);
  let tokenState = token.class === "active" ? "Active" : "Unknown";
  if (account.enabled === false) tokenState = "Disabled";
  else if (reauthorize)
    tokenState = '<span class="err">Needs reauthorization</span>';
  const refreshFailed =
    account.lastRefreshStatus && account.lastRefreshStatus !== "success";

  const usage = normalizeUsage(accountUsageForId(account.id));
  const failed = failedCount(usage);
  const data = account.quota?.data;
  const plan =
    data?.provider === "codex"
      ? CODEX_PLAN_LABELS[data.status?.planType] || data.status?.planType
      : null;
  const extra = data?.subscription?.extraUsage;
  const email = account.metadata?.email;
  const supportsOAuth =
    account.provider === "codex" || account.provider === "claude";

  const tokenColumn = dl([
    ["Status", tokenState],
    [
      "Expires",
      account.expiresAt
        ? `<span class="${token.class === "expired" ? "err" : ""}">${escapeHtml(untilText(account.expiresAt))}</span>`
        : "\u2014",
    ],
    [
      "Refreshed",
      account.lastRefreshAt
        ? escapeHtml(relativeTime(account.lastRefreshAt))
        : "Never",
    ],
    refreshFailed && [
      "Last refresh",
      `<span class="err">${escapeHtml(account.lastRefreshStatus)}</span>`,
    ],
  ]);

  const usageColumn = dl([
    ["Requests", formatCount(usage.requestCount)],
    ["Success", successRateText(usage)],
    failed && ["Failed", `<span class="warn">${formatCount(failed)}</span>`],
    ["Rate-limited", formatCount(usage.rateLimitCount)],
    [
      "Avg latency",
      usage.avgLatencyMs ? `${formatCount(usage.avgLatencyMs)} ms` : "\u2014",
    ],
    usage.lastRequestAt && [
      "Last request",
      escapeHtml(relativeTime(usage.lastRequestAt)),
    ],
  ]);

  const accountColumn = dl([
    plan && ["Plan", escapeHtml(plan)],
    account.provider === "claude" && [
      "Sign-in",
      account.metadata?.oauthMode === "console" ? "Console" : "claude.ai",
    ],
    email && email !== account.label && ["Email", escapeHtml(email)],
    account.accountId && [
      "Account ID",
      `<span class="mono muted ellipsis" title="${escapeHtml(account.accountId)}">${escapeHtml(account.accountId)}</span>`,
    ],
    typeof data?.profile?.lifetimeTokens === "number" && [
      "Lifetime",
      `${formatCompact(data.profile.lifetimeTokens)} tokens`,
    ],
    extra?.isEnabled && [
      "Extra usage",
      typeof extra.utilization === "number"
        ? `On \u00b7 ${Math.round(extra.utilization)}% used`
        : "On",
    ],
    account.createdAt && ["Added", shortDate(account.createdAt)],
  ]);

  const button = (label, action, cls = "btn") =>
    `<button class="${cls}" data-action="${action}" data-account-id="${account.id}" type="button">${label}</button>`;

  return `<div class="detail" data-detail-for="${account.id}">
    <div class="detail-grid">
      <div><h4>Rate limits</h4>${limitsHtml(account)}</div>
      <div><h4>Token</h4>${tokenColumn}</div>
      <div><h4>Last ${escapeHtml(usageWindowLabel(state.accountUsageWindowMs))}</h4>${usageColumn}</div>
      <div><h4>Account</h4>${accountColumn}</div>
    </div>
    <div class="actions">
      ${reauthorize && supportsOAuth ? button("Reauthorize", "reauthorize-account") : ""}
      ${button("Refresh token", "refresh-account")}
      ${account.isPrimary ? "" : button("Make primary", "set-primary")}
      ${button("Edit", "edit-account")}
      ${button("Usage details", "account-usage")}
      ${button("Remove", "delete-account", "btn btn-ghost btn-remove")}
      <div class="right"><span>Collapse <span class="kbd">esc</span></span></div>
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

function groupHtml(provider, status, count) {
  const enabled = status?.enabled !== false;
  const name = providerName(provider);
  return `<div class="group"><span class="cap">${escapeHtml(name)}</span><span class="muted small">${count}</span>
    <div class="right">${enabled ? "Enabled" : "Disabled"}<button class="switch" type="button" role="switch" aria-checked="${enabled}" aria-label="${escapeHtml(name)} enabled" data-action="toggle-provider" data-provider="${provider}" data-enabled="${enabled ? "false" : "true"}"></button></div>
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
      '<div class="empty-state"><p>No accounts connected yet.</p><button class="btn btn-primary" type="button" data-action="go-connect">Connect an account</button></div>';
    return;
  }
  if (!matches.length) {
    $("#accounts-list").innerHTML =
      `<div class="empty-state"><p>No accounts match \u201c${escapeHtml(state.accountFilter.trim())}\u201d.</p></div>`;
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
      return `${groupHtml(provider, statuses.get(provider), rows.length)}<div class="group-rows">${rows
        .map((account) =>
          accountRowHtml(account, isAccountServing(account, statuses))
        )
        .join("")}</div>`;
    })
    .join("");

  $("#accounts-list").innerHTML =
    `<div class="row thead t-acc"><span>Account</span><span class="num d">Tightest limit</span><span class="num d">Token expires</span><span class="num">Requests ${escapeHtml(usageWindowLabel(state.accountUsageWindowMs))}</span><span></span></div>${groups}`;
}

function accountMenuItems(account) {
  const supportsOAuth =
    account.provider === "codex" || account.provider === "claude";
  return [
    { label: "Usage details", action: "account-usage", shortcut: "U" },
    { label: "Refresh token", action: "refresh-account", shortcut: "R" },
    supportsOAuth && {
      label: "Reauthorize",
      action: "reauthorize-account",
      shortcut: "A",
    },
    !account.isPrimary && {
      label: "Make primary",
      action: "set-primary",
      shortcut: "P",
    },
    { label: "Edit", action: "edit-account", shortcut: "E" },
    "separator",
    {
      label: "Remove",
      action: "delete-account",
      shortcut: "\u232b",
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

function keyScopeHtml(key) {
  const pinned = new Map();
  for (const accountId of key.accountScopes || []) {
    const account = accountById(accountId);
    if (account) pinned.set(account.provider, accountName(account));
  }
  const via = (provider) =>
    pinned.has(provider)
      ? ` <span class="muted">via ${escapeHtml(pinned.get(provider))}</span>`
      : "";
  const parts = key.providerScopes?.length
    ? key.providerScopes.map(
        (provider) => `${escapeHtml(providerName(provider))}${via(provider)}`
      )
    : [
        "All providers",
        ...Array.from(pinned.keys()).map(
          (provider) =>
            `<span class="muted">${escapeHtml(providerName(provider))}</span>${via(provider)}`
        ),
      ];
  const models = key.modelScopes?.length
    ? ` <span class="muted" title="${escapeHtml(key.modelScopes.join(", "))}">\u00b7 ${key.modelScopes.length} model${key.modelScopes.length === 1 ? "" : "s"}</span>`
    : "";
  return `${parts.join(", ")}${models}`;
}

function keyScopeText(key) {
  const providers = key.providerScopes?.length
    ? key.providerScopes.map(providerName).join(", ")
    : "All providers";
  return key.modelScopes?.length
    ? `${providers} \u00b7 ${key.modelScopes.length} model${key.modelScopes.length === 1 ? "" : "s"}`
    : providers;
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

function keyRowHtml(key) {
  const revoked = Boolean(key.revokedAt);
  const active = isKeyActive(key);
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
  const revealed = state.revealedKeyIds.has(key.id);
  const name = keyName(key);

  return `<div class="row t-key${active ? "" : " dim"}" data-key-id="${key.id}" tabindex="0" role="button" aria-label="Usage details for ${escapeHtml(name)}">
    <span class="name"><span class="dot ${dot}"></span><span class="ellipsis">${escapeHtml(name)}</span>${tag ? `<span class="tag${expiringSoon ? " warn" : ""}">${escapeHtml(tag)}</span>` : ""}</span>
    <span class="mono muted ellipsis d">${escapeHtml(maskKey(key.key))}</span>
    <span class="ellipsis d">${keyScopeHtml(key)}</span>
    <span class="num">${revoked && !metrics.requestCount ? '<span class="muted">\u2014</span>' : requestsCellHtml(usage)}</span>
    <span class="num muted d">${escapeHtml(lastUsed)}</span>
    <button class="more" type="button" data-menu="key" data-key-id="${key.id}" aria-label="Actions for ${escapeHtml(name)}" aria-haspopup="menu" aria-expanded="false">${icon("more")}</button>
    <span class="l2">${escapeHtml([maskKey(key.key), keyScopeText(key), metrics.lastRequestAt ? lastUsed : ""].filter(Boolean).join(" \u00b7 "))}</span>
  </div>${
    revealed
      ? `<div class="key-full"><code>${escapeHtml(key.key)}</code><button class="btn btn-ghost btn-sm" data-action="copy-key" data-key-id="${key.id}" type="button">Copy</button><button class="btn btn-ghost btn-sm" data-action="toggle-key" data-key-id="${key.id}" type="button">Hide</button></div>`
      : ""
  }`;
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

  let visible = showRevokedKeys ? keys : keys.filter((key) => !key.revokedAt);
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

  if (!keys.length) {
    $("#keys-list").innerHTML =
      '<div class="empty-state"><p>No API keys yet.</p><button class="btn btn-primary" type="button" data-action="open-create-key">Create a key</button></div>';
    return;
  }
  if (!visible.length) {
    $("#keys-list").innerHTML = filter
      ? `<div class="empty-state"><p>No keys match \u201c${escapeHtml(state.keyFilter.trim())}\u201d.</p></div>`
      : '<div class="empty-state"><p>No active API keys.</p><button class="btn btn-primary" type="button" data-action="open-create-key">Create a key</button></div>';
    return;
  }

  $("#keys-list").innerHTML =
    `<div class="row thead t-key"><span>Label</span><span class="d">Key</span><span class="d">Scope</span><span class="num">Requests ${escapeHtml(usageWindowLabel(state.keyUsageWindowMs))}</span><span class="num d">Last used</span><span></span></div>${visible.map(keyRowHtml).join("")}`;
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
    { label: "Usage details", action: "key-usage", shortcut: "U" },
    { label: "Edit", action: "edit-key", shortcut: "E" },
    !revoked && { label: "Rotate", action: "rotate-key", shortcut: "R" },
    "separator",
    revoked
      ? {
          label: "Delete",
          action: "delete-key",
          shortcut: "\u232b",
          danger: true,
        }
      : {
          label: "Revoke",
          action: "revoke-key",
          shortcut: "\u232b",
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
      const shortcut = item.shortcut === "\u232b" ? "Backspace" : item.shortcut;
      return `<button class="menu-item${item.danger ? " danger" : ""}" type="button" role="menuitem" data-action="${item.action}" data-${kind}-id="${id}" data-shortcut="${shortcut}"><span>${item.label}</span><span class="kbd">${item.shortcut}</span></button>`;
    })
    .join("");
}

/* Usage detail dialog */

const DETAIL_EMPTY_STATE_HTML =
  '<div class="empty-state"><p>No usage in this window.</p></div>';

const DETAIL_LOADING_HTML =
  '<div class="loading-indicator"><span class="spinner spinner-lg"></span></div>';

function renderDetailStats(totals) {
  const metrics = normalizeUsage(totals);
  const stats = [
    [formatCount(metrics.requestCount), "Requests"],
    [successRateText(metrics), "Success"],
    [formatCount(metrics.proxyErrorCount), "Proxy fails"],
    [formatCount(metrics.upstreamErrorCount), "Upstream fails"],
    [formatCount(metrics.clientErrorCount), "Other 4xx"],
    [formatCount(metrics.serverErrorCount), "5xx"],
    [formatCount(metrics.authErrorCount), "Auth errors"],
    [formatCount(metrics.rateLimitCount), "Rate-limited"],
    [`${formatCount(metrics.avgLatencyMs)} ms`, "Avg latency"],
    [`${formatCount(metrics.maxLatencyMs)} ms`, "Max latency"],
    [formatCompact(metrics.inputTotalTokens), "Input"],
    [formatCompact(metrics.inputTokens), "Input, uncached"],
    [formatCompact(metrics.outputTokens), "Output"],
    [formatCompact(metrics.reasoningTokens), "Reasoning"],
    [formatCompact(metrics.totalTokens), "Total tokens"],
    [formatCompact(metrics.cacheReadTokens), "Cache read"],
    [formatCompact(metrics.cacheWriteTokens), "Cache write"],
  ];
  let html = `<div class="detail-stats">${stats.map(([value, label]) => `<div><div class="detail-stat-value">${value}</div><div class="detail-stat-label">${label}</div></div>`).join("")}</div>`;
  if (metrics.lastRequestAt) {
    html += `<p class="muted small detail-last">Last request ${escapeHtml(new Date(metrics.lastRequestAt).toLocaleString())}</p>`;
  }
  return html;
}

const USAGE_TABLE_HEADERS = [
  "Requests",
  "OK",
  "Proxy fails",
  "Upstream fails",
  "429",
  "Avg ms",
  "Input",
  "Output",
  "Cache read",
  "Cache write",
];

const ENDPOINT_LEAD_COLS = [
  ["Provider", (row) => escapeHtml(providerName(row.provider))],
  ["Endpoint", (row) => escapeHtml(row.endpoint)],
];

const MODEL_LEAD_COLS = [
  ...ENDPOINT_LEAD_COLS,
  ["Model", (row) => `<code>${escapeHtml(row.model || "(none)")}</code>`],
];

function usageTableHtml(rows, leadCols) {
  const headers = [...leadCols.map((col) => col[0]), ...USAGE_TABLE_HEADERS];
  const dash = (value) => (value ? formatCount(value) : "\u2014");
  let html = `<table class="detail-table"><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>`;
  for (const row of rows) {
    const metrics = normalizeUsage(row);
    const lead = leadCols.map((col) => `<td>${col[1](row)}</td>`).join("");
    html += `<tr>${lead}<td>${formatCount(metrics.requestCount)}</td><td>${formatCount(metrics.successCount)}</td><td>${dash(metrics.proxyErrorCount)}</td><td>${dash(metrics.upstreamErrorCount)}</td><td>${dash(metrics.rateLimitCount)}</td><td>${formatCount(metrics.avgLatencyMs)}</td><td>${formatCompact(metrics.inputTokens)}</td><td>${formatCompact(metrics.outputTokens)}</td><td>${formatCompact(metrics.cacheReadTokens)}</td><td>${formatCompact(metrics.cacheWriteTokens)}</td></tr>`;
  }
  html += "</tbody></table>";
  return html;
}

function renderUsageTable(title, rows, leadCols) {
  if (!rows.length) return "";
  return `<h3 class="detail-section-title">${title}</h3><div class="table-scroll">${usageTableHtml(rows, leadCols)}</div>`;
}

function apiKeyDisplayHtml(apiKeyId) {
  const key = keyById(apiKeyId);
  if (key) return escapeHtml(keyName(key));
  return `<code>${escapeHtml(apiKeyId.slice(0, 8))}\u2026</code>`;
}

function renderKeyDetailBody(data) {
  if (!data.totals.requestCount) return DETAIL_EMPTY_STATE_HTML;
  return [
    renderDetailStats(data.totals),
    renderUsageTable("By endpoint", data.endpoints, ENDPOINT_LEAD_COLS),
    renderUsageTable("By model", data.models || [], MODEL_LEAD_COLS),
  ].join("");
}

function renderAccountDetailBody(data) {
  if (!data.totals.requestCount) return DETAIL_EMPTY_STATE_HTML;
  return [
    renderDetailStats(data.totals),
    renderUsageTable("By API key", data.apiKeys, [
      ["API key", (row) => apiKeyDisplayHtml(row.apiKeyId)],
    ]),
    renderUsageTable("By endpoint", data.endpoints, ENDPOINT_LEAD_COLS),
    renderUsageTable("By model", data.models || [], MODEL_LEAD_COLS),
  ].join("");
}

async function openUsageDetailModal({ title, path, renderBody }) {
  $("#key-detail-title").textContent = title;
  $("#key-detail-body").innerHTML = DETAIL_LOADING_HTML;
  openModal($("#modal-key-detail"), ".modal-close");

  try {
    const data = await api(path);
    $("#key-detail-body").innerHTML = renderBody(data);
  } catch (e) {
    $("#key-detail-body").innerHTML =
      `<div class="empty-state"><p class="err">${escapeHtml(e.message)}</p></div>`;
  }
}

async function openKeyDetail(keyId) {
  const key = keyById(keyId);
  await openUsageDetailModal({
    title: `${key ? keyName(key) : keyId} \u00b7 last ${usageWindowLabel(state.keyUsageWindowMs)}`,
    path: `/admin/keys/${keyId}/usage?windowMs=${state.keyUsageWindowMs}`,
    renderBody: renderKeyDetailBody,
  });
}

async function openAccountDetail(accountId) {
  const account = accountById(accountId);
  const name = account ? accountName(account) : accountId;
  await openUsageDetailModal({
    title: `${account ? `${providerName(account.provider)} \u00b7 ` : ""}${name} \u00b7 last ${usageWindowLabel(state.accountUsageWindowMs)}`,
    path: `/admin/accounts/${accountId}/usage?windowMs=${state.accountUsageWindowMs}`,
    renderBody: renderAccountDetailBody,
  });
}

/* OpenCode setup and new keys */

function setupSnippet(key) {
  if (!key) {
    return [
      "# No active API keys with a models URL.",
      "# Create an API key first, then reopen this dialog.",
    ].join("\n");
  }

  const modelsUrl = modelsUrlForKey(key);
  return [
    "# Terminal",
    `export OPENCODE_MODELS_URL="${modelsUrl}"`,
    "opencode models --refresh",
    "opencode",
    "",
    "# Inside OpenCode",
    "/connect",
    "# provider: kleis",
    `# token: ${key.key}`,
  ].join("\n");
}

function openSetupModal() {
  const select = $("#setup-key-select");
  const snippet = $("#setup-snippet");
  if (!select || !snippet) return;

  const keys = activeKeysWithModelsUrl();
  select.innerHTML = keys.length
    ? keys
        .map(
          (key) =>
            `<option value="${key.id}">${escapeHtml(keyName(key))}</option>`
        )
        .join("")
    : '<option value="">No active keys</option>';

  snippet.textContent = setupSnippet(keys[0] ?? null);
  openModal($("#modal-opencode-setup"), "#setup-key-select");
}

function showKeyReveal(fullKey) {
  const container = $("#key-reveal");
  const reveal = document.createElement("div");
  reveal.className = "key-reveal";
  const label = document.createElement("span");
  label.className = "muted";
  label.textContent = "New key";
  const value = document.createElement("code");
  value.className = "key-reveal-value";
  value.textContent = fullKey;
  const copy = document.createElement("button");
  copy.className = "btn btn-sm";
  copy.type = "button";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => copyToClipboard(fullKey, copy));
  const dismiss = document.createElement("button");
  dismiss.className = "btn btn-ghost btn-sm";
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => reveal.remove());
  reveal.append(label, value, copy, dismiss);
  container.replaceChildren(reveal);
  setTimeout(() => reveal.remove(), 60_000);
}

/* Connect */

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
  if (!el) return;
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

const timeLabel = (timestamp) =>
  new Date(timestamp).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

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
  if (!size || !buckets.length) return "";
  const windowMs = data.windowMs ?? state.dashboardWindowMs;
  const end =
    typeof data.now === "number" ? data.now : buckets.at(-1).bucketStart + size;
  const since = typeof data.since === "number" ? data.since : end - windowMs;
  const first = Math.floor(since / size) * size;
  const last = Math.floor((end - 1) / size) * size;
  const slots = [];
  for (let at = first; at <= last; at += size) slots.push(at);
  if (slots.length < 2) return "";

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
  const day = at.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
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
  if (!providers.length) return "";
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

  return `<div><div class="sh"><h2>By provider</h2></div><div class="list"><div class="row thead t-prov"><span>Provider</span><span class="num">Requests</span><span class="num">Share</span><span class="num d">Tokens</span><span class="num d">Cached</span></div>${rows}</div></div>`;
}

function topKeysHtml(data, metrics) {
  const rows = (data.byKey || []).slice(0, 5);
  if (!rows.length) return "";
  const body = rows
    .map((row) => {
      const share = metrics.requestCount
        ? ((row.requestCount / metrics.requestCount) * 100).toFixed(1)
        : "0.0";
      return `<div class="row t-keys"><span class="ellipsis">${apiKeyDisplayHtml(row.apiKeyId)}</span><span class="num">${formatCount(row.requestCount)}</span><span class="num muted">${share}%</span></div>`;
    })
    .join("");
  return `<div><div class="sh"><h2>Top keys</h2><div class="right"><button class="link small" type="button" data-action="go-keys">View all keys</button></div></div><div class="list"><div class="row thead t-keys"><span>Key</span><span class="num">Requests</span><span class="num">Share</span></div>${body}</div></div>`;
}

function renderDashboard(data) {
  renderAttention();
  const el = $("#dash-content");
  const metrics = normalizeUsage(data?.totals);
  if (!data?.totals || !hasUsageMetrics(metrics)) {
    el.innerHTML =
      '<div class="empty-state"><p>No usage in this window.</p></div>';
    return;
  }

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
  if (plot) {
    plot.addEventListener("pointermove", (event) =>
      showChartHover(plot, event.clientX)
    );
    plot.addEventListener("pointerleave", () => hideChartHover(plot));
  }
}

export {
  DETAIL_LOADING_HTML,
  menuHtml,
  openAccountDetail,
  openKeyDetail,
  openSetupModal,
  renderAccounts,
  renderAttention,
  renderDashboard,
  renderKeys,
  renderOAuthFlow,
  setupSnippet,
  showKeyReveal,
};
