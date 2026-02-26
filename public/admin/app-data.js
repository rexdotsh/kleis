import {
  DETAIL_LOADING_HTML,
  renderAccounts,
  renderDashboard,
  renderKeys,
  renderOAuthFlow,
  showKeyReveal,
} from "./app-render.js";

const DEFAULT_KEY_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const ADMIN_TOKEN_STORAGE_KEY = "kleis_admin_token";

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
  accounts: [],
  accountsById: new Map(),
  accountUsageById: new Map(),
  accountUsageWindowMs: DEFAULT_KEY_USAGE_WINDOW_MS,
  keys: [],
  keysById: new Map(),
  keyUsageById: new Map(),
  keyUsageWindowMs: DEFAULT_KEY_USAGE_WINDOW_MS,
  showRevokedKeys: false,
  activeOAuth: null,
  revealedKeyIds: new Set(),
  dashboardWindowMs: DEFAULT_KEY_USAGE_WINDOW_MS,
  dashboardData: null,
  dashboardLoading: false,
  dashboardRequestSeq: 0,
};

const APP_ORIGIN = window.location.origin;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  const res = await fetch(path, { ...options, headers });
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
    throw new Error(body?.message || `Request failed (${res.status})`);
  }
  return body;
}

function toast(message, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  $("#toast-container").appendChild(el);
  setTimeout(() => {
    el.classList.add("removing");
    setTimeout(() => el.remove(), 150);
  }, 3500);
}

let confirmResolve = null;

function showConfirm(title, message, actionLabel = "confirm", extrasHtml = "") {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    $("#confirm-extras").innerHTML = extrasHtml;
    $("#btn-confirm-action").textContent = actionLabel;
    $("#modal-confirm").classList.add("open");
  });
}

