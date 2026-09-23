import {
  $,
  $$,
  clearPersistedToken,
  clearReauthorization,
  closeModal,
  cancelOAuthFlow,
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
  redeemResetCredit,
  refreshAccount,
  reauthorizeAccount,
  resolveConfirm,
  revokeKey,
  rotateKey,
  saveAccountEdits,
  saveKeyEdits,
  setPrimary,
  startOAuth,
  state,
  syncAccountWindowButtons,
  switchToTab,
  syncDashboardWindowButtons,
  syncKeyWindowButtons,
  syncScopedAccountAvailability,
  toast,
  toggleProvider,
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

$("#providers-status").addEventListener("click", (e) => {
  const button = e.target.closest('button[data-action="toggle-provider"]');
  if (!button) return;
  toggleProvider(button.dataset.provider, button.dataset.enabled === "true");
});

$("#accounts-list").addEventListener("click", (e) => {
  const button = e.target.closest("button[data-action]");
  if (button) {
    const action = button.dataset.action;
    const accountId = button.dataset.accountId;

    if (action === "go-connect") {
      clearReauthorization();
      switchToTab("oauth");
      return;
    }
    if (!accountId) return;
    if (action === "edit-account") openEditAccountModal(accountId);
    if (action === "set-primary") setPrimary(accountId);
    if (action === "refresh-account") refreshAccount(accountId);
    if (action === "reauthorize-account") reauthorizeAccount(accountId);
    if (action === "redeem-reset-credit")
      redeemResetCredit(accountId, button.dataset.creditId || null);
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

for (const [listId, cardSelector, openDetail] of [
  ["#accounts-list", ".card[data-account-id]", openAccountDetail],
  ["#keys-list", ".card[data-key-id]", openKeyDetail],
]) {
  $(listId).addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(cardSelector);
    if (!card || event.target !== card) return;
    event.preventDefault();
    openDetail(card.dataset.accountId || card.dataset.keyId);
  });
}

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
$("#accounts-window-selector").addEventListener("click", (e) => {
  const btn = e.target.closest(".dash-window-btn");
  if (!btn) return;
  const windowMs = Number(btn.dataset.window);
  if (!windowMs || windowMs === state.accountUsageWindowMs) return;
  state.accountUsageWindowMs = windowMs;
  syncAccountWindowButtons();
  loadAccounts();
});
$("#keys-window-selector").addEventListener("click", (e) => {
  const btn = e.target.closest(".dash-window-btn");
  if (!btn) return;
  const windowMs = Number(btn.dataset.window);
  if (!windowMs || windowMs === state.keyUsageWindowMs) return;
  state.keyUsageWindowMs = windowMs;
  syncKeyWindowButtons();
  loadKeys();
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

for (const [sel, acct, prov, mode] of [
  ["#modal-create-key", ".key-scope-account", ".key-scope-provider", "create"],
  [
    "#modal-edit-key",
    ".edit-key-scope-account",
    ".edit-key-scope-provider",
    "edit",
  ],
]) {
  $(sel).addEventListener("change", (e) => {
    if (e.target.matches(acct) && e.target.checked) {
      for (const input of $$(
        `${acct}[data-provider="${e.target.dataset.provider}"]`
      )) {
        if (input !== e.target) input.checked = false;
      }
    }
    if (e.target.matches(`${prov}, ${acct}`))
      syncScopedAccountAvailability(mode);
  });
}

$("#oauth-provider").addEventListener("change", updateOAuthProviderUI);
$("#btn-oauth-clear-target").addEventListener("click", () => {
  if (state.activeOAuth) return;
  if ($("#btn-oauth-start").disabled) cancelOAuthFlow();
  clearReauthorization();
});
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
  tab.id = `tab-${tab.dataset.tab}`;
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-controls", `panel-${tab.dataset.tab}`);
  const panel = $(`#panel-${tab.dataset.tab}`);
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", tab.id);
  tab.addEventListener("click", () => {
    switchToTab(tab.dataset.tab);
  });
}
$(".tabs").addEventListener("keydown", (event) => {
  const tabs = Array.from($$(".tab"));
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  const next = {
    ArrowRight: tabs[(index + 1) % tabs.length],
    ArrowLeft: tabs[(index + tabs.length - 1) % tabs.length],
    Home: tabs[0],
    End: tabs.at(-1),
  }[event.key];
  if (!next) return;
  event.preventDefault();
  next.focus();
  switchToTab(next.dataset.tab);
});

for (const el of $$(".modal-close")) {
  el.addEventListener("click", () => closeModal(el.closest(".modal-backdrop")));
}
for (const backdrop of $$(".modal-backdrop")) {
  backdrop.addEventListener("click", (e) => {
    if (e.target !== backdrop) return;
    if (backdrop.id === "modal-confirm") resolveConfirm(false);
    else closeModal(backdrop);
  });
}
$("#btn-confirm-cancel").addEventListener("click", () => resolveConfirm(false));
$("#btn-confirm-action").addEventListener("click", () => resolveConfirm(true));

document.addEventListener("keydown", (e) => {
  const modal = $(".modal-backdrop.open");
  if (e.key === "Tab" && modal) {
    const focusable = Array.from(
      modal.querySelectorAll(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]"
      )
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first && !modal.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (
      first &&
      ((e.shiftKey && document.activeElement === first) ||
        (!e.shiftKey && document.activeElement === last))
    ) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
    return;
  }
  if (e.key !== "Escape") return;
  if ($("#modal-confirm").classList.contains("open")) {
    resolveConfirm(false);
    return;
  }
  for (const m of $$(".modal-backdrop.open")) closeModal(m);
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
