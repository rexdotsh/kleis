import {
  ACCOUNT_LOADING_HTML,
  DASHBOARD_LOADING_HTML,
  KEY_LOADING_HTML,
  renderAccounts,
  renderAttention,
  renderDashboard,
  renderKeys,
  renderOAuthFlow,
  renderUsageSlot,
} from "./app-render.js";

const DEFAULT_KEY_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const USAGE_DETAIL_TTL_MS = 30_000;
const ADMIN_TOKEN_STORAGE_KEY = "kleis_admin_token";
const PROVIDER_ORDER = ["codex", "claude"];

const readPersistedToken = () =>
  localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "";

function persistToken(token) {
  localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
}

function clearPersistedToken() {
  localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}

const state = {
  token: readPersistedToken(),
  sessionActive: false,
  dashboardAbort: null,
  accountUsageRequestSeq: 0,
  keyUsageRequestSeq: 0,
  accounts: [],
  accountsById: new Map(),
  providerStatuses: [],
  accountUsageById: new Map(),
  accountUsageWindowMs: DEFAULT_KEY_USAGE_WINDOW_MS,
  keys: [],
  keysById: new Map(),
  keyUsageById: new Map(),
  keyUsageWindowMs: DEFAULT_KEY_USAGE_WINDOW_MS,
  keysLoaded: false,
  showRevokedKeys: false,
  keyFilter: "",
  accountFilter: "",
  expandedAccountId: null,
  showAllReauthorize: false,
  expandedKeyId: null,
  cursorAccountId: null,
  cursorKeyId: null,
  enteringDetail: null,
  editingKeyId: null,
  editingAccountId: null,
  creatingKey: false,
  openSnippets: new Set(),
  usageDetails: new Map(),
  activeOAuth: null,
  reauthorizeAccountId: null,
  oauthRequestSeq: 0,
  accountsRequestSeq: 0,
  keysRequestSeq: 0,
  revealedKeyIds: new Set(),
  dashboardWindowMs: DEFAULT_KEY_USAGE_WINDOW_MS,
  dashboardData: null,
  dashboardLoading: false,
  dashboardRequestSeq: 0,
  pendingResetRedemptions: new Map(),
};

const APP_ORIGIN = window.location.origin;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401 && state.sessionActive) {
    logout();
    $("#login-error").textContent = "Your session ended. Sign in again.";
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const retryAfter = res.headers.get("Retry-After");
    if (res.status === 429 && retryAfter) {
      throw new Error(
        `${body?.message || "Too many requests"}. Retry in ${retryAfter}s`
      );
    }
    const error = new Error(body?.message || `Request failed (${res.status})`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

function toast(message, type = "success", action = null) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const text = document.createElement("span");
  text.textContent = message;
  el.append(text);
  const dismiss = () => {
    el.classList.add("removing");
    setTimeout(() => el.remove(), 180);
  };
  if (action) {
    const button = document.createElement("button");
    button.className = "toast-action";
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      dismiss();
      action.run();
    });
    el.append(button);
  }
  const container = $("#toast-container");
  const last = container.lastElementChild;
  if (last && el.style)
    el.style.bottom = `${(Number.parseFloat(last.style.bottom) || 0) + last.offsetHeight + 8}px`;
  container.appendChild(el);
  setTimeout(dismiss, action ? 6000 : 3500);
}

function setButtonBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  if (busy) button.classList.add("is-busy");
  else button.classList.remove("is-busy");
  button.setAttribute?.("aria-busy", String(busy));
}

let confirmResolve = null;
let confirmAnchor = null;
let confirmReturnFocus = null;

function setConfirmAnchor(element) {
  confirmAnchor = element;
}

function positionPopover(popover, anchor) {
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
  if (!rect?.width) {
    popover.style.left = `${Math.max(8, (innerWidth - width) / 2) + scrollX}px`;
    popover.style.top = `${innerHeight * 0.2 + scrollY}px`;
    return;
  }
  const left =
    rect.left + width <= innerWidth - 8
      ? rect.left
      : Math.max(8, rect.right - width);
  const below = rect.bottom + 6;
  const top =
    below + height > innerHeight - 8
      ? Math.max(8, rect.top - height - 6)
      : below;
  popover.style.left = `${left + scrollX}px`;
  popover.style.top = `${top + scrollY}px`;
}

function showConfirm(
  title,
  message,
  actionLabel = "Confirm",
  { extrasHtml = "", danger = false } = {}
) {
  if (confirmResolve) resolveConfirm(false);
  return new Promise((resolve) => {
    confirmResolve = resolve;
    const popover = $("#confirm");
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    $("#confirm-extras").innerHTML = extrasHtml;
    const action = $("#btn-confirm-action");
    action.textContent = actionLabel;
    action.className = `btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`;
    confirmReturnFocus = confirmAnchor;
    popover.hidden = false;
    positionPopover(popover, confirmAnchor);
    popover.focus();
  });
}

function resolveConfirm(value) {
  const popover = $("#confirm");
  const wasOpen = popover.hidden === false;
  popover.hidden = true;
  if (confirmResolve) {
    confirmResolve(value);
    confirmResolve = null;
  }
  if (wasOpen && confirmReturnFocus?.isConnected) confirmReturnFocus.focus();
  confirmReturnFocus = null;
}

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
  return formatShortDate(ts);
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

function keyById(keyId) {
  return state.keysById.get(keyId) || null;
}

function accountById(accountId) {
  return state.accountsById.get(accountId) || null;
}

function isKeyActive(key) {
  if (key.revokedAt) return false;
  if (key.expiresAt && key.expiresAt < Date.now()) return false;
  return true;
}

function modelsUrlForKey(key) {
  if (!key) return null;
  if (typeof key.scopedModelsUrl === "string" && key.scopedModelsUrl.trim()) {
    return key.scopedModelsUrl;
  }
  if (
    typeof key.modelsDiscoveryToken === "string" &&
    key.modelsDiscoveryToken.trim()
  ) {
    return `${APP_ORIGIN}/api/${key.modelsDiscoveryToken}`;
  }
  return null;
}

function accountUsageForId(accountId) {
  return state.accountUsageById.get(accountId) || null;
}

