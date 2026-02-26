import {
  $,
  $$,
  clearPersistedToken,
  copyToClipboard,
  createKey,
  deleteAccount,
  deleteKey,
  enterApp,
  handleLogin,
  importAccount,
  keyById,
  loadAccounts,
  loadDashboard,
  loadKeys,
  logout,
  modelsUrlForKey,
  openCreateKeyModal,
  openEditAccountModal,
  openEditKeyModal,
  readPersistedToken,
  refreshAccount,
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
  updateOAuthProviderUI,
  verifyToken,
} from "./app-data.js";
import {
  openAccountDetail,
  openKeyDetail,
  openSetupModal,
  renderKeys,
  setupSnippet,
} from "./app-render.js";

$("#accounts-list").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  if (button) {
    const action = button.dataset.action;
    const accountId = button.dataset.accountId;

    if (action === "go-connect") {
      switchToTab("oauth");
      return;
    }
    if (!accountId) return;
    if (action === "edit-account") openEditAccountModal(accountId);
    if (action === "set-primary") setPrimary(accountId);
    if (action === "refresh-account") refreshAccount(accountId);
    if (action === "delete-account") deleteAccount(accountId);
    return;
  }

  const card = e.target.closest(".card[data-account-id]");
  const accountId = card?.dataset.accountId;
  if (accountId) openAccountDetail(accountId);
});

$("#keys-list").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  if (button) {
    const action = button.dataset.action;
    const keyId = button.dataset.keyId;

    if (action === "open-create-key") {
      openCreateKeyModal();
      return;
    }
    if (action === "show-revoked") {
      state.showRevokedKeys = true;
      renderKeys();
      return;
    }
    if (!keyId) return;

    if (action === "copy-key") {
      const key = keyById(keyId);
      if (key) copyToClipboard(key.key, button);
      else toast("Key unavailable", "error");
      return;
    }
    if (action === "copy-models-url") {
      const key = keyById(keyId);
      const modelsUrl = modelsUrlForKey(key);
      if (modelsUrl) copyToClipboard(`${modelsUrl}/api.json`, button);
      else toast("Scoped models URL unavailable", "error");
      return;
    }
    if (action === "toggle-key") {
      if (state.revealedKeyIds.has(keyId)) state.revealedKeyIds.delete(keyId);
      else state.revealedKeyIds.add(keyId);
      renderKeys();
      return;
    }
    if (action === "edit-key") openEditKeyModal(keyId);
    if (action === "rotate-key") rotateKey(keyId, button);
    if (action === "revoke-key") revokeKey(keyId);
    if (action === "delete-key") deleteKey(keyId);
    return;
  }

  const card = e.target.closest(".card[data-key-id]");
  if (card) openKeyDetail(card.dataset.keyId);
});

$("#login-btn").addEventListener("click", handleLogin);
$("#login-token").addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleLogin();
});
$("#btn-logout").addEventListener("click", logout);
$("#btn-refresh-accounts").addEventListener("click", loadAccounts);
$("#btn-refresh-keys").addEventListener("click", loadKeys);
$("#btn-refresh-dash").addEventListener("click", loadDashboard);
$("#dash-window-selector").addEventListener("click", (e) => {
  const btn = e.target.closest(".dash-window-btn");
  if (!btn) return;
  const windowMs = Number(btn.dataset.window);
  if (!windowMs || windowMs === state.dashboardWindowMs) return;
  state.dashboardWindowMs = windowMs;
  syncDashboardWindowButtons();
  loadDashboard();
});
$("#btn-create-key").addEventListener("click", openCreateKeyModal);
$("#btn-open-setup").addEventListener("click", openSetupModal);
$("#btn-modal-create-key").addEventListener("click", createKey);
$("#btn-modal-save-account").addEventListener("click", saveAccountEdits);
$("#btn-modal-save-key").addEventListener("click", saveKeyEdits);
$("#btn-oauth-start").addEventListener("click", startOAuth);
$("#btn-import-account").addEventListener("click", importAccount);
$("#toggle-show-revoked-keys").addEventListener("change", (e) => {
  state.showRevokedKeys = e.target.checked;
  renderKeys();
});

$("#oauth-provider").addEventListener("change", updateOAuthProviderUI);
updateOAuthProviderUI();

$("#setup-key-select").addEventListener("change", (e) => {
  const key = keyById(e.target.value);
  $("#setup-snippet").textContent = setupSnippet(key);
});

$("#btn-copy-setup").addEventListener("click", (e) => {
  const key = keyById($("#setup-key-select").value);
  copyToClipboard(setupSnippet(key), e.currentTarget);
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
  const saved = readPersistedToken();
  if (!saved) return;
  $("#login-gate").classList.add("hidden");
  try {
    await verifyToken(saved);
    enterApp();
  } catch {
    clearPersistedToken();
    $("#login-gate").classList.remove("hidden");
  }
})();
