import {
  isAccountVisible,
  isFreeTierAccount,
} from "./app-account-visibility.js";
import {
  $,
  accountUsageForId,
  escapeHtml,
  mutationAttributes,
  state,
  syncMutationControls,
} from "./app-core.js";
import {
  CODEX_PLAN_LABELS,
  DAY_MS,
  PROVIDERS,
  accountColumnsHtml,
  accountIssues,
  accountName,
  accountWindows,
  actionMutationAttributes,
  disclosureHeadingHtml,
  fact,
  formFoot,
  formRow,
  formatCompact,
  formatMetadataForInput,
  hasTraffic,
  hasTokenFailure,
  icon,
  isAccountServing,
  isOnHold,
  isRateLimited,
  isRateLimitedWithData,
  kbd,
  limitSeverity,
  needsReauthorization,
  providerName,
  providerStatusMap,
  reauthorizeDeadline,
  relativeTime,
  renderPreservingForm,
  renderWithMotion,
  requestsCellHtml,
  shortDate,
  syncFailureText,
  tokenStatus,
  untilText,
  usageFact,
  usageWindowLabel,
} from "./app-render-shared.js";
import {
  dailyTokensBodyHtml,
  hasDailyTokens,
  requestDailyTokens,
  requestUsageDetail,
} from "./app-usage.js";
import { renderAttention, usageSlotHtml } from "./app-usage-render.js";
import { resetCreditsDetail, resetOfferFor } from "./app-reset-credits.js";

// Rows show the main windows (5h, 7d); model-specific windows stay in the
// expanded row.
const mainWindows = (account) =>
  accountWindows(account)
    .filter((window) => !window.named)
    .slice(0, 2);

function bindingWindow(windows) {
  let binding = null;
  for (const window of windows) {
    if (!Number.isFinite(window.resetsAt)) continue;
    if (
      !binding ||
      window.percent > binding.percent ||
      (window.percent === binding.percent && window.resetsAt > binding.resetsAt)
    ) {
      binding = window;
    }
  }
  return binding;
}