function usageForKey(keyId) {
  return state.keyUsageById.get(keyId) || null;
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

function formatShortDate(timestamp) {
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

function syncDashboardWindowButtons() {
  for (const btn of $$("#dash-window-selector .dash-window-btn")) {
    btn.classList.toggle(
      "active",
      Number(btn.dataset.window) === state.dashboardWindowMs
    );
  }
}

function syncAccountWindowButtons() {
  for (const btn of $$("#accounts-window-selector .dash-window-btn")) {
    btn.classList.toggle(
      "active",
      Number(btn.dataset.window) === state.accountUsageWindowMs
    );
  }
}

function syncKeyWindowButtons() {
  for (const btn of $$("#keys-window-selector .dash-window-btn")) {
    btn.classList.toggle(
      "active",
      Number(btn.dataset.window) === state.keyUsageWindowMs
    );
  }
}

function normalizeUsage(rawUsage) {
  const usage = rawUsage || {};
  const requestCount = usageNumber(usage.requestCount);
  const successCount = usageNumber(usage.successCount);
  const clientErrorCount = usageNumber(usage.clientErrorCount);
  const serverErrorCount = usageNumber(usage.serverErrorCount);
  const authErrorCount = usageNumber(usage.authErrorCount);
  const rateLimitCount = usageNumber(usage.rateLimitCount);
  const proxyErrorCount = usageNumber(usage.proxyErrorCount);
  const upstreamErrorCount = usageNumber(usage.upstreamErrorCount);
  const avgLatencyMs = usageNumber(usage.avgLatencyMs);
  const maxLatencyMs = usageNumber(usage.maxLatencyMs);
  const inputTokens = usageNumber(usage.inputTokens);
  const inputTotalTokens = usageNumber(
    usage.inputTotalTokens ??
      inputTokens +
        usageNumber(usage.cacheReadTokens) +
        usageNumber(usage.cacheWriteTokens)
  );
  const outputTokens = usageNumber(usage.outputTokens);
  const reasoningTokens = usageNumber(usage.reasoningTokens);
  const cacheReadTokens = usageNumber(usage.cacheReadTokens);
  const cacheWriteTokens = usageNumber(usage.cacheWriteTokens);
  const successRate =
    typeof usage.successRate === "number" && Number.isFinite(usage.successRate)
      ? Math.max(0, Math.min(100, Math.trunc(usage.successRate)))
      : null;
  const unclassifiedFailureCount = Math.max(
    0,
    clientErrorCount +
      serverErrorCount +
      authErrorCount -
      proxyErrorCount -
      upstreamErrorCount
  );

  return {
    requestCount,
    successCount,
    clientErrorCount,
    serverErrorCount,
    authErrorCount,
    rateLimitCount,
    proxyErrorCount,
    upstreamErrorCount,
    successRate,
    unclassifiedFailureCount,
    avgLatencyMs,
    maxLatencyMs,
    inputTokens,
    inputTotalTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: usageNumber(
      usage.totalTokens ?? inputTotalTokens + outputTokens
    ),
    lastRequestAt:
      typeof usage.lastRequestAt === "number" &&
      Number.isFinite(usage.lastRequestAt)
        ? usage.lastRequestAt
        : null,
  };
}

function hasUsageMetrics(metrics) {
  if (!metrics) return false;
  return (
    metrics.requestCount > 0 ||
    metrics.totalTokens > 0 ||
    metrics.cacheReadTokens > 0 ||
    metrics.cacheWriteTokens > 0 ||
    metrics.lastRequestAt !== null
  );
}

function usageMapFromList(items, idField) {
  const map = new Map();
  if (!Array.isArray(items)) return map;
  for (const u of items) {
    if (u?.[idField]) map.set(u[idField], u);
  }
  return map;
}

function switchToTab(name) {
  for (const t of $$(".tab")) {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
    t.tabIndex = active ? 0 : -1;
  }
  for (const p of $$(".tab-panel"))
    p.classList.toggle("active", p.id === `panel-${name}`);
  for (const control of $$(".top-ctl")) {
    control.hidden = control.dataset.for !== name;
  }
  history.replaceState(null, "", `#${name}`);
  // The chart is sized to its container, which has no width while hidden.
  if (name === "usage" && state.dashboardData && !state.dashboardLoading) {
    renderDashboard(state.dashboardData);
  }
}

function showLoading(containerId) {
  const el = $(`#${containerId}`);
  if (el && !el.querySelector(".skeleton")) {
    el.innerHTML =
      containerId === "accounts-list" ? ACCOUNT_LOADING_HTML : KEY_LOADING_HTML;
  }
}

function formatMetadataForInput(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "";
  }

  return JSON.stringify(metadata, null, 2);
}

const trimmedOrNull = (value) => value.trim() || null;

const parseCommaSeparatedList = (value) =>
  value
    ? Array.from(
        new Set(
          value
            .split(/[\n,]/)
            .map((item) => item.trim())
            .filter(Boolean)
        )
      )
    : [];

const checkedValues = (selector) =>
  Array.from($$(selector))
    .filter((input) => input.checked)
    .map((input) => input.value);

const KEY_SCOPE_FORMS = {
  create: {
    providerSelector: ".key-scope-provider",
    pinSelector: ".key-account-pin",
    accountSelector: ".key-scope-account",
    accountContainer: "#key-account-scopes",
  },
  edit: {
    providerSelector: ".edit-key-scope-provider",
    pinSelector: ".edit-key-account-pin",
    accountSelector: ".edit-key-scope-account",
    accountContainer: "#edit-key-account-scopes",
  },
};

const shortId = (value) =>
  value && value.length > 14
    ? `${value.slice(0, 8)}\u2026${value.slice(-4)}`
    : value || "";

const accountLabel = (account) =>
  account.label || account.accountId || shortId(account.id);

function renderAccountScopeOptions(mode, selectedAccountIds = []) {
  const container = $(KEY_SCOPE_FORMS[mode].accountContainer);
  if (container) {
    container.innerHTML = accountScopeOptionsHtml(mode, selectedAccountIds);
  }
}

function accountScopeOptionsHtml(mode, selectedAccountIds = []) {
  const config = KEY_SCOPE_FORMS[mode];
  const selectedIds = new Set(selectedAccountIds || []);
  const knownIds = new Set(state.accounts.map((account) => account.id));
  const unavailableIds =
    mode === "edit"
      ? Array.from(selectedIds).filter((id) => !knownIds.has(id))
      : [];
  if (!state.accounts.length && !unavailableIds.length) {
    return '<p class="field-hint">No accounts connected yet, so requests use each provider\u2019s primary account once one exists.</p>';
  }

  const pins = PROVIDER_ORDER.map((provider) => {
    const accounts = state.accounts
      .filter((account) => account.provider === provider)
      .sort(
        (left, right) =>
          Number(right.isPrimary) - Number(left.isPrimary) ||
          left.createdAt - right.createdAt
      );
    if (!accounts.length) return "";
    const primary = accounts.find((account) => account.isPrimary);
    const options = accounts
      .map(
        (account) =>
          `<option value="${account.id}"${selectedIds.has(account.id) ? " selected" : ""}>${escapeHtml(accountLabel(account))}${account.enabled === false ? " (disabled)" : ""}</option>`
      )
      .join("");
    return `<div class="pin-row" data-provider="${provider}">
        <span class="pin-provider">${providerLabel(provider)}</span>
        <select class="field-input ${config.pinSelector.slice(1)}" data-provider="${provider}" aria-label="${providerLabel(provider)} account">
          <option value="">Primary account${primary ? ` (${escapeHtml(accountLabel(primary))})` : ""}</option>
          ${options}
        </select>
      </div>`;
  }).join("");
  const preserved = unavailableIds
    .map(
      (id) =>
        `<label class="scope-check"><input type="checkbox" value="${escapeHtml(id)}" class="${config.accountSelector.slice(1)}" data-preserved-scope="true" checked> Keep the pin to ${escapeHtml(shortId(id))}, which is not in the loaded account list</label>`
    )
    .join("");
  return `${pins}${preserved}`;
}

function selectedProviderScopes(mode) {
  return checkedValues(KEY_SCOPE_FORMS[mode].providerSelector).filter(
    (value) => value !== "all"
  );
}

function selectedAccountScopes(mode) {
  const config = KEY_SCOPE_FORMS[mode];
  const pinned = Array.from($$(config.pinSelector))
    .filter((select) => select.value && !select.closest(".pin-row")?.hidden)
    .map((select) => select.value);
  return [...pinned, ...checkedValues(config.accountSelector)];
}

function syncScopedAccountAvailability(mode) {
  const config = KEY_SCOPE_FORMS[mode];
  const providers = new Set(selectedProviderScopes(mode));
  for (const select of $$(config.pinSelector)) {
    const allowed = !providers.size || providers.has(select.dataset.provider);
    const row = select.closest(".pin-row");
    if (row) row.hidden = !allowed;
    if (!allowed) select.value = "";
  }
}

function dateInputValue(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseOptionalJsonObject(raw, fieldLabel) {
  if (!raw) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${fieldLabel} must be valid JSON`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${fieldLabel} must be a JSON object`);
  }

  return parsed;
}

