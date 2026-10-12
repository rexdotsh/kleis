import {
  $,
  $$,
  cancelOAuthFlow,
  clearReauthorization,
  closeModal,
  copyToClipboard,
  createKey,
  deleteAccount,
  deleteKey,
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
  reauthorizeAccount,
  redeemResetCredit,
  refreshAccount,
  resolveConfirm,
  restoreSession,
  revokeKey,
  rotateKey,
  saveAccountEdits,
  saveKeyEdits,
  setPrimary,
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
  updateOAuthProviderUI,
} from "./app-data.js";
import {
  menuHtml,
  openAccountDetail,
  openKeyDetail,
  openSetupModal,
  renderAccounts,
  renderDashboard,
  renderKeys,
  setupSnippet,
} from "./app-render.js";

const accountActions = {
  "account-usage": (id) => openAccountDetail(id),
  "edit-account": (id) => openEditAccountModal(id),
  "set-primary": (id) => setPrimary(id),
  "refresh-account": (id) => refreshAccount(id),
  "reauthorize-account": (id) => reauthorizeAccount(id),
  "redeem-reset-credit": (id, button) =>
    redeemResetCredit(id, button?.dataset.creditId || null),
  "delete-account": (id) => deleteAccount(id),
};

const keyActions = {
  "copy-key": (id, button) => {
    const key = keyById(id);
    if (key) copyToClipboard(key.key, button, "Key copied");
    else toast("Key unavailable", "error");
  },
  "copy-models-url": (id, button) => {
    const modelsUrl = modelsUrlForKey(keyById(id));
    if (modelsUrl) {
      copyToClipboard(`${modelsUrl}/api.json`, button, "Models URL copied");
    } else {
      toast("Scoped models URL unavailable", "error");
    }
  },
  "toggle-key": (id) => {
    if (state.revealedKeyIds.has(id)) state.revealedKeyIds.delete(id);
    else state.revealedKeyIds.add(id);
    renderKeys();
  },
  "key-usage": (id) => openKeyDetail(id),
  "edit-key": (id) => openEditKeyModal(id),
  "rotate-key": (id, button) => rotateKey(id, button),
  "revoke-key": (id) => revokeKey(id),
  "delete-key": (id) => deleteKey(id),
};

const activeTab = () => $(".tab.active")?.dataset.tab;
const rowFor = (accountId) =>
  $(`#accounts-list .row[data-account-id="${accountId}"]`);

function setExpandedAccount(accountId) {
  state.expandedAccountId = accountId;
  renderAccounts();
}

function toggleAccount(accountId) {
  setExpandedAccount(state.expandedAccountId === accountId ? null : accountId);
  rowFor(accountId)?.focus({ preventScroll: true });
}

function showAccount(accountId) {
  if (state.accountFilter) {
    state.accountFilter = "";
    $("#accounts-filter").value = "";
  }
  switchToTab("accounts");
  setExpandedAccount(accountId);
  const row = rowFor(accountId);
  row?.scrollIntoView({ block: "center" });
  row?.focus({ preventScroll: true });
}

let menuAnchor = null;

function closeMenu({ restoreFocus = false } = {}) {
  const menu = $("#menu");
  if (menu.hidden) return;
  menu.hidden = true;
  menu.innerHTML = "";
  if (menuAnchor) {
    menuAnchor.setAttribute("aria-expanded", "false");
    menuAnchor.closest(".row")?.classList.remove("sel");
    if (restoreFocus && menuAnchor.isConnected) menuAnchor.focus();
  }
  menuAnchor = null;
}

function openMenu(anchor) {
  if (menuAnchor === anchor) {
    closeMenu({ restoreFocus: true });
    return;
  }
  closeMenu();
  const kind = anchor.dataset.menu;
  const id =
    kind === "account" ? anchor.dataset.accountId : anchor.dataset.keyId;
  const menu = $("#menu");
  menu.innerHTML = menuHtml(kind, id);
  if (!menu.innerHTML) return;
  menu.dataset.kind = kind;
  menu.hidden = false;

  const rect = anchor.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)
  );
  const below = rect.bottom + 4;
  const top =
    below + menu.offsetHeight > innerHeight - 8
      ? Math.max(8, rect.top - menu.offsetHeight - 4)
      : below;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  anchor.closest(".row")?.classList.add("sel");
  menu.querySelector(".menu-item")?.focus();
}

$("#menu").addEventListener("click", (event) => {
  const item = event.target.closest(".menu-item");
  if (!item) return;
  const kind = $("#menu").dataset.kind;
  closeMenu({ restoreFocus: true });
  if (kind === "account") {
    accountActions[item.dataset.action]?.(item.dataset.accountId, null);
  } else {
    keyActions[item.dataset.action]?.(item.dataset.keyId, null);
  }
});

$("#menu").addEventListener("keydown", (event) => {
  const items = Array.from($$("#menu .menu-item"));
  const index = items.indexOf(document.activeElement);
  const move = {
    ArrowDown: items[(index + 1) % items.length],
    ArrowUp: items[(index - 1 + items.length) % items.length],
    Home: items[0],
    End: items.at(-1),
  }[event.key];
  if (move) {
    event.preventDefault();
    move.focus();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu({ restoreFocus: true });
    return;
  }
  if (event.key === "Tab") {
    closeMenu({ restoreFocus: true });
    return;
  }
  const shortcut = items.find(
    (item) =>
      item.dataset.shortcut.toLowerCase() === event.key.toLowerCase() ||
      (item.dataset.shortcut === "Backspace" && event.key === "Delete")
  );
  if (shortcut) {
    event.preventDefault();
    shortcut.click();
  }
});

