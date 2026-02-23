const state = {
  token: sessionStorage.getItem("kleis_admin_token") || "",
  accounts: [],
  keys: [],
  activeOAuth: null,
  revealedKeyIds: new Set(),
};
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

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
  if (!res.ok)
    throw new Error(body?.message || `Request failed (${res.status})`);
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

function relativeTime(ts) {
  if (!ts) return "never";
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function tokenStatus(expiresAt) {
  if (!expiresAt) return { label: "unknown", class: "unknown" };
  return expiresAt > Date.now()
    ? { label: "active", class: "active" }
    : { label: "expired", class: "expired" };
}

function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

function maskKey(k) {
  return k.length <= 12 ? k : `${k.slice(0, 8)}...${k.slice(-4)}`;
}

function switchToTab(name) {
  for (const t of $$(".tab"))
    t.classList.toggle("active", t.dataset.tab === name);
  for (const p of $$(".tab-panel"))
    p.classList.toggle("active", p.id === `panel-${name}`);
}

function meta(label, value) {
  return `<span class="card-meta-item"><span class="card-meta-label">${label}</span> <span class="card-meta-value">${value}</span></span>`;
}

function renderAccounts() {
  const { accounts } = state;
  $("#accounts-count").textContent = accounts.length
    ? `(${accounts.length})`
    : "";

  if (!accounts.length) {
    $("#accounts-list").innerHTML =
      `<div class="empty-state"><div class="empty-state-icon">&mdash;</div><div class="empty-state-text">No provider accounts connected yet.</div><button class="btn btn-primary btn-sm" type="button" onclick="switchToTab('oauth')">connect a provider</button></div>`;
    return;
  }

  $("#accounts-list").innerHTML = accounts
    .map((a) => {
      const s = tokenStatus(a.expiresAt);
      return `<div class="card" data-account-id="${a.id}"><div class="card-header"><div class="card-identity"><span class="status-dot ${s.class}"></span><span class="badge badge-${a.provider}">${a.provider}</span><span class="card-label">${escapeHtml(a.label || a.accountId || a.id)}</span>${a.isPrimary ? '<span class="badge badge-primary">primary</span>' : ""}</div><div class="card-actions">${a.isPrimary ? "" : `<button class="btn btn-ghost btn-sm" data-action="set-primary" data-account-id="${a.id}" type="button">set primary</button>`}<button class="btn btn-ghost btn-sm" data-action="refresh-account" data-account-id="${a.id}" type="button">refresh</button></div></div><div class="card-meta">${meta("status", `<span class="badge badge-${s.class}">${s.label}</span>`)}${meta("expires", a.expiresAt ? relativeTime(a.expiresAt) : "n/a")}${meta("last refresh", relativeTime(a.lastRefreshAt))}${a.lastRefreshStatus ? meta("refresh result", escapeHtml(a.lastRefreshStatus)) : ""}${meta("added", relativeTime(a.createdAt))}</div></div>`;
    })
    .join("");
}

function renderKeys() {
  const { keys } = state;
  $("#keys-count").textContent = keys.length ? `(${keys.length})` : "";

  if (!keys.length) {
    $("#keys-list").innerHTML =
      `<div class="empty-state"><div class="empty-state-icon">&mdash;</div><div class="empty-state-text">No API keys created yet.</div><button class="btn btn-primary btn-sm" type="button" onclick="openCreateKeyModal()">create one</button></div>`;
    return;
  }

  $("#keys-list").innerHTML = keys
    .map((k) => {
      const revoked = !!k.revokedAt;
      const expired = k.expiresAt && k.expiresAt < Date.now();
      const badge = revoked ? "revoked" : expired ? "expired" : "active";
      const fullKey = k.key;
      const isRevealed = state.revealedKeyIds.has(k.id);
      const keyValue = isRevealed ? fullKey : maskKey(fullKey);
      const revealAction = `<button class="btn btn-ghost btn-sm" data-action="toggle-key" data-key-id="${k.id}" type="button">${isRevealed ? "hide" : "show"}</button>`;
      const copyAction = `<button class="btn btn-ghost btn-sm" data-action="copy-key" data-key-id="${k.id}" type="button">copy</button>`;
      const scopes = k.providerScopes
        ? k.providerScopes
            .map((p) => `<span class="badge badge-${p}">${p}</span>`)
            .join(" ")
        : '<span style="color:var(--text-tertiary)">all</span>';
      const models = k.modelScopes
        ? k.modelScopes
            .map(
              (m) =>
                `<span style="color:var(--text-secondary)">${escapeHtml(m)}</span>`
            )
            .join(", ")
        : '<span style="color:var(--text-tertiary)">all</span>';
      return `<div class="card"><div class="card-header"><div class="card-identity"><span class="card-label">${escapeHtml(k.label || "untitled")}</span><span class="badge badge-${badge}">${badge}</span></div><div class="card-actions">${copyAction}${revealAction}${revoked ? "" : `<button class="btn btn-danger btn-sm" data-action="revoke-key" data-key-id="${k.id}" type="button">revoke</button>`}</div></div><div class="card-meta">${meta("key", `<span style="font-size:10px">${escapeHtml(keyValue)}</span>`)}${meta("providers", scopes)}${meta("models", models)}${meta("created", relativeTime(k.createdAt))}${k.expiresAt ? meta("expires", relativeTime(k.expiresAt)) : ""}</div></div>`;
    })
    .join("");
}

async function loadAccounts() {
  try {
    state.accounts = (await api("/admin/accounts")).accounts || [];
    renderAccounts();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function setPrimary(id) {
  try {
    await api(`/admin/accounts/${id}/primary`, { method: "POST" });
    toast("Account set as primary");
    await loadAccounts();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function refreshAccount(id) {
  const btn = document.querySelector(
    `[data-account-id="${id}"] .card-actions button:last-child`
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

async function loadKeys() {
  try {
    state.keys = (await api("/admin/keys")).keys || [];
    const activeIds = new Set(state.keys.map((key) => key.id));
    for (const keyId of state.revealedKeyIds) {
      if (!activeIds.has(keyId)) {
        state.revealedKeyIds.delete(keyId);
      }
    }
    renderKeys();
  } catch (e) {
    toast(e.message, "error");
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
    const reveal = document.createElement("div");
    reveal.className = "key-reveal";
    const revealValue = document.createElement("span");
    revealValue.className = "key-reveal-value";
    revealValue.textContent = data.key.key;
    reveal.append(revealValue);
    const copyButton = document.createElement("button");
    copyButton.className = "btn btn-ghost btn-sm";
    copyButton.type = "button";
    copyButton.textContent = "copy";
    copyButton.addEventListener("click", () =>
      copyToClipboard(data.key.key, copyButton)
    );
    reveal.append(copyButton);
    $("#keys-list").prepend(reveal);
    setTimeout(() => reveal.remove(), 30_000);
    await loadKeys();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function revokeKey(id) {
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
  $("#oauth-redirect-opts").style.display = p !== "copilot" ? "block" : "none";
  $("#oauth-claude-opts").style.display = p === "claude" ? "block" : "none";
}

$("#oauth-provider").addEventListener("change", updateOAuthProviderUI);
updateOAuthProviderUI();

async function startOAuth() {
  const provider = $("#oauth-provider").value;
  const btn = $("#btn-oauth-start");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> starting...';

  try {
    const body = {};
    if (provider === "copilot") {
      body.redirectUri = "http://localhost:0/callback";
      const ed = $("#oauth-enterprise-domain").value.trim();
      if (ed) body.options = { enterpriseDomain: ed };
    } else {
      const uri = $("#oauth-redirect-uri").value.trim();
      if (!uri) throw new Error("Redirect URI is required");
      body.redirectUri = uri;
      if (provider === "claude")
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

function renderOAuthFlow(data, provider) {
  const c = $("#oauth-flow-active");
  c.style.display = "block";
  const device = data.method === "auto";
  const urlStep = `<div class="oauth-step"><span class="oauth-step-num">1</span><div><div style="margin-bottom:4px">Open the authorization page:</div><div class="oauth-url"><a href="${escapeHtml(data.authorizationUrl)}" target="_blank" rel="noopener">${escapeHtml(data.authorizationUrl)}</a></div></div></div>`;
  const instrStep = data.instructions
    ? `<div class="oauth-step"><span class="oauth-step-num">2</span><div><div class="oauth-instructions">${escapeHtml(data.instructions)}</div></div></div>`
    : "";
  const lastNum = data.instructions ? 3 : 2;
  const completeStep = device
    ? `<div style="margin-bottom:8px">Once you have authorized, click complete:</div><button class="btn btn-primary" onclick="completeOAuth()" type="button" id="btn-oauth-complete">complete flow</button>`
    : `<div style="margin-bottom:8px">After authorizing, paste the callback code:</div><input id="oauth-code" class="field-input" type="text" placeholder="authorization code" style="margin-bottom:8px"><button class="btn btn-primary" onclick="completeOAuth()" type="button" id="btn-oauth-complete">complete flow</button>`;
  c.innerHTML = `<div class="oauth-flow-panel"><div class="oauth-flow-title">Active Flow: <span class="badge badge-${provider}">${provider}</span></div>${urlStep}${instrStep}<div class="oauth-step"><span class="oauth-step-num">${lastNum}</span><div>${completeStep}</div></div></div>`;
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

  const body = {
    accessToken,
    refreshToken,
    expiresAt,
  };
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
    $("#import-access-token").value = "";
    $("#import-refresh-token").value = "";
    $("#import-expires-at").value = "";
    $("#import-account-id").value = "";
    $("#import-label").value = "";
    $("#import-metadata").value = "";
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

window.completeOAuth = completeOAuth;
window.switchToTab = switchToTab;
window.openCreateKeyModal = openCreateKeyModal;

$("#accounts-list").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const button = target.closest("button[data-action][data-account-id]");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  const accountId = button.dataset.accountId;
  if (!accountId) {
    return;
  }

  const action = button.dataset.action;
  if (action === "set-primary") {
    setPrimary(accountId);
    return;
  }

  if (action === "refresh-account") {
    refreshAccount(accountId);
  }
});

$("#keys-list").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const button = target.closest("button[data-action][data-key-id]");
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  const action = button.dataset.action;
  const keyId = button.dataset.keyId;
  if (!keyId) {
    return;
  }

  if (action === "copy-key") {
    const key = state.keys.find((item) => item.id === keyId);
    if (!key) {
      toast("Full key is unavailable", "error");
      return;
    }

    copyToClipboard(key.key, button);
    return;
  }

  if (action === "toggle-key") {
    if (state.revealedKeyIds.has(keyId)) {
      state.revealedKeyIds.delete(keyId);
    } else {
      state.revealedKeyIds.add(keyId);
    }
    renderKeys();
    return;
  }

  if (action === "revoke-key") {
    revokeKey(keyId);
  }
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

for (const tab of $$(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of $$(".tab")) t.classList.remove("active");
    for (const p of $$(".tab-panel")) p.classList.remove("active");
    tab.classList.add("active");
    $(`#panel-${tab.dataset.tab}`).classList.add("active");
  });
}

for (const el of $$(".modal-close"))
  el.addEventListener("click", () =>
    el.closest(".modal-backdrop").classList.remove("open")
  );
for (const b of $$(".modal-backdrop"))
  b.addEventListener("click", (e) => {
    if (e.target === b) b.classList.remove("open");
  });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape")
    for (const m of $$(".modal-backdrop.open")) m.classList.remove("open");
});

(async () => {
  const saved = sessionStorage.getItem("kleis_admin_token");
  if (!saved) return;
  try {
    await verifyToken(saved);
    enterApp();
  } catch {
    sessionStorage.removeItem("kleis_admin_token");
  }
})();