async function loadDashboard() {
  const el = $("#dash-content");
  const refreshButton = $("#btn-refresh-dash");
  const requestSeq = state.dashboardRequestSeq + 1;

  state.dashboardRequestSeq = requestSeq;
  state.dashboardLoading = true;
  state.dashboardAbort?.abort();
  const controller = new AbortController();
  state.dashboardAbort = controller;
  if (refreshButton) refreshButton.disabled = true;
  if (state.dashboardData) el.classList.add("is-loading");
  else el.innerHTML = DASHBOARD_LOADING_HTML;

  try {
    const data = await api(
      `/admin/usage/dashboard?windowMs=${state.dashboardWindowMs}`,
      { signal: controller.signal }
    );

    if (requestSeq !== state.dashboardRequestSeq) return;

    if (typeof data.windowMs === "number") {
      state.dashboardWindowMs = data.windowMs;
      syncDashboardWindowButtons();
    }

    state.dashboardData = data;
    renderDashboard(data);
  } catch (e) {
    if (requestSeq !== state.dashboardRequestSeq) return;
    const message = e instanceof Error ? e.message : "Failed to load usage";
    if (state.dashboardData) toast(message, "error");
    else {
      renderDashboard({});
      const plot = el.querySelector(".plot");
      if (plot)
        plot.innerHTML = `<p class="usage-note err">${escapeHtml(message)}</p>`;
    }
  } finally {
    if (requestSeq === state.dashboardRequestSeq) {
      state.dashboardLoading = false;
      el.classList.remove("is-loading");
      if (refreshButton) refreshButton.disabled = false;
    }
  }
}

function invalidateUsageDetails(kind) {
  for (const [key, entry] of state.usageDetails) {
    if (key.startsWith(`${kind}:`))
      state.usageDetails.set(key, {
        ...entry,
        status: entry.data ? "ready" : "stale",
        updatedAt: 0,
      });
  }
}

function pruneUsageDetails(kind, ids) {
  for (const key of state.usageDetails.keys()) {
    if (key.startsWith(`${kind}:`) && !ids.has(key.split(":")[1]))
      state.usageDetails.delete(key);
  }
}

async function requestUsageDetail(kind, id) {
  const windowMs =
    kind === "account" ? state.accountUsageWindowMs : state.keyUsageWindowMs;
  const cacheKey = `${kind}:${id}:${windowMs}`;
  const previous = state.usageDetails.get(cacheKey);
  if (
    previous?.status === "loading" ||
    Date.now() - (previous?.updatedAt || 0) < USAGE_DETAIL_TTL_MS
  )
    return;
  const pending = { status: "loading", data: previous?.data };
  state.usageDetails.set(cacheKey, pending);
  const token = state.token;
  let entry;
  try {
    const data = await api(
      `/admin/${kind === "account" ? "accounts" : "keys"}/${id}/usage?windowMs=${windowMs}`
    );
    entry = { status: "ready", data, updatedAt: Date.now() };
  } catch (e) {
    entry = {
      status: "error",
      error: e.message,
      data: previous?.data,
      updatedAt: Date.now(),
    };
  }
  if (token !== state.token || state.usageDetails.get(cacheKey) !== pending)
    return;
  state.usageDetails.set(cacheKey, entry);
  renderUsageSlot(kind, id);
}