document.addEventListener("pointerdown", (event) => {
  if (
    menuAnchor &&
    !event.target.closest("#menu") &&
    !menuAnchor.contains(event.target)
  ) {
    closeMenu();
  }
});
window.addEventListener("scroll", () => closeMenu(), { passive: true });

$("#accounts-list").addEventListener("click", (event) => {
  const menuButton = event.target.closest("[data-menu]");
  if (menuButton) {
    openMenu(menuButton);
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (button) {
    const { action, accountId, provider, enabled } = button.dataset;
    if (action === "toggle-provider")
      toggleProvider(provider, enabled === "true");
    else if (action === "go-connect") {
      clearReauthorization();
      switchToTab("oauth");
    } else accountActions[action]?.(accountId, button);
    return;
  }
  if (event.target.closest(".detail")) return;
  const row = event.target.closest(".row[data-account-id]");
  if (row) toggleAccount(row.dataset.accountId);
});

$("#keys-list").addEventListener("click", (event) => {
  const menuButton = event.target.closest("[data-menu]");
  if (menuButton) {
    openMenu(menuButton);
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (button) {
    if (button.dataset.action === "open-create-key") openCreateKeyModal();
    else keyActions[button.dataset.action]?.(button.dataset.keyId, button);
    return;
  }
  const row = event.target.closest(".row[data-key-id]");
  if (row) openKeyDetail(row.dataset.keyId);
});

for (const [listId, open] of [
  ["#accounts-list", (row) => toggleAccount(row.dataset.accountId)],
  ["#keys-list", (row) => openKeyDetail(row.dataset.keyId)],
  ["#attention", (row) => showAccount(row.dataset.accountId)],
]) {
  $(listId).addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".row[tabindex]");
    if (!row || event.target !== row) return;
    event.preventDefault();
    open(row);
  });
}

$("#attention").addEventListener("click", (event) => {
  const row = event.target.closest(".row[data-account-id]");
  if (row) showAccount(row.dataset.accountId);
});

$("#dash-content").addEventListener("click", (event) => {
  if (event.target.closest('[data-action="go-keys"]')) switchToTab("keys");
});

$("#keys-foot").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  state.showRevokedKeys = button.dataset.action === "show-revoked";
  renderKeys();
});

$("#reauthorize-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "toggle-reauthorize-all") {
    state.showAllReauthorize = !state.showAllReauthorize;
    renderAccounts();
  } else {
    reauthorizeAccount(button.dataset.accountId);
  }
});

for (const [inputId, field, render] of [
  ["#accounts-filter", "accountFilter", renderAccounts],
  ["#keys-filter", "keyFilter", renderKeys],
]) {
  const input = $(inputId);
  input.addEventListener("input", () => {
    state[field] = input.value;
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (input.value) {
      input.value = "";
      state[field] = "";
      render();
    } else {
      input.blur();
    }
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

for (const [selector, field, sync, load] of [
  [
    "#dash-window-selector",
    "dashboardWindowMs",
    syncDashboardWindowButtons,
    loadDashboard,
  ],
  [
    "#accounts-window-selector",
    "accountUsageWindowMs",
    syncAccountWindowButtons,
    loadAccounts,
  ],
  ["#keys-window-selector", "keyUsageWindowMs", syncKeyWindowButtons, loadKeys],
]) {
  $(selector).addEventListener("click", (e) => {
    const btn = e.target.closest(".dash-window-btn");
    if (!btn) return;
    const windowMs = Number(btn.dataset.window);
    if (!windowMs || windowMs === state[field]) return;
    state[field] = windowMs;
    sync();
    load();
  });
}

$("#btn-create-key").addEventListener("click", openCreateKeyModal);
$("#btn-open-setup").addEventListener("click", openSetupModal);
$("#btn-modal-create-key").addEventListener("click", createKey);
$("#btn-modal-save-account").addEventListener("click", saveAccountEdits);
$("#btn-modal-save-key").addEventListener("click", saveKeyEdits);
$("#btn-oauth-start").addEventListener("click", startOAuth);
$("#btn-import-account").addEventListener("click", importAccount);

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

for (const group of $$(".seg[data-select]")) {
  group.addEventListener("click", (event) => {
    const option = event.target.closest("button[data-value]");
    const select = $(`#${group.dataset.select}`);
    if (!option || select.disabled || select.value === option.dataset.value) {
      return;
    }
    select.value = option.dataset.value;
    select.dispatchEvent(new Event("change"));
    syncConnectControls();
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
    closeMenu();
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

let chartWidth = 0;
window.addEventListener("resize", () => {
  closeMenu();
  const width = $("#dash-content").clientWidth;
  if (
    width &&
    width !== chartWidth &&
    state.dashboardData &&
    !state.dashboardLoading &&
    activeTab() === "usage"
  ) {
    chartWidth = width;
    renderDashboard(state.dashboardData);
  }
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

const isTyping = (target) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));

function handleShortcut(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (isTyping(event.target) || !$("#app").classList.contains("visible")) {
    return false;
  }
  const tab = activeTab();
  if (event.key === "/" && (tab === "accounts" || tab === "keys")) {
    $(`#${tab}-filter`).focus();
    return true;
  }
  if (event.key.toLowerCase() === "n" && tab === "keys") {
    openCreateKeyModal();
    return true;
  }
  return false;
}

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
  if (!modal && handleShortcut(e)) {
    e.preventDefault();
    return;
  }
  if (e.key !== "Escape") return;
  if ($("#modal-confirm").classList.contains("open")) {
    resolveConfirm(false);
    return;
  }
  if (modal) {
    for (const m of $$(".modal-backdrop.open")) closeModal(m);
    return;
  }
  if (state.expandedAccountId && activeTab() === "accounts") {
    const accountId = state.expandedAccountId;
    setExpandedAccount(null);
    rowFor(accountId)?.focus();
  }
});

restoreSession();
