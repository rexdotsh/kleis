const DEFAULT_KEY_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

const state = {
  token: sessionStorage.getItem("kleis_admin_token") || "",
  accounts: [],
  keys: [],
  keyUsageById: new Map(),
  keyUsageWindowMs: DEFAULT_KEY_USAGE_WINDOW_MS,
  activeOAuth: null,
  revealedKeyIds: new Set(),
  setupKeyId: null,
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

function firstUsableKey() {
  const now = Date.now();
  const active = state.keys.find(
    (key) => !key.revokedAt && (!key.expiresAt || key.expiresAt > now)
  );
  return (
    active || state.keys.find((key) => !key.revokedAt) || state.keys[0] || null
  );
}

function keyById(keyId) {
  return state.keys.find((key) => key.id === keyId) || null;
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

function usageSuccessRate(usage) {
  if (!usage?.requestCount) return null;
  return Math.round((usage.successCount / usage.requestCount) * 100);
}

function usageMapFromList(items) {
  const map = new Map();
  if (!Array.isArray(items)) return map;
  for (const u of items) {
    if (u?.apiKeyId) map.set(u.apiKeyId, u);
  }
  return map;
}

function switchToTab(name) {
  for (const t of $$(".tab"))
    t.classList.toggle("active", t.dataset.tab === name);
  for (const p of $$(".tab-panel"))
    p.classList.toggle("active", p.id === `panel-${name}`);
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

function accountCardHtml(account) {
  const s = tokenStatus(account.expiresAt);
  const name = account.label || account.accountId || account.id;
  const shortId =
    account.id.length > 12
      ? `${account.id.slice(0, 8)}...${account.id.slice(-4)}`
      : account.id;

  const setPrimaryBtn = account.isPrimary
    ? ""
    : `<button class="btn btn-ghost btn-sm" data-action="set-primary" data-account-id="${account.id}" type="button">set primary</button>`;

  const identityParts = [];
  if (account.accountId && account.accountId !== name) {
    identityParts.push(
      `<span class="card-meta-item"><span style="color:var(--text-tertiary)">account:</span> ${escapeHtml(account.accountId)}</span>`
    );
  }
  identityParts.push(
    `<span class="card-meta-item"><span style="color:var(--text-tertiary)">id:</span> ${escapeHtml(shortId)}</span>`
  );
  if (account.createdAt) {
    identityParts.push(
      `<span class="card-meta-item"><span style="color:var(--text-tertiary)">created:</span> ${escapeHtml(relativeTime(account.createdAt))}</span>`
    );
  }

  const meta = metadataHtml(account.metadata);

  return `<div class="card" data-account-id="${account.id}">
    <div class="card-top">
      <div class="card-identity">
        <span class="badge badge-${account.provider}">${account.provider}</span>
        <span class="card-label">${escapeHtml(name)}</span>
        ${account.isPrimary ? '<span class="badge badge-primary">primary</span>' : ""}
      </div>
      <div class="card-actions">
        ${setPrimaryBtn}
        <button class="btn btn-ghost btn-sm" data-action="refresh-account" data-account-id="${account.id}" type="button">refresh</button>
        <button class="btn btn-danger btn-sm" data-action="delete-account" data-account-id="${account.id}" type="button">delete</button>
      </div>
    </div>
    <div class="card-status">
      <span class="status-dot ${s.class}"></span>
      <span>${s.label}</span>
      <span class="dot-sep"></span>
      <span>${escapeHtml(expiryCountdown(account.expiresAt))}</span>
      ${account.lastRefreshAt ? `<span class="dot-sep"></span><span>refreshed ${escapeHtml(relativeTime(account.lastRefreshAt))}</span>` : ""}
      ${account.lastRefreshStatus && account.lastRefreshStatus !== "success" ? `<span class="dot-sep"></span><span style="color:var(--red)">${escapeHtml(account.lastRefreshStatus)}</span>` : ""}
    </div>
    <div class="card-meta">${identityParts.join("")}</div>
    ${meta ? `<div class="card-meta" style="margin-top:6px">${meta}</div>` : ""}
  </div>`;
}

function renderAccounts() {
  const { accounts } = state;
  $("#accounts-count").textContent = accounts.length
    ? `(${accounts.length})`
    : "";

  if (!accounts.length) {
    $("#accounts-list").innerHTML =
      '<div class="empty-state"><div class="empty-state-text">No provider accounts connected yet.</div><button class="btn btn-primary btn-sm" type="button" data-action="go-connect">connect a provider</button></div>';
    return;
  }

  $("#accounts-list").innerHTML = accounts.map(accountCardHtml).join("");
}

function keyCardHtml(key) {
  const revoked = !!key.revokedAt;
  const expired = !revoked && key.expiresAt && key.expiresAt < Date.now();
  const status = revoked ? "revoked" : expired ? "expired" : "active";
  const isRevealed = state.revealedKeyIds.has(key.id);
  const keyDisplay = isRevealed ? key.key : maskKey(key.key);
  const usage = usageForKey(key.id);
  const successRate = usageSuccessRate(usage);
  const windowLabel = usageWindowLabel(state.keyUsageWindowMs);

  const scopeBadges = key.providerScopes
    ? key.providerScopes
        .map((p) => `<span class="badge badge-${p}">${p}</span>`)
        .join(" ")
    : '<span style="color:var(--text-tertiary)">all providers</span>';

  const metaParts = [`<span class="card-meta-item">${scopeBadges}</span>`];

  if (usage?.requestCount) {
    metaParts.push(
      `<span class="card-meta-item">${usage.requestCount} reqs (${windowLabel})</span>`
    );
  }
  if (successRate !== null) {
    metaParts.push(
      `<span class="card-meta-item">${successRate}% success</span>`
    );
  }
  if (usage?.clientErrorCount) {
    metaParts.push(
      `<span class="card-meta-item" style="color:var(--amber)">${usage.clientErrorCount} 4xx</span>`
    );
  }
  if (usage?.serverErrorCount) {
    metaParts.push(
      `<span class="card-meta-item" style="color:var(--red)">${usage.serverErrorCount} 5xx</span>`
    );
  }
  if (usage?.avgLatencyMs) {
    metaParts.push(
      `<span class="card-meta-item">${usage.avgLatencyMs}ms avg</span>`
    );
  }
  if (usage?.maxLatencyMs) {
    metaParts.push(
      `<span class="card-meta-item">${usage.maxLatencyMs}ms max</span>`
    );
  }
  if (usage?.lastRequestAt) {
    metaParts.push(
      `<span class="card-meta-item">last req ${escapeHtml(relativeTime(usage.lastRequestAt))}</span>`
    );
  }
  if (!revoked && key.expiresAt) {
    metaParts.push(
      `<span class="card-meta-item"><span class="badge badge-${status}">${escapeHtml(expiryCountdown(key.expiresAt))}</span></span>`
    );
  }

  const providerUsageParts = [];
  if (usage?.providers?.length) {
    for (const pu of usage.providers) {
      const puRate = pu.requestCount
        ? Math.round((pu.successCount / pu.requestCount) * 100)
        : null;
      const ratePart = puRate !== null ? ` (${puRate}% ok)` : "";
      providerUsageParts.push(
        `<span class="card-meta-item"><span class="badge badge-${pu.provider}">${pu.provider}</span> ${pu.requestCount} reqs${ratePart}</span>`
      );
    }
  }

  return `<div class="card">
    <div class="card-top">
      <div class="card-identity">
        <span class="card-label">${escapeHtml(key.label || "untitled")}</span>
        <span class="badge badge-${status}">${status}</span>
      </div>
      <div class="card-actions">
        <button class="btn btn-ghost btn-sm" data-action="copy-key" data-key-id="${key.id}" type="button">copy</button>
        <button class="btn btn-ghost btn-sm" data-action="toggle-key" data-key-id="${key.id}" type="button">${isRevealed ? "hide" : "show"}</button>
        ${revoked ? "" : `<button class="btn btn-ghost btn-sm" data-action="rotate-key" data-key-id="${key.id}" type="button">rotate</button>`}
        ${revoked ? "" : `<button class="btn btn-danger btn-sm" data-action="revoke-key" data-key-id="${key.id}" type="button">revoke</button>`}
      </div>
    </div>
    <div class="card-key"><code>${escapeHtml(keyDisplay)}</code></div>
    <div class="card-meta">${metaParts.join("")}</div>
    ${providerUsageParts.length ? `<div class="card-meta" style="margin-top:6px">${providerUsageParts.join("")}</div>` : ""}
  </div>`;
}

function renderKeys() {
  const { keys } = state;
  $("#keys-count").textContent = keys.length ? `(${keys.length})` : "";

  if (!keys.length) {
    $("#keys-list").innerHTML =
      '<div class="empty-state"><div class="empty-state-text">No API keys created yet.</div><button class="btn btn-primary btn-sm" type="button" data-action="open-create-key">create one</button></div>';
    return;
  }

  const activeIds = new Set(keys.map((k) => k.id));
  for (const id of state.revealedKeyIds) {
    if (!activeIds.has(id)) state.revealedKeyIds.delete(id);
  }

  $("#keys-list").innerHTML = keys.map(keyCardHtml).join("");
}

function setupSnippetForKey(key) {
  if (!key) return "# create an API key to generate setup snippet";
  return [
    "# kleis models live under kleis/* alongside built-in providers",
    `export OPENCODE_MODELS_URL=${APP_ORIGIN}`,
    `export KLEIS_API_KEY=${key.key}`,
    "opencode models --refresh",
  ].join("\n");
}

function renderSetupSnippet() {
  const keySelect = $("#setup-key-select");
  const snippet = $("#setup-snippet");
  const copyBtn = $("#btn-copy-setup");
  if (!keySelect || !snippet || !copyBtn) return;

  const fallback = firstUsableKey();
  const selected =
    (state.setupKeyId ? keyById(state.setupKeyId) : null) || fallback;
  state.setupKeyId = selected?.id || null;

  keySelect.innerHTML = state.keys
    .map((key) => {
      const status = key.revokedAt
        ? "revoked"
        : key.expiresAt && key.expiresAt <= Date.now()
          ? "expired"
          : "active";
      const label = key.label || maskKey(key.key);
      const sel = key.id === state.setupKeyId ? " selected" : "";
      return `<option value="${key.id}"${sel}>${escapeHtml(label)} (${status})</option>`;
    })
    .join("");

  const hasKey = Boolean(selected);
  keySelect.disabled = !hasKey;
  copyBtn.disabled = !hasKey;
  snippet.textContent = setupSnippetForKey(selected);
}

function showKeyReveal(fullKey) {
  const reveal = document.createElement("div");
  reveal.className = "key-reveal";
  const value = document.createElement("span");
  value.className = "key-reveal-value";
  value.textContent = fullKey;
  reveal.append(value);
  const btn = document.createElement("button");
  btn.className = "btn btn-ghost btn-sm";
  btn.type = "button";
  btn.textContent = "copy";
  btn.addEventListener("click", () => copyToClipboard(fullKey, btn));
  reveal.append(btn);
  $("#keys-list").prepend(reveal);
  setTimeout(() => reveal.remove(), 30_000);
}

function renderOAuthFlow(data, provider) {
  const container = $("#oauth-flow-active");
  container.style.display = "block";

  const urlStep = `<div class="oauth-step"><span class="oauth-step-num">1</span><div><div style="margin-bottom:4px">Open the authorization page:</div><div class="oauth-url"><a href="${escapeHtml(data.authorizationUrl)}" target="_blank" rel="noopener">${escapeHtml(data.authorizationUrl)}</a></div></div></div>`;

  const instrStep = data.instructions
    ? `<div class="oauth-step"><span class="oauth-step-num">2</span><div><div class="oauth-instructions">${escapeHtml(data.instructions)}</div></div></div>`
    : "";

  const lastNum = data.instructions ? 3 : 2;
  const isDevice = data.method === "auto";

  const completeStep = isDevice
    ? '<div style="margin-bottom:8px">Once you have authorized, click complete:</div><button class="btn btn-primary" type="button" id="btn-oauth-complete">complete flow</button>'
    : '<div style="margin-bottom:8px">After authorizing, paste callback code or full callback URL:</div><input id="oauth-code" class="field-input" type="text" placeholder="code or callback URL" style="margin-bottom:8px"><button class="btn btn-primary" type="button" id="btn-oauth-complete">complete flow</button>';

  container.innerHTML = `<div class="oauth-flow-panel">
    <div class="oauth-flow-title">Active Flow: <span class="badge badge-${provider}">${provider}</span></div>
    ${urlStep}${instrStep}
    <div class="oauth-step"><span class="oauth-step-num">${lastNum}</span><div>${completeStep}</div></div>
  </div>`;

  $("#btn-oauth-complete").addEventListener("click", completeOAuth);
}

async function loadAccounts() {
  showLoading("accounts-list");
  try {
    state.accounts = (await api("/admin/accounts")).accounts || [];
    renderAccounts();
  } catch (e) {
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

    if (usageResult.status === "fulfilled") {
      if (typeof usageResult.value.windowMs === "number") {
        state.keyUsageWindowMs = usageResult.value.windowMs;
      }
      state.keyUsageById = usageMapFromList(usageResult.value.usage);
    } else {
      state.keyUsageById = new Map();
      toast("Failed to load API key usage", "error");
    }

    renderKeys();
    renderSetupSnippet();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function setPrimary(id) {
  const account = state.accounts.find((a) => a.id === id);
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
  const account = state.accounts.find((a) => a.id === id);
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

function openCreateKeyModal() {
  $("#key-label").value = "";
  $("#key-model-scopes").value = "";
  for (const cb of $$(".key-scope-provider")) cb.checked = false;
  $("#modal-create-key").classList.add("open");
}

async function createKey() {
  const label = $("#key-label").value.trim() || undefined;
  const providerScopes = Array.from($$(".key-scope-provider:checked")).map(
    (cb) => cb.value
  );
  const raw = $("#key-model-scopes").value.trim();
  const modelScopes = raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const body = { label };
  if (providerScopes.length) body.providerScopes = providerScopes;
  if (modelScopes) body.modelScopes = modelScopes;

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
    providerScopes: existing.providerScopes || undefined,
    modelScopes: existing.modelScopes || undefined,
  };
  if (existing.expiresAt && existing.expiresAt > Date.now()) {
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

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "copied";
    setTimeout(() => {
      btn.textContent = "copy";
    }, 2000);
  } catch {
    toast("Failed to copy", "error");
  }
}

function updateOAuthProviderUI() {
  const p = $("#oauth-provider").value;
  $("#oauth-copilot-opts").style.display = p === "copilot" ? "block" : "none";
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
  const accountId = $("#import-account-id").value.trim();
  const label = $("#import-label").value.trim();
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
  if (metadataRaw) {
    try {
      metadata = JSON.parse(metadataRaw);
    } catch {
      toast("Metadata must be valid JSON", "error");
      return;
    }
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
    sessionStorage.setItem("kleis_admin_token", token);
    enterApp();
  } catch {
    $("#login-error").textContent = "Invalid admin token";
    state.token = "";
  } finally {
    btn.disabled = false;
    btn.textContent = "authenticate";
  }
}

function enterApp() {
  $("#login-gate").classList.add("hidden");
  $("#app").classList.add("visible");
  loadAccounts();
  loadKeys();
}

function logout() {
  sessionStorage.removeItem("kleis_admin_token");
  state.token = "";
  state.accounts = [];
  state.keys = [];
  $("#login-gate").classList.remove("hidden");
  $("#app").classList.remove("visible");
  $("#login-token").value = "";
  $("#login-error").textContent = "";
}

$("#accounts-list").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  const accountId = button.dataset.accountId;

  if (action === "go-connect") {
    switchToTab("oauth");
    return;
  }
  if (!accountId) return;
  if (action === "set-primary") setPrimary(accountId);
  if (action === "refresh-account") refreshAccount(accountId);
  if (action === "delete-account") deleteAccount(accountId);
});

$("#keys-list").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  const keyId = button.dataset.keyId;

  if (action === "open-create-key") {
    openCreateKeyModal();
    return;
  }
  if (!keyId) return;

  if (action === "copy-key") {
    const key = keyById(keyId);
    if (key) copyToClipboard(key.key, button);
    else toast("Key unavailable", "error");
    return;
  }
  if (action === "toggle-key") {
    if (state.revealedKeyIds.has(keyId)) state.revealedKeyIds.delete(keyId);
    else state.revealedKeyIds.add(keyId);
    renderKeys();
    return;
  }
  if (action === "rotate-key") rotateKey(keyId, button);
  if (action === "revoke-key") revokeKey(keyId);
});

$("#login-btn").addEventListener("click", handleLogin);
$("#login-token").addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleLogin();
});
$("#btn-logout").addEventListener("click", logout);
$("#btn-refresh-accounts").addEventListener("click", loadAccounts);
$("#btn-refresh-keys").addEventListener("click", loadKeys);
$("#btn-create-key").addEventListener("click", openCreateKeyModal);
$("#btn-modal-create-key").addEventListener("click", createKey);
$("#btn-oauth-start").addEventListener("click", startOAuth);
$("#btn-import-account").addEventListener("click", importAccount);