async function loadAccounts() {
  const requestSeq = ++state.accountsRequestSeq;
  invalidateUsageDetails("account");
  if (!state.accounts.length) showLoading("accounts-list");
  try {
    const [accountsResult, usageResult] = await Promise.allSettled([
      api("/admin/accounts"),
      api(`/admin/accounts/usage?windowMs=${state.accountUsageWindowMs}`),
    ]);

    if (accountsResult.status !== "fulfilled") throw accountsResult.reason;
    if (requestSeq !== state.accountsRequestSeq) return;

    const accounts = accountsResult.value.accounts || [];
    const missingQuotas = new Set(
      accounts.filter((account) => !account.quota).map((account) => account.id)
    );
    state.accounts = accounts.map((account) => ({
      ...account,
      quota: account.quota || state.accountsById.get(account.id)?.quota,
    }));
    state.accountsById = usageMapFromList(state.accounts, "id");
    pruneUsageDetails("account", state.accountsById);
    state.providerStatuses = accountsResult.value.providers || [];

    if (usageResult.status === "fulfilled") {
      if (typeof usageResult.value.windowMs === "number") {
        state.accountUsageWindowMs = usageResult.value.windowMs;
      }
      state.accountUsageById = usageMapFromList(
        usageResult.value.usage,
        "providerAccountId"
      );
    } else {
      toast("Failed to load account usage", "error");
    }

    syncAccountWindowButtons();

    renderAccounts();
    if (state.keysLoaded) {
      renderKeys();
    }
    loadMissingQuotas(requestSeq, missingQuotas);
  } catch (e) {
    if (requestSeq !== state.accountsRequestSeq) return;
    if (!state.accounts.length)
      $("#accounts-list").innerHTML =
        `<div class="empty-state"><p class="err">${escapeHtml(e.message)}</p></div>`;
    toast(e.message, "error");
  }
}

// /admin/accounts returns cached limit snapshots without waiting on providers;
// accounts without one yet (after a deploy, or a new account) fill in here.
async function loadMissingQuotas(requestSeq, missingQuotas) {
  const missing = state.accounts.some(
    (account) =>
      (account.provider === "codex" || account.provider === "claude") &&
      (!account.quota || missingQuotas.has(account.id))
  );
  if (!missing) return;
  try {
    const { quotas } = await api("/admin/accounts/quotas");
    if (requestSeq !== state.accountsRequestSeq) return;
    let changed = false;
    for (const account of state.accounts) {
      const quota = quotas?.[account.id];
      if (quota) {
        account.quota = quota;
        changed = true;
      }
    }
    if (changed) renderAccounts();
  } catch (e) {
    if (requestSeq !== state.accountsRequestSeq) return;
    toast(`Failed to load account limits: ${e.message}`, "error");
  }
}

async function loadAccountUsage() {
  const requestSeq = ++state.accountUsageRequestSeq;
  try {
    const usage = await api(
      `/admin/accounts/usage?windowMs=${state.accountUsageWindowMs}`
    );
    if (requestSeq !== state.accountUsageRequestSeq) return;
    if (typeof usage.windowMs === "number") {
      state.accountUsageWindowMs = usage.windowMs;
      syncAccountWindowButtons();
    }
    state.accountUsageById = usageMapFromList(usage.usage, "providerAccountId");
    renderAccounts();
  } catch (e) {
    if (requestSeq !== state.accountUsageRequestSeq) return;
    toast(e.message, "error");
  }
}

async function loadKeyUsage() {
  const requestSeq = ++state.keyUsageRequestSeq;
  try {
    const usage = await api(
      `/admin/keys/usage?windowMs=${state.keyUsageWindowMs}`
    );
    if (requestSeq !== state.keyUsageRequestSeq) return;
    if (typeof usage.windowMs === "number") {
      state.keyUsageWindowMs = usage.windowMs;
      syncKeyWindowButtons();
    }
    state.keyUsageById = usageMapFromList(usage.usage, "apiKeyId");
    renderKeys();
  } catch (e) {
    if (requestSeq !== state.keyUsageRequestSeq) return;
    toast(e.message, "error");
  }
}

async function loadKeys() {
  const requestSeq = ++state.keysRequestSeq;
  invalidateUsageDetails("key");
  if (!state.keysLoaded) showLoading("keys-list");
  try {
    const [keysResult, usageResult] = await Promise.allSettled([
      api("/admin/keys"),
      api(`/admin/keys/usage?windowMs=${state.keyUsageWindowMs}`),
    ]);

    if (keysResult.status !== "fulfilled") throw keysResult.reason;
    if (requestSeq !== state.keysRequestSeq) return;

    state.keys = keysResult.value.keys || [];
    state.keysById = usageMapFromList(state.keys, "id");
    pruneUsageDetails("key", state.keysById);
    state.keysLoaded = true;

    if (usageResult.status === "fulfilled") {
      if (typeof usageResult.value.windowMs === "number") {
        state.keyUsageWindowMs = usageResult.value.windowMs;
      }
      state.keyUsageById = usageMapFromList(
        usageResult.value.usage,
        "apiKeyId"
      );
    } else {
      toast("Failed to load API key usage", "error");
    }

    syncKeyWindowButtons();
    renderKeys();
    if (state.dashboardData && !state.dashboardLoading) {
      renderDashboard(state.dashboardData);
    }
  } catch (e) {
    if (requestSeq !== state.keysRequestSeq) return;
    if (!state.keysLoaded)
      $("#keys-list").innerHTML =
        `<div class="empty-state"><p class="err">${escapeHtml(e.message)}</p></div>`;
    toast(e.message, "error");
  }
}

const markPrimary = (provider, id) => {
  for (const account of state.accounts) {
    if (account.provider === provider) account.isPrimary = account.id === id;
  }
};

// Switches at once and rolls back if the server refuses; the toast offers
// an undo instead of asking first.
async function setPrimary(id, { isUndo = false } = {}) {
  const account = accountById(id);
  if (!account || account.isPrimary) return;
  const previous = state.accounts.find(
    (candidate) =>
      candidate.provider === account.provider && candidate.isPrimary
  );
  const name = account.label || account.accountId || id;
  markPrimary(account.provider, id);
  renderAccounts();
  document
    .querySelector(`#accounts-list [data-account-id="${id}"] .dot.primary`)
    ?.classList.add("pop");
  try {
    await api(`/admin/accounts/${id}/primary`, { method: "POST" });
    toast(
      `${name} is now the primary ${providerLabel(account.provider)} account`,
      "success",
      previous && !isUndo
        ? {
            label: "Undo",
            run: () => setPrimary(previous.id, { isUndo: true }),
          }
        : null
    );
  } catch (e) {
    markPrimary(account.provider, previous?.id ?? null);
    renderAccounts();
    toast(e.message, "error");
  }
}