function resolveConfirm(value) {
  if (confirmResolve) {
    confirmResolve(value);
    confirmResolve = null;
  }
  $("#modal-confirm").classList.remove("open");
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
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function expiryCountdown(expiresAt) {
  if (!expiresAt) return "unknown";
  const seconds = Math.floor((expiresAt - Date.now()) / 1000);
  if (seconds <= 0) return "expired";
  if (seconds < 60) return `${seconds}s left`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m left`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h left`;
  return `${Math.floor(seconds / 86_400)}d left`;
}

function tokenStatus(expiresAt) {
  if (!expiresAt) return { label: "unknown", class: "unknown" };
  return expiresAt > Date.now()
    ? { label: "active", class: "active" }
    : { label: "expired", class: "expired" };
}

function maskKey(k) {
  return k.length <= 12 ? k : `${k.slice(0, 8)}...${k.slice(-4)}`;
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
  if (windowMs % 86_400_000 === 0) return `${windowMs / 86_400_000}d`;
  if (windowMs % 3_600_000 === 0) return `${windowMs / 3_600_000}h`;
  if (windowMs % 60_000 === 0) return `${windowMs / 60_000}m`;
  return `${Math.floor(windowMs / 1000)}s`;
}

function usageNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatCount(value) {
  return usageNumber(value).toLocaleString("en-US");
}

function formatCompact(n) {
  const v = usageNumber(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(v);
}

function cacheHitRate(inputTokens, cacheReadTokens) {
  const total = inputTokens + cacheReadTokens;
  return total > 0 ? Math.round((cacheReadTokens / total) * 100) : 0;
}

function formatBucketTime(ts, bucketSizeMs) {
  const d = new Date(ts);
  if (bucketSizeMs >= 86_400_000) {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  if (bucketSizeMs >= 3_600_000) {
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function syncDashboardWindowButtons() {
  for (const btn of $$("#dash-window-selector .dash-window-btn")) {
    btn.classList.toggle(
      "active",
      Number(btn.dataset.window) === state.dashboardWindowMs
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
  const avgLatencyMs = usageNumber(usage.avgLatencyMs);
  const maxLatencyMs = usageNumber(usage.maxLatencyMs);
  const inputTokens = usageNumber(usage.inputTokens);
  const outputTokens = usageNumber(usage.outputTokens);
  const cacheReadTokens = usageNumber(usage.cacheReadTokens);
  const cacheWriteTokens = usageNumber(usage.cacheWriteTokens);

  return {
    requestCount,
    successCount,
    clientErrorCount,
    serverErrorCount,
    authErrorCount,
    rateLimitCount,
    avgLatencyMs,
    maxLatencyMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: inputTokens + outputTokens,
    successRate: requestCount
      ? Math.round((successCount / requestCount) * 100)
      : null,
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

function usageMetaParts(
  usage,
  { windowLabel = null, includeMaxLatency = false } = {}
) {
  if (!usage) return [];
  const metrics = normalizeUsage(usage);
  const meta = (text, color) =>
    `<span class="card-meta-item"${color ? ` style="color:${color}"` : ""}>${text}</span>`;
  return [
    metrics.requestCount &&
      meta(
        `${formatCount(metrics.requestCount)} reqs${windowLabel ? ` (${windowLabel})` : ""}`
      ),
    metrics.successRate !== null && meta(`${metrics.successRate}% success`),
    metrics.clientErrorCount &&
      meta(
        `${formatCount(metrics.clientErrorCount)} 4xx other`,
        "var(--amber)"
      ),
    metrics.serverErrorCount &&
      meta(`${formatCount(metrics.serverErrorCount)} 5xx`, "var(--red)"),
    metrics.authErrorCount &&
      meta(`${formatCount(metrics.authErrorCount)} auth`, "var(--amber)"),
    metrics.rateLimitCount &&
      meta(`${formatCount(metrics.rateLimitCount)} 429`, "var(--amber)"),
    metrics.avgLatencyMs && meta(`${formatCount(metrics.avgLatencyMs)}ms avg`),
    includeMaxLatency &&
      metrics.maxLatencyMs &&
      meta(`${formatCount(metrics.maxLatencyMs)}ms max`),
    metrics.lastRequestAt &&
      meta(`last req ${escapeHtml(relativeTime(metrics.lastRequestAt))}`),
  ].filter(Boolean);
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
  for (const t of $$(".tab"))
    t.classList.toggle("active", t.dataset.tab === name);
  for (const p of $$(".tab-panel"))
    p.classList.toggle("active", p.id === `panel-${name}`);
  history.replaceState(null, "", `#${name}`);
}

function showLoading(containerId) {
  const el = $(`#${containerId}`);
  if (el && !el.querySelector(".loading-indicator")) {
    el.innerHTML =
      '<div class="loading-indicator"><span class="spinner spinner-lg"></span></div>';
  }
}

const METADATA_HIDDEN_KEYS = new Set([
  "provider",
  "idToken",
  "betaHeaders",
  "userAgent",
  "systemIdentity",
  "toolPrefix",
  "requestProfile",
  "tokenType",
  "scope",
]);

function metadataHtml(metadata) {
  if (!metadata || typeof metadata !== "object") return "";
  const entries = Object.entries(metadata).filter(([k, v]) => {
    if (METADATA_HIDDEN_KEYS.has(k)) return false;
    if (v === null || v === undefined || v === "") return false;
    if (Array.isArray(v) && !v.length) return false;
    return true;
  });
  if (!entries.length) return "";
  return entries
    .map(([k, v]) => {
      const display = Array.isArray(v) ? v.join(", ") : String(v);
      return `<span class="card-meta-item"><span style="color:var(--text-tertiary)">${escapeHtml(k)}:</span> ${escapeHtml(display)}</span>`;
    })
    .join("");
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
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

const checkedValues = (selector) =>
  Array.from($$(selector))
    .filter((input) => input.checked)
    .map((input) => input.value);

function setCheckedValues(selector, values) {
  const allowed = new Set(values || []);
  for (const input of $$(selector)) {
    input.checked = allowed.has(input.value);
  }
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

function activeKeysWithModelsUrl() {
  return state.keys.filter((k) => isKeyActive(k) && modelsUrlForKey(k));
}

async function loadDashboard() {
  const el = $("#dash-content");
  const refreshButton = $("#btn-refresh-dash");
  const requestSeq = state.dashboardRequestSeq + 1;

  state.dashboardRequestSeq = requestSeq;
  state.dashboardLoading = true;
  if (refreshButton) refreshButton.disabled = true;
  el.innerHTML = DETAIL_LOADING_HTML;

  try {
    const data = await api(
      `/admin/usage/dashboard?windowMs=${state.dashboardWindowMs}`
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
    state.dashboardData = null;
    const message = e instanceof Error ? e.message : "Failed to load usage";
    el.innerHTML = `<div class="dash-empty" style="color:var(--red)">${escapeHtml(message)}</div>`;
  } finally {
    if (requestSeq === state.dashboardRequestSeq) {
      state.dashboardLoading = false;
      if (refreshButton) refreshButton.disabled = false;
    }
  }
}

async function loadAccounts() {
  showLoading("accounts-list");
  try {
    const [accountsResult, usageResult] = await Promise.allSettled([
      api("/admin/accounts"),
      api(`/admin/accounts/usage?windowMs=${state.accountUsageWindowMs}`),
    ]);

    if (accountsResult.status !== "fulfilled") throw accountsResult.reason;

    state.accounts = accountsResult.value.accounts || [];
    state.accountsById = usageMapFromList(state.accounts, "id");

    if (usageResult.status === "fulfilled") {
      if (typeof usageResult.value.windowMs === "number") {
        state.accountUsageWindowMs = usageResult.value.windowMs;
      }
      state.accountUsageById = usageMapFromList(
        usageResult.value.usage,
        "providerAccountId"
      );
    } else {
      state.accountUsageById = new Map();
      toast("Failed to load account usage", "error");
    }

    renderAccounts();
  } catch (e) {
    state.accounts = [];
    state.accountsById = new Map();
    state.accountUsageById = new Map();
    $("#accounts-list").innerHTML =
      `<div class="empty-state"><div class="empty-state-text" style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
    toast(e.message, "error");
  }
}

async function loadKeys() {
  showLoading("keys-list");
  try {
    const [keysResult, usageResult] = await Promise.allSettled([
      api("/admin/keys"),
      api(`/admin/keys/usage?windowMs=${state.keyUsageWindowMs}`),
    ]);

    if (keysResult.status !== "fulfilled") throw keysResult.reason;

    state.keys = keysResult.value.keys || [];
    state.keysById = usageMapFromList(state.keys, "id");

    if (usageResult.status === "fulfilled") {
      if (typeof usageResult.value.windowMs === "number") {
        state.keyUsageWindowMs = usageResult.value.windowMs;
      }
      state.keyUsageById = usageMapFromList(
        usageResult.value.usage,
        "apiKeyId"
      );
    } else {
      state.keyUsageById = new Map();
      toast("Failed to load API key usage", "error");
    }

    renderKeys();
    if (state.dashboardData && !state.dashboardLoading) {
      renderDashboard(state.dashboardData);
    }
  } catch (e) {
    state.keys = [];
    state.keysById = new Map();
    state.keyUsageById = new Map();
    $("#keys-list").innerHTML =
      `<div class="empty-state"><div class="empty-state-text" style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
    toast(e.message, "error");
  }
}

async function setPrimary(id) {
  const account = accountById(id);
  const name = account?.label || account?.accountId || id;
  const confirmed = await showConfirm(
    "Set Primary Account",
    `Set "${name}" as the primary ${account?.provider || ""} account? Requests will be routed to this account.`,
    "set primary"
  );
  if (!confirmed) return;

  try {
    await api(`/admin/accounts/${id}/primary`, { method: "POST" });
    toast("Account set as primary");
    await loadAccounts();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function deleteAccount(id) {
  const account = accountById(id);
  const name = account?.label || account?.accountId || id;
  const confirmed = await showConfirm(
    "Delete Account",
    `Delete "${name}"? This will remove all stored tokens for this account. This cannot be undone.`,
    "delete"
  );
  if (!confirmed) return;

  try {
    await api(`/admin/accounts/${id}`, { method: "DELETE" });
    toast("Account deleted");
    await loadAccounts();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function refreshAccount(id) {
  const btn = document.querySelector(
    `[data-action="refresh-account"][data-account-id="${id}"]`
  );
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
  }
  try {
    await api(`/admin/accounts/${id}/refresh`, { method: "POST" });
    toast("Token refreshed");
    await loadAccounts();
  } catch (e) {
    toast(e.message, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "refresh";
    }
  }
}

function openEditAccountModal(id) {
  const account = accountById(id);
  if (!account) {
    toast("Account was not found", "error");
    return;
  }

  $("#edit-account-title").textContent = `Edit ${account.provider} Account`;
  $("#edit-account-label").value = account.label || "";
  $("#edit-account-account-id").value = account.accountId || "";
  $("#edit-account-metadata").value = formatMetadataForInput(account.metadata);
  $("#btn-modal-save-account").dataset.accountId = account.id;
  $("#modal-edit-account").classList.add("open");
}

async function saveAccountEdits() {
  const saveButton = $("#btn-modal-save-account");
  const accountId = saveButton?.dataset.accountId;
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

  const previousLabel = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.innerHTML = '<span class="spinner"></span> saving...';
  try {
    await api(`/admin/accounts/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify({
        label,
        accountId: editableAccountId,
        metadata,
      }),
    });
    $("#modal-edit-account").classList.remove("open");
    saveButton.dataset.accountId = "";
    toast("Account profile updated");
    await loadAccounts();
  } catch (e) {
    toast(e.message, "error");
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = previousLabel || "save";
  }
}

function openCreateKeyModal() {
  $("#key-label").value = "";
  $("#key-model-scopes").value = "";
  for (const cb of $$(".key-scope-provider")) cb.checked = false;
  $("#modal-create-key").classList.add("open");
}

async function createKey() {
  const label = trimmedOrNull($("#key-label").value);
  const providerScopes = checkedValues(".key-scope-provider");
  const modelScopes = parseCommaSeparatedList($("#key-model-scopes").value);
  const body = {
    ...(label ? { label } : {}),
    ...(providerScopes.length ? { providerScopes } : {}),
    ...(modelScopes.length ? { modelScopes } : {}),
  };

  try {
    const data = await api("/admin/keys", {
      method: "POST",
      body: JSON.stringify(body),
    });
    $("#modal-create-key").classList.remove("open");
    toast("API key created");
    showKeyReveal(data.key.key);
    await loadKeys();
  } catch (e) {
    toast(e.message, "error");
  }
}

function openEditKeyModal(id) {
  const key = keyById(id);
  if (!key) {
    toast("API key was not found", "error");
    return;
  }

  $("#edit-key-label").value = key.label || "";
  $("#edit-key-model-scopes").value = key.modelScopes?.join(", ") || "";
  $("#edit-key-expires-at").value =
    key.expiresAt === null ? "" : String(key.expiresAt);
  setCheckedValues(".edit-key-scope-provider", key.providerScopes);

  const saveButton = $("#btn-modal-save-key");
  saveButton.dataset.keyId = key.id;
  saveButton.dataset.originalExpiresAt =
    key.expiresAt === null ? "" : String(key.expiresAt);
  $("#modal-edit-key").classList.add("open");
}

async function saveKeyEdits() {
  const saveButton = $("#btn-modal-save-key");
  const keyId = saveButton?.dataset.keyId;
  if (!keyId) {
    toast("API key was not found", "error");
    return;
  }

  const label = trimmedOrNull($("#edit-key-label").value);
  const providerScopes = checkedValues(".edit-key-scope-provider");
  const modelScopes = parseCommaSeparatedList(
    $("#edit-key-model-scopes").value
  );

  const body = {
    label,
    providerScopes: providerScopes.length ? providerScopes : null,
    modelScopes: modelScopes.length ? modelScopes : null,
  };

  const expiresAtRaw = $("#edit-key-expires-at").value.trim();
  const originalExpiresAt = saveButton.dataset.originalExpiresAt || "";
  if (expiresAtRaw !== originalExpiresAt) {
    if (expiresAtRaw) {
      const parsedExpiresAt = Number(expiresAtRaw);
      if (!Number.isFinite(parsedExpiresAt) || parsedExpiresAt <= 0) {
        toast("Expires At must be a valid unix timestamp", "error");
        return;
      }
      body.expiresAt = parsedExpiresAt;
    } else {
      body.expiresAt = null;
    }
  }

  const previousLabel = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.innerHTML = '<span class="spinner"></span> saving...';
  try {
    await api(`/admin/keys/${keyId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    $("#modal-edit-key").classList.remove("open");
    saveButton.dataset.keyId = "";
    saveButton.dataset.originalExpiresAt = "";
    toast("API key updated");
    await loadKeys();
  } catch (e) {
    toast(e.message, "error");
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = previousLabel || "save";
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
    "Rotate API Key",
    `Create a new key with the same settings as "${label}".`,
    "rotate",
    '<label class="scope-check" style="margin-top:14px;margin-bottom:0"><input id="rotate-revoke-old" type="checkbox"> revoke old key after rotate</label>'
  );
  if (!confirmed) return;

  const payload = {
    label: existing.label || undefined,
    providerScopes: existing.providerScopes?.length
      ? existing.providerScopes
      : undefined,
    modelScopes: existing.modelScopes?.length
      ? existing.modelScopes
      : undefined,
  };
  if (existing.expiresAt != null && existing.expiresAt > Date.now()) {
    payload.expiresAt = existing.expiresAt;
  }

  const previousText = button.textContent;
  button.disabled = true;
  button.innerHTML = '<span class="spinner"></span>';
  const revokeOld = $("#rotate-revoke-old")?.checked ?? false;
  let keyCreated = false;
  try {
    const data = await api("/admin/keys", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    showKeyReveal(data.key.key);
    keyCreated = true;
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
    button.disabled = false;
    button.textContent = previousText || "rotate";
  }
}

async function revokeKey(id) {
  const key = keyById(id);
  const label = key?.label || maskKey(key?.key || id);
  const confirmed = await showConfirm(
    "Revoke API Key",
    `Revoke "${label}"? Any clients using this key will stop working immediately. This cannot be undone.`,
    "revoke"
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
    "Delete Revoked API Key",
    `Delete "${label}" permanently? This removes the key and its usage history. This cannot be undone.`,
    "delete"
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

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = "copied";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  } catch {
    toast("Failed to copy", "error");
  }
}

function updateOAuthProviderUI() {
  const p = $("#oauth-provider").value;
  $("#oauth-copilot-opts").style.display = p === "copilot" ? "block" : "none";
  $("#oauth-codex-opts").style.display = p === "codex" ? "block" : "none";
  $("#oauth-claude-opts").style.display = p === "claude" ? "block" : "none";
}

async function startOAuth() {
  const provider = $("#oauth-provider").value;
  const btn = $("#btn-oauth-start");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> starting...';

  try {
    const body = {};
    if (provider === "copilot") {
      const ed = $("#oauth-enterprise-domain").value.trim();
      if (ed) body.options = { enterpriseDomain: ed };
    } else if (provider === "codex") {
      body.options = { mode: $("#oauth-codex-mode").value };
    } else if (provider === "claude") {
      body.options = { mode: $("#oauth-claude-mode").value };
    }

    const data = await api(`/admin/accounts/${provider}/oauth/start`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.activeOAuth = { provider, ...data };
    renderOAuthFlow(data, provider);
    toast("OAuth flow started");
  } catch (e) {
    toast(e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "start oauth flow";
  }
}

async function completeOAuth() {
  if (!state.activeOAuth) return;
  const btn = $("#btn-oauth-complete");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> completing...';

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
    toast("Account connected");
    state.activeOAuth = null;
    $("#oauth-flow-active").style.display = "none";
    $("#oauth-flow-active").innerHTML = "";
    await loadAccounts();
    switchToTab("accounts");
  } catch (e) {
    toast(e.message, "error");
    btn.disabled = false;
    btn.innerHTML = "complete flow";
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
    toast("Expires At must be a valid unix timestamp", "error");
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
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> importing...';
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
    await loadAccounts();
    switchToTab("accounts");
  } catch (e) {
    toast(e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "import account";
  }
}

async function verifyToken(token) {
  state.token = token;
  await api("/admin/accounts");
}

async function handleLogin() {
  const token = $("#login-token").value.trim();
  if (!token) {
    $("#login-error").textContent = "Token is required";
    return;
  }
  const btn = $("#login-btn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  $("#login-error").textContent = "";
  try {
    await verifyToken(token);
    persistToken(token);
    enterApp();
  } catch {
    $("#login-error").textContent = "Invalid admin token";
    clearPersistedToken();
    state.token = "";
  } finally {
    btn.disabled = false;
    btn.textContent = "authenticate";
  }
}

function enterApp() {
  $("#login-gate").classList.add("hidden");
  $("#app").classList.add("visible");
  const hash = location.hash.slice(1);
  if (hash && $(`#panel-${hash}`)) switchToTab(hash);
  syncDashboardWindowButtons();
  loadDashboard();
  loadAccounts();
  loadKeys();
}

function logout() {
  clearPersistedToken();
  state.token = "";
  state.accounts = [];
  state.accountsById = new Map();
  state.accountUsageById = new Map();
  state.accountUsageWindowMs = DEFAULT_KEY_USAGE_WINDOW_MS;
  state.keys = [];
  state.keysById = new Map();
  state.keyUsageById = new Map();
  state.keyUsageWindowMs = DEFAULT_KEY_USAGE_WINDOW_MS;
  state.showRevokedKeys = false;
  state.activeOAuth = null;
  state.revealedKeyIds.clear();
  state.dashboardWindowMs = DEFAULT_KEY_USAGE_WINDOW_MS;
  state.dashboardData = null;
  state.dashboardLoading = false;
  state.dashboardRequestSeq = 0;
  $("#oauth-flow-active").style.display = "none";
  $("#oauth-flow-active").innerHTML = "";
  $("#dash-content").innerHTML = "";
  syncDashboardWindowButtons();
  $("#login-gate").classList.remove("hidden");
  $("#app").classList.remove("visible");
  $("#toggle-show-revoked-keys").checked = false;
  $("#login-token").value = "";
  $("#login-error").textContent = "";
}

export {
  $,
  $$,
  accountById,
  accountUsageForId,
  activeKeysWithModelsUrl,
  api,
  cacheHitRate,
  clearPersistedToken,
  completeOAuth,
  copyToClipboard,
  createKey,
  deleteAccount,
  deleteKey,
  enterApp,
  escapeHtml,
  expiryCountdown,
  formatBucketTime,
  formatCompact,
  formatCount,
  handleLogin,
  hasUsageMetrics,
  importAccount,
  isKeyActive,
  keyById,
  loadAccounts,
  loadDashboard,
  loadKeys,
  logout,
  maskKey,
  metadataHtml,
  modelsUrlForKey,
  normalizeUsage,
  openCreateKeyModal,
  openEditAccountModal,
  openEditKeyModal,
  readPersistedToken,
  refreshAccount,
  relativeTime,
  resolveConfirm,
  revokeKey,
  rotateKey,
  saveAccountEdits,
  saveKeyEdits,
  setPrimary,
  startOAuth,
  state,
  switchToTab,
  syncDashboardWindowButtons,
  toast,
  tokenStatus,
  updateOAuthProviderUI,
  usageForKey,
  usageMetaParts,
  usageWindowLabel,
  verifyToken,
};