$("#oauth-provider").addEventListener("change", updateOAuthProviderUI);
updateOAuthProviderUI();

$("#setup-key-select").addEventListener("change", (e) => {
  state.setupKeyId = e.target.value || null;
  renderSetupSnippet();
});

$("#btn-copy-setup").addEventListener("click", (e) => {
  const selected = state.setupKeyId
    ? keyById(state.setupKeyId)
    : firstUsableKey();
  if (!selected) {
    toast("Create an API key first", "error");
    return;
  }
  copyToClipboard(setupSnippetForKey(selected), e.currentTarget);
});

for (const tab of $$(".tab")) {
  tab.addEventListener("click", () => switchToTab(tab.dataset.tab));
}

for (const el of $$(".modal-close")) {
  el.addEventListener("click", () =>
    el.closest(".modal-backdrop").classList.remove("open")
  );
}
for (const backdrop of $$(".modal-backdrop")) {
  backdrop.addEventListener("click", (e) => {
    if (e.target !== backdrop) return;
    if (backdrop.id === "modal-confirm") resolveConfirm(false);
    else backdrop.classList.remove("open");
  });
}
$("#btn-confirm-cancel").addEventListener("click", () => resolveConfirm(false));
$("#btn-confirm-action").addEventListener("click", () => resolveConfirm(true));

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if ($("#modal-confirm").classList.contains("open")) {
    resolveConfirm(false);
    return;
  }
  for (const m of $$(".modal-backdrop.open")) m.classList.remove("open");
});

(async () => {
  const saved = sessionStorage.getItem("kleis_admin_token");
  if (!saved) return;
  $("#login-gate").classList.add("hidden");
  try {
    await verifyToken(saved);
    enterApp();
  } catch {
    sessionStorage.removeItem("kleis_admin_token");
    $("#login-gate").classList.remove("hidden");
  }
})();