async function toggleProvider(provider, enabled) {
  if (!enabled) {
    const confirmed = await showConfirm(
      `Disable ${providerLabel(provider)}?`,
      `All ${providerLabel(provider)} accounts stop receiving proxy traffic and its models disappear from model registries. You can re-enable it at any time.`,
      "Disable",
      { danger: true }
    );
    if (!confirmed) return;
  }

  const status = state.providerStatuses.find(
    (entry) => entry.provider === provider
  );
  const previous = status?.enabled;
  if (status) status.enabled = enabled;
  document
    .querySelector(
      `[data-action="toggle-provider"][data-provider="${provider}"]`
    )
    ?.setAttribute("aria-checked", String(enabled));
  setTimeout(renderAccounts, 180);
  try {
    await api(`/admin/accounts/providers/${provider}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
    toast(`${providerLabel(provider)} ${enabled ? "enabled" : "disabled"}`);
    await loadAccounts();
  } catch (e) {
    if (status) status.enabled = previous;
    renderAccounts();
    toast(e.message, "error");
  }
}

async function deleteAccount(id) {
  const account = accountById(id);
  const name = account?.label || account?.accountId || id;
  const confirmed = await showConfirm(
    "Remove account?",
    `Remove "${name}" and its stored tokens. This cannot be undone.`,
    "Remove",
    { danger: true }
  );
  if (!confirmed) return;

  try {
    await api(`/admin/accounts/${id}`, { method: "DELETE" });
    toast("Account removed");
    await loadAccounts();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function refreshAccount(id) {
  const btn = document.querySelector(
    `[data-action="refresh-account"][data-account-id="${id}"]`
  );
  setButtonBusy(btn, true);
  try {
    await api(`/admin/accounts/${id}/refresh`, { method: "POST" });
    toast("Token refreshed");
    await loadAccounts();
  } catch (e) {
    toast(e.message, "error");
  } finally {
    setButtonBusy(btn, false);
  }
}

function resetResultToast(result) {
  const windows =
    typeof result?.windowsReset === "number" && result.windowsReset > 0
      ? ` (${result.windowsReset} window${result.windowsReset === 1 ? "" : "s"} reset)`
      : "";
  switch (result?.code) {
    case "reset":
      return { message: `Limits restored${windows}`, type: "success" };
    case "nothing_to_reset":
      return {
        message: "Nothing to reset - limits are already clear",
        type: "info",
      };
    case "no_credit":
      return {
        message: "No reset credit available on this account",
        type: "error",
      };
    case "already_redeemed":
      return { message: `Credit was already redeemed${windows}`, type: "info" };
    default:
      return {
        message: `Codex reset result: ${result?.code || "complete"}`,
        type: "info",
      };
  }
}

async function redeemResetCredit(accountId, creditId) {
  const account = accountById(accountId);
  const label = account?.label || account?.accountId || accountId;
  const redemptionKey = `${accountId}:${creditId || "auto"}`;
  const existingRequestId = state.pendingResetRedemptions.get(redemptionKey);
  const credit = account?.quota?.data?.resetCredits?.credits?.find(
    (entry) => entry.id === creditId
  );
  const creditName = credit?.title ? `"${credit.title}"` : "a reset credit";
  const confirmed = await showConfirm(
    "Reset Codex limits?",
    existingRequestId
      ? `Retry the pending reset for "${label}" with the same idempotency key?`
      : `Use ${creditName} on "${label}"? Its Codex rate limits reset upstream right away.`,
    existingRequestId ? "Retry reset" : "Use credit"
  );
  if (!confirmed) return;

  try {
    const body = {};
    if (creditId) body.creditId = creditId;
    if (existingRequestId) body.redeemRequestId = existingRequestId;
    const response = await api(
      `/admin/accounts/${accountId}/tracking/codex/reset-credits/consume`,
      { method: "POST", body: JSON.stringify(body) }
    );
    state.pendingResetRedemptions.delete(redemptionKey);
    const { message, type } = resetResultToast(response.result);
    toast(message, type);
    await loadAccounts();
  } catch (e) {
    const redeemRequestId = e.body?.redeemRequestId;
    if (redeemRequestId) {
      state.pendingResetRedemptions.set(redemptionKey, redeemRequestId);
      toast(
        "Reset status is ambiguous; the next retry will reuse its request ID",
        "error"
      );
      return;
    }
    toast(e.message, "error");
  }
}

function startEditAccount(id) {
  if (!accountById(id)) {
    toast("Account was not found", "error");
    return;
  }
  state.expandedAccountId = id;
  state.editingAccountId = id;
  renderAccounts();
  $("#edit-account-label")?.focus?.();
}

function cancelEditAccount() {
  state.editingAccountId = null;
  renderAccounts();
}

async function saveAccountEdits() {
  const saveButton = $("#btn-save-account");
  const accountId = state.editingAccountId;
  if (!accountId) {
    toast("Account was not found", "error");
    return;
  }

  const label = trimmedOrNull($("#edit-account-label").value);
  const editableAccountId = trimmedOrNull($("#edit-account-account-id").value);
  const metadataRaw = $("#edit-account-metadata").value.trim();

  let metadata;
  try {
    metadata = parseOptionalJsonObject(metadataRaw, "Metadata");
  } catch (error) {
    toast(error.message, "error");
    return;
  }

  setButtonBusy(saveButton, true);
  try {
    await api(`/admin/accounts/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify({
        label,
        accountId: editableAccountId,
        metadata,
      }),
    });
    state.editingAccountId = null;
    toast("Account updated");
    await loadAccounts();
  } catch (e) {
    toast(e.message, "error");
  } finally {
    setButtonBusy(saveButton, false);
  }
}

function startCreateKey() {
  state.creatingKey = true;
  renderKeys();
  $("#key-label")?.focus?.();
}

function cancelCreateKey() {
  state.creatingKey = false;
  renderKeys();
}