function resetCountdown(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return "\u2014";
  const diff = timestamp - now;
  if (diff <= 0) return "now";
  if (diff < 60_000) return "in <1m";
  const minutes = Math.floor(diff / 60_000);
  if (diff < 3_600_000) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (diff < DAY_MS) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function limitMetersHtml(account, windows) {
  if (!windows.length) {
    if (account.quota?.error) {
      return `<span class="warn">${syncFailureText(account.quota)}</span>`;
    }
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

function limitSummaryText(account, windows) {
  if (!windows.length) {
    return account.quota?.error
      ? `<span class="warn">${syncFailureText(account.quota).toLowerCase()}</span>`
      : "";
  }
  return windows
    .map((window) => {
      const severity = limitSeverity(window.percent);
      const text = `${escapeHtml(window.label)} ${Math.round(window.percent)}%`;
      return severity ? `<span class="${severity}">${text}</span>` : text;
    })
    .join(" \u00b7 ");
}

function accountRowHtml(account, serving, grouped = false) {
  const name = accountName(account);
  const open = state.expandedAccountId === account.id;
  const issues = serving ? accountIssues(account) : [];
  let dot = "off";
  if (serving)
    dot = issues[0]?.severity || (account.isPrimary ? "primary" : "");
  const tokenNote =
    tokenStatus(account.expiresAt).class === "expired"
      ? "Token expired"
      : hasTokenFailure(account)
        ? "Reauthorize"
        : "";
  const windows = mainWindows(account);
  const reset = bindingWindow(windows);
  const resetSeverity = reset ? limitSeverity(reset.percent) : "";
  const countdown = resetCountdown(reset?.resetsAt);
  const usage = accountUsageForId(account.id);
  const phoneParts = [
    tokenNote && `<span class="err">${tokenNote}</span>`,
    limitSummaryText(account, windows),
    reset &&
      `<span class="${resetSeverity}">${escapeHtml(reset.label)} resets ${escapeHtml(countdown)}</span>`,
  ].filter(Boolean);
  const cursor = state.cursorAccountId === account.id ? " cursor" : "";
  const credits = resetOfferFor(account);
  const creditHint =
    serving && credits?.useful
      ? `<span class="tag">${credits.count} ${credits.noun}${credits.count === 1 ? "" : "s"}</span>`
      : "";

  return `<div class="row t-acc${open ? " open" : ""}${serving ? "" : " dim"}${cursor}" data-account-id="${account.id}" data-flip="account:${account.id}" tabindex="0" role="button" aria-expanded="${open}">
    <span class="name"><span class="dot ${dot}"></span><span class="ellipsis">${escapeHtml(name)}</span>${account.isPrimary ? '<span class="tag tag-primary">Primary</span>' : ""}${isFreeTierAccount(account) ? `<span class="tag">${grouped ? escapeHtml(providerName(account.provider)) : "Free"}</span>` : ""}${account.enabled === false ? '<span class="tag">Disabled</span>' : ""}${creditHint}${tokenNote ? `<span class="token-note err small d">${tokenNote}</span>` : ""}</span>
    <span class="meters d">${limitMetersHtml(account, windows)}</span>
    <span class="num d reset ${resetSeverity || "muted"}">${reset ? `<small>${escapeHtml(reset.label)}</small> ` : ""}${escapeHtml(countdown)}</span>
    <span class="num">${requestsCellHtml(usage)}</span>
    <button class="more" type="button" data-menu="account" data-account-id="${account.id}" aria-label="Actions for ${escapeHtml(name)}" aria-haspopup="menu" aria-expanded="false">${icon("more")}</button>
    <span class="l2">${phoneParts.join(" \u00b7 ")}</span>
  </div>${open ? accountDetailHtml(account) : ""}`;
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
  const windows = accountWindows(account);
  const reset = resetCreditsDetail(account, windows);
  if (!quota)
    return [
      fact("Rate limits", '<span class="muted">\u2014</span>', [
        "waiting for the first sync",
      ]),
      reset?.fallback,
    ];
  const facts = windows.map((window) => {
    const severity = limitSeverity(window.percent);
    return fact(
      escapeHtml(window.named ? window.label : `${window.label} window`),
      `<span class="${severity}">${Math.round(window.percent)}%</span>`,
      [escapeHtml(resetText(window)), reset?.window === window && reset.line],
      `<span class="bar${severity ? ` ${severity}` : ""}"><i style="width:${window.percent}%"></i></span>`
    );
  });
  if (isRateLimitedWithData(quota))
    facts.push(
      fact("Limit sync", '<span class="warn">Rate limited</span>', [
        `showing limits from ${escapeHtml(relativeTime(quota.fetchedAt))}`,
      ])
    );
  else if (isRateLimited(quota))
    facts.push(
      fact("Limit sync", '<span class="warn">Rate limited</span>', [
        "retrying automatically",
      ])
    );
  else if (quota.error)
    facts.push(
      `<div class="fact"><div class="fact-label">Limit sync</div><div class="fact-value err">Failed</div><div class="fact-sub clamp" title="${escapeHtml(quota.error)}">${escapeHtml(quota.error)}</div></div>`
    );
  else if (!facts.length)
    facts.push(fact("Rate limits", '<span class="muted">None reported</span>'));
  if (reset?.fallback) facts.push(reset.fallback);
  return facts;
}

function tokenFact(account) {
  const expired = tokenStatus(account.expiresAt).class === "expired";
  const refreshFailed =
    account.lastRefreshStatus && account.lastRefreshStatus !== "success";
  let value = "Active";
  if (account.enabled === false) value = "Disabled";
  else if (expired) value = '<span class="err">Expired</span>';
  else if (isOnHold(account))
    value = '<span class="err">Account on hold</span>';
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
  const deadline = reauthorizeDeadline(account);
  return fact("Token", value, [
    escapeHtml(expiry),
    refresh,
    deadline &&
      `<span class="warn">reauthorize by ${escapeHtml(shortDate(deadline))}</span>`,
  ]);
}

// Personal Claude organizations are named after the email, which is already
// shown on its own line.
function organizationLine(name, email, role) {
  const org = name && !(email && name.includes(email)) ? name : "";
  return [org, role?.replaceAll("_", " ")]
    .filter(Boolean)
    .map(escapeHtml)
    .join(" \u00b7 ");
}

function accountFact(account) {
  const data = account.quota?.data;
  const metadata = account.metadata || {};
  const profile = account.profile?.data;
  const added = account.createdAt
    ? `added ${shortDate(account.createdAt)}`
    : "";
  const id = account.accountId
    ? `<span class="mono" title="${escapeHtml(account.accountId)}">${escapeHtml(account.accountId)}</span>`
    : "";
  const email =
    metadata.email && metadata.email !== account.label
      ? escapeHtml(metadata.email)
      : "";
  if (account.provider === "claude") {
    const extra = data?.subscription?.extraUsage;
    const plan = data?.plan?.label || profile?.plan?.label;
    const signIn = metadata.oauthMode === "console" ? "Console" : "claude.ai";
    const checked = account.profile?.fetchedAt
      ? `checked ${relativeTime(account.profile.fetchedAt)}`
      : "";
    return fact(plan ? "Plan" : "Sign-in", escapeHtml(plan || signIn), [
      escapeHtml(
        [plan && signIn, plan && checked].filter(Boolean).join(" \u00b7 ")
      ),
      email,
      organizationLine(
        metadata.workspaceName ||
          metadata.organizationName ||
          profile?.organizationName,
        metadata.email,
        profile?.organizationRole
      ),
      extra?.isEnabled &&
        (typeof extra.utilization === "number"
          ? `extra usage on \u00b7 ${Math.round(extra.utilization)}% used`
          : "extra usage on"),
      id,
      added,
    ]);
  }
  const planType = data?.status?.planType || profile?.planType;
  const plan = CODEX_PLAN_LABELS[planType] || planType;
  const lifetime = data?.profile?.lifetimeTokens;
  return fact("Plan", escapeHtml(plan || "Unknown"), [
    profile?.structure === "workspace" &&
      profile.workspaceName &&
      escapeHtml(profile.workspaceName),
    email,
    typeof lifetime === "number" &&
      `${formatCompact(lifetime)} lifetime tokens`,
    id,
    added,
  ]);
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
    ${formFoot(`<button id="btn-save-account" class="btn btn-primary btn-sm" data-action="save-account" data-account-id="${account.id}" ${mutationAttributes("save-account", account.id)} type="button">Save</button>`, "cancel-edit-account")}
  </div>`;
}

// Limits read off proxied responses are as fresh as the account's traffic.
function limitsSourceText(quota) {
  const when = escapeHtml(relativeTime(quota.fetchedAt));
  return quota.source === "traffic"
    ? `<span title="Read from the provider's response to a proxied request">Limits from live traffic, ${when}</span>`
    : `Limits synced ${when}`;
}

function accountDetailHtml(account) {
  if (state.editingAccountId === account.id) return accountEditHtml(account);
  const supportsOAuth =
    account.provider === "codex" || account.provider === "claude";
  const button = (label, action, shortcut, cls = "btn btn-ghost btn-sm") =>
    `<button class="${cls}" data-action="${action}" data-account-id="${account.id}" ${actionMutationAttributes(action, account.id)} type="button">${label}${kbd(shortcut)}</button>`;
  const synced = account.quota?.fetchedAt
    ? `<span>${limitsSourceText(account.quota)}</span>`
    : "";
  const entering =
    state.enteringDetail === `account:${account.id}` ? " entering" : "";
  return `<div class="detail${entering}" data-detail-for="${account.id}" data-flip="detail:${account.id}">
    <div class="facts">${[
      ...limitFacts(account),
      tokenFact(account),
      usageFact(accountUsageForId(account.id), state.accountUsageWindowMs),
      accountFact(account),
    ].join("")}</div>
    ${hasDailyTokens(account.id) ? `<div class="daily-tokens" data-daily-for="${account.id}">${dailyTokensBodyHtml(account.id)}</div>` : ""}
    ${hasTraffic(accountUsageForId(account.id)) ? `<div class="usage-slot usage-grid" data-usage-for="account:${account.id}">${usageSlotHtml("account", account.id)}</div>` : ""}
    <div class="actions">
      ${(needsReauthorization(account) || reauthorizeDeadline(account)) && supportsOAuth ? button("Reauthorize", "reauthorize-account", "A", "btn btn-primary btn-sm") : ""}
      ${account.isPrimary ? "" : button("Make primary", "set-primary", "P")}
      ${button("Refresh token", "refresh-account", "R")}
      ${button("Edit", "edit-account", "E")}
      ${button("Remove", "delete-account", "Del", "btn btn-ghost btn-sm btn-remove")}
      <div class="right">${synced}<span class="collapse-hint">Collapse <span class="kbd">esc</span></span></div>
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
    <span class="group-name"><span class="cap">${escapeHtml(name)}</span><span class="muted small">${count}</span><button class="switch" type="button" role="switch" aria-checked="${enabled}" aria-label="${escapeHtml(name)} enabled" title="${enabled ? "Enabled" : "Disabled"}" data-action="toggle-provider" data-provider="${provider}" data-enabled="${enabled ? "false" : "true"}" ${mutationAttributes("toggle-provider", provider)}></button>${enabled ? "" : '<span class="tag">Disabled</span>'}</span>
    ${accountColumnsHtml(`Requests ${escapeHtml(usageWindowLabel(state.accountUsageWindowMs))}`)}
  </div>`;
}

function accountGroupsHtml(accounts, statuses) {
  const providers = [
    ...new Set([...PROVIDERS, ...accounts.map((account) => account.provider)]),
  ];
  return providers
    .map((provider) => {
      const rows = accounts
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
}

function freeTierGroupHtml(accounts, statuses) {
  if (!accounts.length) return "";
  const open = state.showFreeTier;
  const rows = open
    ? accounts
        .map((account) =>
          accountRowHtml(account, isAccountServing(account, statuses), true)
        )
        .join("")
    : "";
  return `<section class="free-tier-group" aria-label="Free tier accounts">
    ${disclosureHeadingHtml({ id: "free-tier", label: "Free tier", count: accounts.length, open, cursor: state.cursorAccountId, action: "toggle-free-tier", note: open ? "Shown in pickers" : "Hidden from pickers" })}
    <div id="free-tier-rows"${open ? "" : " hidden"}>${open ? '<p class="free-tier-hint">Visibility only. Routing is unchanged.</p>' : ""}${rows}</div>
  </section>`;
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
  const visible = [];
  const free = [];
  const keepIds = new Set([state.editingAccountId]);
  for (const account of matches) {
    const shown = isAccountVisible(account, {
      showFreeTier: Boolean(filter),
      keepIds,
      usage: accountUsageForId(account.id),
    });
    (shown ? visible : free).push(account);
  }
  const groups =
    accountGroupsHtml(visible, statuses) + freeTierGroupHtml(free, statuses);

  const list = $("#accounts-list");
  renderWithMotion(list, () => renderPreservingForm(list, groups), {
    anchor: state.motionAnchor,
  });
  syncMutationControls();
  const expanded = state.expandedAccountId;
  if (
    expanded &&
    expanded !== state.editingAccountId &&
    hasTraffic(accountUsageForId(expanded))
  ) {
    requestUsageDetail("account", expanded);
  }
  if (
    expanded &&
    expanded !== state.editingAccountId &&
    hasDailyTokens(expanded)
  ) {
    requestDailyTokens(expanded);
  }
}

function accountMenuItems(account) {
  const reset = resetOfferFor(account);
  const supportsOAuth =
    account.provider === "codex" || account.provider === "claude";
  return [
    reset?.canUse && {
      label: `Use ${reset.noun}`,
      action: "redeem-reset-credit",
      shortcut: "U",
    },
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
  if (isOnHold(account)) return "on hold";
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
    (account) =>
      (account.provider === "codex" || account.provider === "claude") &&
      isAccountVisible(account, {
        showFreeTier: state.showFreeTier,
        usage: accountUsageForId(account.id),
      })
  );
  if (!accounts.length) {
    el.innerHTML = '<p class="muted list-note">No accounts to reauthorize.</p>';
    return;
  }
  const flagged = accounts.filter(needsReauthorization);
  const others = accounts.filter((account) => !needsReauthorization(account));
  const shown = state.showAllReauthorize ? [...flagged, ...others] : flagged;
  const rows = shown.map((account) => {
    const reason = flagged.includes(account)
      ? reauthorizeReason(account)
      : providerName(account.provider);
    return `<button class="row reauth" type="button" aria-label="Reauthorize ${escapeHtml(accountName(account))}" data-action="reauthorize-account" data-account-id="${account.id}" ${mutationAttributes("reauthorize-account", account.id)}><span class="name"><span class="dot ${flagged.includes(account) ? "err" : ""}"></span><span class="ellipsis">${escapeHtml(accountName(account))}</span></span><span class="small ${flagged.includes(account) ? "err" : "muted"}">${escapeHtml(reason)}</span>${icon("chev")}</button>`;
  });
  if (others.length) {
    rows.push(
      `<button class="row reauth" type="button" data-action="toggle-reauthorize-all"><span class="muted">${state.showAllReauthorize ? "Show fewer" : `${others.length} other account${others.length === 1 ? "" : "s"}`}</span><span></span>${icon("chev")}</button>`
    );
  }
  el.innerHTML = rows.join("");
}

export { renderAccounts, accountMenuItems, bindingWindow, resetCountdown };