async function createKey() {
  const btn = $("#btn-submit-key");
  if (btn.disabled) return;
  const label = trimmedOrNull($("#key-label").value);
  const providerScopes = selectedProviderScopes("create");
  const accountScopes = selectedAccountScopes("create");
  const modelScopes = parseCommaSeparatedList($("#key-model-scopes").value);
  const body = {
    ...(label ? { label } : {}),
    ...(providerScopes.length ? { providerScopes } : {}),
    ...(accountScopes.length ? { accountScopes } : {}),
    ...(modelScopes.length ? { modelScopes } : {}),
  };

  setButtonBusy(btn, true);
  try {
    const data = await api("/admin/keys", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.creatingKey = false;
    state.expandedKeyId = data.key.id;
    state.revealedKeyIds.add(data.key.id);
    toast("API key created");
    await loadKeys();
  } catch (e) {
    toast(e.message, "error");
  } finally {
    setButtonBusy(btn, false);
  }
}

function startEditKey(id) {
  const key = keyById(id);
  if (!key) {
    toast("API key was not found", "error");
    return;
  }
  state.expandedKeyId = id;
  state.editingKeyId = id;
  renderKeys();
  renderAccountScopeOptions("edit", key.accountScopes);
  syncScopedAccountAvailability("edit");
  $("#edit-key-label")?.focus?.();
}

function cancelEditKey() {
  state.editingKeyId = null;
  renderKeys();
}

async function saveKeyEdits() {
  const saveButton = $("#btn-save-key");
  const keyId = state.editingKeyId;
  const existing = keyById(keyId);
  if (!existing) {
    toast("API key was not found", "error");
    return;
  }

  const label = trimmedOrNull($("#edit-key-label").value);
  const providerScopes = selectedProviderScopes("edit");
  const accountScopes = selectedAccountScopes("edit");
  const modelScopes = parseCommaSeparatedList(
    $("#edit-key-model-scopes").value
  );

  const body = {
    label,
    providerScopes: providerScopes.length ? providerScopes : null,
    accountScopes: accountScopes.length ? accountScopes : null,
    modelScopes: modelScopes.length ? modelScopes : null,
  };

  const expiresDate = $("#edit-key-expires-at").value.trim();
  const originalDate =
    existing.expiresAt == null ? "" : dateInputValue(existing.expiresAt);
  if (expiresDate !== originalDate) {
    if (expiresDate) {
      const parsedExpiresAt = new Date(`${expiresDate}T23:59:59`).getTime();
      if (!Number.isFinite(parsedExpiresAt)) {
        toast("Pick a valid expiry date", "error");
        return;
      }
      body.expiresAt = parsedExpiresAt;
    } else {
      body.expiresAt = null;
    }
  }

  setButtonBusy(saveButton, true);
  try {
    await api(`/admin/keys/${keyId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    state.editingKeyId = null;
    toast("API key updated");
    await loadKeys();
  } catch (e) {
    toast(e.message, "error");
  } finally {
    setButtonBusy(saveButton, false);
  }
}

async function rotateKey(id, button) {
  const existing = keyById(id);
  if (!existing) {
    toast("API key was not found", "error");
    return;
  }

  const label = existing.label || maskKey(existing.key);
  const confirmed = await showConfirm(
    "Rotate API key?",
    `Create a new key with the same settings as "${label}".`,
    "Rotate",
    {
      extrasHtml:
        '<label class="scope-check confirm-check"><input id="rotate-revoke-old" type="checkbox"> Revoke the old key afterwards</label>',
    }
  );
  if (!confirmed) return;

  const payload = {
    label: existing.label || undefined,
    providerScopes: existing.providerScopes?.length
      ? existing.providerScopes
      : undefined,
    accountScopes: existing.accountScopes?.length
      ? existing.accountScopes
      : undefined,
    modelScopes: existing.modelScopes?.length
      ? existing.modelScopes
      : undefined,
  };
  if (existing.expiresAt != null && existing.expiresAt > Date.now()) {
    payload.expiresAt = existing.expiresAt;
  }

  setButtonBusy(button, true);
  const revokeOld = $("#rotate-revoke-old")?.checked ?? false;
  let keyCreated = false;
  try {
    const data = await api("/admin/keys", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    keyCreated = true;
    state.expandedKeyId = data.key.id;
    state.revealedKeyIds.add(data.key.id);
    if (revokeOld) {
      await api(`/admin/keys/${id}/revoke`, { method: "POST" });
    }
    toast(
      revokeOld ? "API key rotated and previous key revoked" : "API key rotated"
    );
    await loadKeys();
  } catch (e) {
    if (keyCreated && revokeOld) {
      toast(
        `New key created, but old key revoke failed: ${e.message}`,
        "error"
      );
    } else {
      toast(e.message, "error");
    }
  } finally {
    setButtonBusy(button, false);
  }
}

async function revokeKey(id) {
  const key = keyById(id);
  const label = key?.label || maskKey(key?.key || id);
  const confirmed = await showConfirm(
    "Revoke API key?",
    `Clients using "${label}" stop working immediately. This cannot be undone.`,
    "Revoke",
    { danger: true }
  );
  if (!confirmed) return;

  try {
    await api(`/admin/keys/${id}/revoke`, { method: "POST" });
    toast("Key revoked");
    await loadKeys();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function deleteKey(id) {
  const key = keyById(id);
  const label = key?.label || maskKey(key?.key || id);
  const confirmed = await showConfirm(
    "Delete revoked key?",
    `Delete "${label}" and its usage history permanently. This cannot be undone.`,
    "Delete",
    { danger: true }
  );
  if (!confirmed) return;

  try {
    await api(`/admin/keys/${id}`, { method: "DELETE" });
    state.revealedKeyIds.delete(id);
    toast("Key deleted");
    await loadKeys();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function copyToClipboard(text, btn, confirmation = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    if (!btn?.isConnected) {
      toast(confirmation);
      return;
    }
    btn.dataset.confirmation = "Copied";
    btn.classList.add("copy-confirmed");
    setTimeout(() => {
      btn.classList.remove("copy-confirmed");
      delete btn.dataset.confirmation;
    }, 2000);
  } catch {
    toast("Failed to copy", "error");
  }
}

function providerLabel(provider) {
  return { codex: "Codex", claude: "Claude" }[provider] || provider || "";
}

function syncConnectControls() {
  for (const group of $$(".seg[data-select]")) {
    const select = $(`#${group.dataset.select}`);
    for (const option of group.querySelectorAll("button")) {
      const selected = option.dataset.value === select.value;
      option.classList.toggle("on", selected);
      option.setAttribute("aria-checked", String(selected));
      option.disabled = select.disabled;
    }
  }
}

function clearReauthorization() {
  if (state.activeOAuth) return;
  state.reauthorizeAccountId = null;
  $("#oauth-reauthorize-target").style.display = "none";
  $("#oauth-provider").disabled = false;
  $("#oauth-codex-mode").disabled = false;
  $("#oauth-claude-mode").disabled = false;
  $("#btn-oauth-clear-target").disabled = false;
  syncConnectControls();
}

function updateOAuthProviderUI() {
  if (state.activeOAuth) return;
  const p = $("#oauth-provider").value;
  clearReauthorization();
  $("#oauth-codex-opts").style.display = p === "codex" ? "block" : "none";
  $("#oauth-claude-opts").style.display = p === "claude" ? "block" : "none";
}

async function reauthorizeAccount(id) {
  const account = accountById(id);
  if (!account || !["codex", "claude"].includes(account.provider)) return;
  if (state.activeOAuth) {
    const confirmed = await showConfirm(
      "Replace active OAuth flow?",
      "The current authorization code will no longer work in this form.",
      "Start over"
    );
    if (!confirmed) return;
    cancelOAuthFlow();
  }
  if ($("#btn-oauth-start").disabled) cancelOAuthFlow();
  state.reauthorizeAccountId = id;
  const target = $("#oauth-reauthorize-target");
  $("#oauth-reauthorize-label").textContent =
    `Reauthorizing ${account.label || account.accountId || providerLabel(account.provider)}. Its settings and API-key scopes stay attached.${account.provider === "claude" ? " Sign in to the same Claude account and organization; Kleis cannot check this for you." : ""}`;
  target.style.display = "flex";
  $("#oauth-provider").value = account.provider;
  $("#oauth-provider").disabled = true;
  $("#oauth-codex-opts").style.display =
    account.provider === "codex" ? "block" : "none";
  $("#oauth-claude-opts").style.display =
    account.provider === "claude" ? "block" : "none";
  if (account.provider === "claude") {
    $("#oauth-claude-mode").value = account.metadata?.oauthMode || "max";
    $("#oauth-claude-mode").disabled = true;
  }
  syncConnectControls();
  switchToTab("oauth");
  toast(`Reauthorizing ${account.label || account.provider}`);
}

function cancelOAuthFlow() {
  state.oauthRequestSeq++;
  state.activeOAuth = null;
  $("#oauth-flow-active").style.display = "none";
  $("#oauth-flow-active").innerHTML = "";
  setButtonBusy($("#btn-oauth-start"), false);
  $("#btn-oauth-start").style.display = "";
  clearReauthorization();
}

async function startOAuth() {
  if (state.activeOAuth || $("#btn-oauth-start").disabled) return;
  const requestSeq = ++state.oauthRequestSeq;
  const provider = $("#oauth-provider").value;
  const btn = $("#btn-oauth-start");
  setButtonBusy(btn, true);
  btn.style.display = "none";
  const flow = $("#oauth-flow-active");
  flow.style.display = "block";
  flow.innerHTML =
    '<div class="flow"><div class="loading-indicator"><span class="spinner spinner-lg"></span></div></div>';

  try {
    const body = {};
    if (provider === "codex") {
      body.options = { mode: $("#oauth-codex-mode").value };
    } else if (provider === "claude") {
      body.options = { mode: $("#oauth-claude-mode").value };
    }

    if (state.reauthorizeAccountId) {
      const target = accountById(state.reauthorizeAccountId);
      if (target?.provider !== provider) {
        throw new Error("Reauthorization target does not match provider");
      }
      body.options = {
        ...body.options,
        replaceAccountId: state.reauthorizeAccountId,
      };
    }

    const data = await api(`/admin/accounts/${provider}/oauth/start`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (requestSeq !== state.oauthRequestSeq) return;
    const account = accountById(state.reauthorizeAccountId);
    state.activeOAuth = {
      provider,
      ...data,
      accountName:
        account?.label || account?.accountId || (account ? account.id : null),
      mode: body.options?.mode || null,
    };
    $("#oauth-provider").disabled = true;
    $("#oauth-codex-mode").disabled = true;
    $("#oauth-claude-mode").disabled = true;
    $("#btn-oauth-clear-target").disabled = true;
    syncConnectControls();
    renderOAuthFlow(data, provider);
  } catch (e) {
    if (requestSeq !== state.oauthRequestSeq) return;
    toast(e.message, "error");
    flow.innerHTML = `<div class="flow"><p class="err">${escapeHtml(e.message)}</p><button id="btn-oauth-retry" class="btn btn-ghost" type="button">Start over</button></div>`;
    $("#btn-oauth-retry").addEventListener?.("click", cancelOAuthFlow);
  } finally {
    if (requestSeq === state.oauthRequestSeq) {
      setButtonBusy(btn, Boolean(state.activeOAuth));
    }
  }
}

async function completeOAuth() {
  if (!state.activeOAuth) return;
  const requestSeq = state.oauthRequestSeq;
  const btn = $("#btn-oauth-complete");
  setButtonBusy(btn, true);

  try {
    const body = { state: state.activeOAuth.state };
    const codeInput = $("#oauth-code");
    if (codeInput) {
      const code = codeInput.value.trim();
      if (!code) throw new Error("Authorization code is required");
      body.code = code;
    }
    await api(`/admin/accounts/${state.activeOAuth.provider}/oauth/complete`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (requestSeq !== state.oauthRequestSeq) return;
    toast(
      state.reauthorizeAccountId ? "Account reauthorized" : "Account connected"
    );
    cancelOAuthFlow();
    switchToTab("accounts");
    await loadAccounts();
  } catch (e) {
    if (requestSeq !== state.oauthRequestSeq) return;
    const error = $("#oauth-flow-error");
    error.textContent = `${e.message}. If this code was consumed or the flow expired, cancel and start over.`;
    error.hidden = false;
    setButtonBusy(btn, false);
  }
}

async function importAccount() {
  const provider = $("#import-provider").value;
  const accessToken = $("#import-access-token").value.trim();
  const refreshToken = $("#import-refresh-token").value.trim();
  const expiresAtRaw = $("#import-expires-at").value.trim();
  const accountId = trimmedOrNull($("#import-account-id").value);
  const label = trimmedOrNull($("#import-label").value);
  const metadataRaw = $("#import-metadata").value.trim();

  if (!accessToken || !refreshToken) {
    toast("Access and refresh tokens are required", "error");
    return;
  }

  const expiresAt = expiresAtRaw
    ? Number(expiresAtRaw)
    : Date.now() + 60 * 60 * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    toast("Expires at must be a valid unix timestamp", "error");
    return;
  }

  let metadata;
  try {
    metadata = parseOptionalJsonObject(metadataRaw, "Metadata");
  } catch (error) {
    toast(error.message, "error");
    return;
  }

  const body = { accessToken, refreshToken, expiresAt };
  if (accountId) body.accountId = accountId;
  if (label) body.label = label;
  if (metadata) body.metadata = metadata;

  const btn = $("#btn-import-account");
  setButtonBusy(btn, true);
  try {
    await api(`/admin/accounts/${provider}/import`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    toast("Account imported");
    for (const id of [
      "import-access-token",
      "import-refresh-token",
      "import-expires-at",
      "import-account-id",
      "import-label",
      "import-metadata",
    ]) {
      $(`#${id}`).value = "";
    }
    switchToTab("accounts");
    await loadAccounts();
  } catch (e) {
    toast(e.message, "error");
  } finally {
    setButtonBusy(btn, false);
  }
}

async function verifyToken(token) {
  state.token = token;
  await api("/admin/session");
}

// A saved token opens the app at once; the check runs alongside the data
// requests. Only a rejected token ends the session (api() handles the 401);
// a restart, timeout or 5xx keeps the saved token.
async function restoreSession() {
  const saved = readPersistedToken();
  if (!saved) return;
  state.token = saved;
  enterApp();
  await api("/admin/session").catch(() => undefined);
}

async function handleLogin() {
  const token = $("#login-token").value.trim();
  if (!token) {
    $("#login-error").textContent = "Token is required";
    return;
  }
  const btn = $("#login-btn");
  setButtonBusy(btn, true);
  $("#login-error").textContent = "";
  try {
    await verifyToken(token);
    persistToken(token);
    enterApp();
  } catch (e) {
    $("#login-error").textContent =
      e?.status === 401
        ? "Invalid admin token"
        : `Could not reach Kleis: ${e?.message || "request failed"}`;
    clearPersistedToken();
    state.token = "";
  } finally {
    setButtonBusy(btn, false);
  }
}

function enterApp() {
  state.sessionActive = true;
  $("#login-gate").classList.add("hidden");
  $("#app").classList.add("visible");
  const hash = location.hash.slice(1);
  switchToTab(hash && $(`#panel-${hash}`) ? hash : "usage");
  syncDashboardWindowButtons();
  syncAccountWindowButtons();
  syncKeyWindowButtons();
  renderAttention();
  loadDashboard();
  loadAccounts();
  loadKeys();
}

function logout() {
  state.sessionActive = false;
  state.dashboardAbort?.abort();
  state.dashboardRequestSeq++;
  state.accountsRequestSeq++;
  state.keysRequestSeq++;
  cancelOAuthFlow();
  resolveConfirm(false);
  clearPersistedToken();
  state.token = "";
  state.accounts = [];
  state.accountsById = new Map();
  state.providerStatuses = [];
  state.accountUsageById = new Map();
  state.accountUsageWindowMs = DEFAULT_KEY_USAGE_WINDOW_MS;
  state.keys = [];
  state.keysById = new Map();
  state.keyUsageById = new Map();
  state.keyUsageWindowMs = DEFAULT_KEY_USAGE_WINDOW_MS;
  state.keysLoaded = false;
  state.showRevokedKeys = false;
  state.keyFilter = "";
  state.accountFilter = "";
  state.expandedAccountId = null;
  state.showAllReauthorize = false;
  state.expandedKeyId = null;
  state.cursorAccountId = null;
  state.cursorKeyId = null;
  state.editingKeyId = null;
  state.editingAccountId = null;
  state.creatingKey = false;
  state.openSnippets.clear();
  state.usageDetails = new Map();
  state.activeOAuth = null;
  state.reauthorizeAccountId = null;
  state.revealedKeyIds.clear();
  state.dashboardWindowMs = DEFAULT_KEY_USAGE_WINDOW_MS;
  state.dashboardData = null;
  state.dashboardLoading = false;
  $("#oauth-flow-active").style.display = "none";
  $("#oauth-flow-active").innerHTML = "";
  $("#dash-content").innerHTML = "";
  $("#attention").innerHTML = "";
  $("#accounts-filter").value = "";
  $("#keys-filter").value = "";
  syncDashboardWindowButtons();
  syncAccountWindowButtons();
  $("#login-gate").classList.remove("hidden");
  $("#app").classList.remove("visible");
  $("#login-token").value = "";
  $("#login-error").textContent = "";
}

export {
  $,
  $$,
  accountById,
  accountScopeOptionsHtml,
  accountUsageForId,
  api,
  cacheReadRate,
  cancelCreateKey,
  cancelEditAccount,
  cancelEditKey,
  cancelOAuthFlow,
  clearPersistedToken,
  clearReauthorization,
  completeOAuth,
  copyToClipboard,
  createKey,
  dateInputValue,
  deleteAccount,
  deleteKey,
  enterApp,
  escapeHtml,
  formatCompact,
  formatCount,
  formatMetadataForInput,
  formatShortDate,
  handleLogin,
  hasUsageMetrics,
  importAccount,
  isKeyActive,
  keyById,
  loadAccounts,
  loadAccountUsage,
  loadDashboard,
  loadKeys,
  loadKeyUsage,
  logout,
  maskKey,
  modelsUrlForKey,
  normalizeUsage,
  readPersistedToken,
  reauthorizeAccount,
  redeemResetCredit,
  refreshAccount,
  relativeTime,
  requestUsageDetail,
  resolveConfirm,
  restoreSession,
  revokeKey,
  rotateKey,
  saveAccountEdits,
  saveKeyEdits,
  setConfirmAnchor,
  setPrimary,
  startCreateKey,
  startEditAccount,
  startEditKey,
  startOAuth,
  state,
  switchToTab,
  syncAccountWindowButtons,
  syncConnectControls,
  syncDashboardWindowButtons,
  syncKeyWindowButtons,
  syncScopedAccountAvailability,
  toast,
  toggleProvider,
  tokenStatus,
  updateOAuthProviderUI,
  usageForKey,
  usageWindowLabel,
  verifyToken,
};
