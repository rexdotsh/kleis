import {
  $,
  $$,
  cancelCreateKey,
  cancelEditAccount,
  cancelEditKey,
  cancelOAuthFlow,
  clearReauthorization,
  copyToClipboard,
  createKey,
  deleteAccount,
  deleteKey,
  handleLogin,
  importAccount,
  keyById,
  loadAccounts,
  loadAccountUsage,
  loadDashboard,
  loadKeys,
  loadKeyUsage,
  logout,
  modelsUrlForKey,
  reauthorizeAccount,
  redeemResetCredit,
  refreshAccount,
  resolveConfirm,
  restoreSession,
  revokeKey,
  rotateKey,
  saveAccountEdits,
  saveKeyEdits,
  scheduleUsagePrefetch,
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
  updateOAuthProviderUI,
  usageHasTraffic,
  waitForDailyTokens,
  waitForUsageDetail,
} from "./app-data.js";
import {
  hideDailyTokensTip,
  menuHtml,
  renderOpenCodeSetup,
  renderAccounts,
  renderDashboard,
  renderKeys,
  setupSnippet,
  showDailyTokensTip,
} from "./app-render.js";
import { initPwa } from "./app-pwa.js";

const accountActions = {
  "edit-account": (id) => startEditAccount(id),
  "save-account": () => saveAccountEdits(),
  "cancel-edit-account": () => cancelEditAccount(),
  "set-primary": (id) => setPrimary(id),
  "refresh-account": (id) => refreshAccount(id),
  "reauthorize-account": (id) => reauthorizeAccount(id),
  "redeem-reset-credit": (id, button) =>
    redeemResetCredit(id, button?.dataset.creditId || null),
  "delete-account": (id) => deleteAccount(id),
  "clear-filter": () =>
    clearFilter("#accounts-filter", "accountFilter", renderAccounts),
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
  "open-setup": (id) => openOpenCodeSetup(id),
  "toggle-key": (id) => {
    if (state.revealedKeyIds.has(id)) {
      state.revealedKeyIds.delete(id);
    } else {
      state.revealedKeyIds.add(id);
      state.expandedKeyId = id;
    }
    renderKeys();
  },
  "edit-key": (id) => startEditKey(id),
  "save-key": () => saveKeyEdits(),
  "cancel-edit-key": () => cancelEditKey(),
  "open-create-key": () => startCreateKey(),
  "submit-key": () => createKey(),
  "cancel-create-key": () => cancelCreateKey(),
  "rotate-key": (id) => rotateKey(id),
  "revoke-key": (id) => revokeKey(id),
  "delete-key": (id) => deleteKey(id),
  "clear-filter": () => clearFilter("#keys-filter", "keyFilter", renderKeys),
};

const activeTab = () => $(".tab.active")?.dataset.tab;

function clearFilter(inputId, field, render) {
  $(inputId).value = "";
  state[field] = "";
  render();
}
const accountRow = (id) => $(`#accounts-list .row[data-account-id="${id}"]`);
const keyRow = (id) => $(`#keys-list .row[data-key-id="${id}"]`);

// Brings a newly opened row's details into view without jumping the page.
function revealDetail(listId, id) {
  const detail = $(`${listId} .detail[data-detail-for="${id}"]`);
  if (!detail) return;
  const { bottom } = detail.getBoundingClientRect();
  if (bottom > innerHeight) {
    const reduced = globalThis.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    detail.scrollIntoView({
      block: "nearest",
      behavior: reduced ? "instant" : "smooth",
    });
  }
}

let accountOpenSeq = 0;
let keyOpenSeq = 0;

async function setExpandedAccount(id) {
  const seq = ++accountOpenSeq;
  const sessionSeq = state.sessionRequestSeq;
  state.pendingExpandedAccountId = id;
  if (id)
    await Promise.all([
      waitForUsageDetail("account", id),
      waitForDailyTokens(id),
    ]);
  if (
    seq !== accountOpenSeq ||
    sessionSeq !== state.sessionRequestSeq ||
    state.pendingExpandedAccountId !== id
  )
    return false;
  state.pendingExpandedAccountId = null;
  if (id && (activeTab() !== "accounts" || !state.accountsById.has(id)))
    return false;
  state.expandedAccountId = id;
  if (state.editingAccountId !== id) state.editingAccountId = null;
  if (id) state.cursorAccountId = id;
  state.enteringDetail = id ? `account:${id}` : null;
  state.motionAnchor = id ? `account:${id}` : null;
  renderAccounts();
  state.enteringDetail = null;
  state.motionAnchor = null;
  if (id) revealDetail("#accounts-list", id);
  return true;
}

async function setExpandedKey(id) {
  const seq = ++keyOpenSeq;
  const sessionSeq = state.sessionRequestSeq;
  state.pendingExpandedKeyId = id;
  if (id && usageHasTraffic("key", id)) await waitForUsageDetail("key", id);
  if (
    seq !== keyOpenSeq ||
    sessionSeq !== state.sessionRequestSeq ||
    state.pendingExpandedKeyId !== id
  )
    return false;
  state.pendingExpandedKeyId = null;
  if (id && (activeTab() !== "keys" || !state.keysById.has(id))) return false;
  state.expandedKeyId = id;
  if (state.editingKeyId !== id) state.editingKeyId = null;
  if (id) state.cursorKeyId = id;
  state.enteringDetail = id ? `key:${id}` : null;
  state.motionAnchor = id ? `key:${id}` : null;
  renderKeys();
  state.enteringDetail = null;
  state.motionAnchor = null;
  if (id) revealDetail("#keys-list", id);
  return true;
}

const LISTS = {
  accounts: {
    container: "#accounts-list",
    selector: "#accounts-list .row[data-account-id]",
    idOf: (row) => row.dataset.accountId,
    cursorField: "cursorAccountId",
  },
  keys: {
    container: "#keys-list",
    selector: "#keys-list .row[data-key-id]",
    idOf: (row) => row.dataset.keyId,
    cursorField: "cursorKeyId",
  },
};

let cursorFromMouse = false;
let lastTouchAt = 0;

// Taps also send mouse events; a highlight that follows them would stick.
document.addEventListener(
  "touchstart",
  () => {
    lastTouchAt = Date.now();
  },
  { capture: true, passive: true }
);
const fromTouch = () => Date.now() - lastTouchAt < 1000;

function setCursor(tab, row, { focus = false, mouse = false } = {}) {
  const list = LISTS[tab];
  cursorFromMouse = mouse;
  for (const current of $$(`${list.selector}.cursor`)) {
    if (current !== row) current.classList.remove("cursor");
  }
  state[list.cursorField] = row ? list.idOf(row) : null;
  scheduleUsagePrefetch(
    tab === "accounts" ? "account" : "key",
    row ? list.idOf(row) : null
  );
  if (!row) return;
  row.classList.add("cursor");
  if (focus) {
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  }
}

function moveCursor(tab, step) {
  const list = LISTS[tab];
  const rows = Array.from($$(list.selector));
  if (!rows.length) return;
  const current = rows.findIndex(
    (row) => list.idOf(row) === state[list.cursorField]
  );
  const next =
    current === -1
      ? step > 0
        ? 0
        : rows.length - 1
      : Math.min(rows.length - 1, Math.max(0, current + step));
  setCursor(tab, rows[next], { focus: true });
}

for (const tab of ["accounts", "keys"]) {
  const list = LISTS[tab];
  $(list.container).addEventListener("mousemove", (event) => {
    if (fromTouch()) return;
    const row = event.target.closest(list.selector);
    if (!row || list.idOf(row) === state[list.cursorField]) return;
    const focused = document.activeElement;
    if (focused?.matches(list.selector) && focused !== row) focused.blur();
    setCursor(tab, row, { mouse: true });
  });
  $(list.container).addEventListener("mouseleave", () => {
    if (cursorFromMouse) setCursor(tab, null);
  });
  $(list.container).addEventListener("focusin", (event) => {
    const row = event.target.closest(list.selector);
    if (row) setCursor(tab, row);
  });
}

async function toggleAccount(id) {
  const applied = await setExpandedAccount(
    (state.pendingExpandedAccountId || state.expandedAccountId) === id
      ? null
      : id
  );
  if (applied) accountRow(id)?.focus({ preventScroll: true });
}

async function toggleKey(id) {
  const applied = await setExpandedKey(
    (state.pendingExpandedKeyId || state.expandedKeyId) === id ? null : id
  );
  if (applied) keyRow(id)?.focus({ preventScroll: true });
}

function reveal(row) {
  row?.scrollIntoView({ block: "center" });
  row?.focus({ preventScroll: true });
}

async function showAccount(id) {
  if (state.accountFilter) {
    state.accountFilter = "";
    $("#accounts-filter").value = "";
  }
  switchToTab("accounts");
  if (await setExpandedAccount(id)) reveal(accountRow(id));
}

async function showKey(id) {
  if (!keyById(id)) return;
  if (state.keyFilter) {
    state.keyFilter = "";
    $("#keys-filter").value = "";
  }
  switchToTab("keys");
  if (await setExpandedKey(id)) reveal(keyRow(id));
}

let menuAnchor = null;

function closeMenu({ restoreFocus = false } = {}) {
  const menu = $("#menu");
  if (menu.hidden) return;
  menu.hidden = true;
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
  menu.dataset.title =
    anchor.closest(".row")?.querySelector(".name")?.textContent.trim() ?? "";
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
  menu.querySelector(".menu-item:not(:disabled)")?.focus();
}

document.addEventListener(
  "click",
  (event) => {
    const button = event.target.closest("button");
    if (button && !button.closest("#confirm, #menu")) setConfirmAnchor(button);
  },
  true
);

$("#menu").addEventListener("click", (event) => {
  const item = event.target.closest(".menu-item");
  if (!item || item.disabled) return;
  const kind = $("#menu").dataset.kind;
  setConfirmAnchor(menuAnchor);
  closeMenu({ restoreFocus: true });
  if (kind === "account") {
    accountActions[item.dataset.action]?.(item.dataset.accountId, null);
  } else {
    keyActions[item.dataset.action]?.(item.dataset.keyId, null);
  }
});

$("#menu").addEventListener("keydown", (event) => {
  const items = Array.from($$("#menu .menu-item:not(:disabled)"));
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
  if (!($("#confirm").hidden || event.target.closest("#confirm"))) {
    resolveConfirm(false);
  }
});
window.addEventListener("scroll", () => closeMenu(), { passive: true });

$("#btn-confirm-cancel").addEventListener("click", () => resolveConfirm(false));
$("#btn-confirm-action").addEventListener("click", () => resolveConfirm(true));

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
  const linkedKey = event.target.closest(".usage-slot .row[data-key-id]");
  if (linkedKey) {
    showKey(linkedKey.dataset.keyId);
    return;
  }
  if (event.target.closest(".detail")) return;
  const row = event.target.closest(".row[data-account-id]");
  if (row) toggleAccount(row.dataset.accountId);
});

// Mouse hover and touch taps both point at a day in the daily tokens chart.
for (const type of ["pointermove", "pointerdown"]) {
  $("#accounts-list").addEventListener(type, (event) => {
    const plot = event.target.closest(".daily-plot");
    if (plot) showDailyTokensTip(plot, event.clientX);
    else hideDailyTokensTip();
  });
}
$("#accounts-list").addEventListener("pointerleave", () =>
  hideDailyTokensTip()
);

$("#keys-list").addEventListener("click", (event) => {
  const menuButton = event.target.closest("[data-menu]");
  if (menuButton) {
    openMenu(menuButton);
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (button) {
    keyActions[button.dataset.action]?.(button.dataset.keyId, button);
    return;
  }
  const linkedAccount = event.target.closest(
    ".usage-slot .row[data-account-id]"
  );
  if (linkedAccount) {
    showAccount(linkedAccount.dataset.accountId);
    return;
  }
  if (event.target.closest(".detail, .inline-form")) return;
  const row = event.target.closest(".row[data-key-id]");
  if (row) toggleKey(row.dataset.keyId);
});

$("#keys-list").addEventListener("change", (event) => {
  const { target } = event;
  if (!target.closest(".access")) return;
  const mode = target.closest('[data-form="create-key"]') ? "create" : "edit";
  const toggles =
    mode === "create" ? ".key-scope-provider" : ".edit-key-scope-provider";
  if (
    target.matches(toggles) &&
    !target.checked &&
    !target.closest(".access").querySelector(`${toggles}:checked`)
  ) {
    target.checked = true;
    const note = target.closest(".access-row")?.querySelector(".access-note");
    if (note) {
      note.textContent = "Keep one provider on";
      note.className = "access-note warn";
    }
    return;
  }
  syncScopedAccountAvailability(mode);
});

for (const [listId, open] of [
  ["#accounts-list", (row) => toggleAccount(row.dataset.accountId)],
  ["#keys-list", (row) => toggleKey(row.dataset.keyId)],
  ["#attention", (row) => showAccount(row.dataset.accountId)],
  ["#dash-content", (row) => showKey(row.dataset.keyId)],
]) {
  $(listId).addEventListener("keydown", (event) => {
    const form = event.target.closest(".inline-form");
    if (form) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        form.querySelector('[data-action^="cancel"]')?.click();
      } else if (
        event.key === "Enter" &&
        (event.metaKey ||
          event.ctrlKey ||
          (event.target.tagName === "INPUT" &&
            event.target.type !== "checkbox"))
      ) {
        event.preventDefault();
        form.querySelector(".btn-primary")?.click();
      }
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest(".row[tabindex]");
    if (!row || event.target !== row) return;
    event.preventDefault();
    if (row.closest(".usage-slot")) row.click();
    else open(row);
  });
}

$("#attention").addEventListener("click", (event) => {
  const row = event.target.closest(".row[data-account-id]");
  if (row) showAccount(row.dataset.accountId);
});

$("#dash-content").addEventListener("click", (event) => {
  if (event.target.closest('[data-action="go-keys"]')) {
    switchToTab("keys");
    return;
  }
  const row = event.target.closest(".row[data-key-id]");
  if (row) showKey(row.dataset.keyId);
});

function openOpenCodeSetup(id = null) {
  state.setupKeyId =
    id ?? state.setupKeyId ?? state.expandedKeyId ?? state.cursorKeyId;
  state.setupOpen = true;
  renderOpenCodeSetup();
  $("#opencode-setup").scrollIntoView({ block: "nearest" });
}

$("#btn-opencode").addEventListener("click", () => {
  if (state.setupOpen) {
    state.setupOpen = false;
    renderOpenCodeSetup();
  } else {
    openOpenCodeSetup();
  }
});

$("#opencode-setup").addEventListener("change", (event) => {
  if (event.target.id !== "setup-key") return;
  state.setupKeyId = event.target.value;
  renderOpenCodeSetup();
});

$("#opencode-setup").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "close-setup") {
    state.setupOpen = false;
    renderOpenCodeSetup();
    $("#btn-opencode").focus();
    return;
  }
  const key = keyById(button.dataset.keyId);
  if (key) copyToClipboard(setupSnippet(key), button, "Commands copied");
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

$("#login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  handleLogin();
});
$("#btn-logout").addEventListener("click", logout);
$("#btn-refresh-accounts").addEventListener("click", loadAccounts);
$("#btn-refresh-keys").addEventListener("click", loadKeys);
$("#btn-refresh-dash").addEventListener("click", loadDashboard);
$("#btn-create-key").addEventListener("click", startCreateKey);
$("#btn-oauth-start").addEventListener("click", startOAuth);
$("#btn-import-account").addEventListener("click", importAccount);

const WINDOW_CONTROLS = {
  usage: {
    selector: "#dash-window-selector",
    field: "dashboardWindowMs",
    sync: syncDashboardWindowButtons,
    load: loadDashboard,
  },
  accounts: {
    selector: "#accounts-window-selector",
    field: "accountUsageWindowMs",
    sync: syncAccountWindowButtons,
    load: loadAccountUsage,
  },
  keys: {
    selector: "#keys-window-selector",
    field: "keyUsageWindowMs",
    sync: syncKeyWindowButtons,
    load: loadKeyUsage,
  },
};

for (const control of Object.values(WINDOW_CONTROLS)) {
  $(control.selector).addEventListener("click", (event) => {
    const button = event.target.closest(".dash-window-btn");
    const windowMs = Number(button?.dataset.window);
    if (!windowMs || windowMs === state[control.field]) return;
    state[control.field] = windowMs;
    control.sync();
    control.load();
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

for (const tab of $$(".tab")) {
  tab.id = `tab-${tab.dataset.tab}`;
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-controls", `panel-${tab.dataset.tab}`);
  const panel = $(`#panel-${tab.dataset.tab}`);
  panel.setAttribute("role", "tabpanel");
  panel.setAttribute("aria-labelledby", tab.id);
  tab.addEventListener("click", () => {
    closeMenu();
    resolveConfirm(false);
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
let resizeFrame = 0;
window.addEventListener("resize", () => {
  closeMenu();
  resolveConfirm(false);
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(redrawChartForWidth);
});

function redrawChartForWidth() {
  resizeFrame = 0;
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
}

const isTyping = (target) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName));

const TABS = ["usage", "accounts", "keys", "oauth"];
const WINDOWS = [3_600_000, 21_600_000, 86_400_000, 604_800_000, 2_592_000_000];

const ACCOUNT_SHORTCUTS = {
  p: "set-primary",
  r: "refresh-account",
  a: "reauthorize-account",
  e: "edit-account",
  Backspace: "delete-account",
  Delete: "delete-account",
};

const KEY_SHORTCUTS = {
  c: "copy-key",
  m: "copy-models-url",
  s: "toggle-key",
  e: "edit-key",
  r: "rotate-key",
  u: "open-setup",
  Backspace: "revoke-key",
  Delete: "revoke-key",
};

// Shortcuts act on the highlighted row (keyboard or mouse), or the open one.
function runRowShortcut(tab, key) {
  if (tab === "accounts") {
    const id = state.cursorAccountId ?? state.expandedAccountId;
    const action = ACCOUNT_SHORTCUTS[key];
    const row = id ? accountRow(id) : null;
    if (!(row && action)) return false;
    setConfirmAnchor(row.querySelector(".more") ?? row);
    accountActions[action](id, null);
    return true;
  }
  const id = state.cursorKeyId ?? state.expandedKeyId;
  const row = id ? keyRow(id) : null;
  const record = row ? keyById(id) : null;
  let action = KEY_SHORTCUTS[key];
  if (!(record && action)) return false;
  if (record.revokedAt) {
    if (action === "revoke-key") action = "delete-key";
    else if (action !== "edit-key") return false;
  }
  setConfirmAnchor(row.querySelector(".more") ?? row);
  keyActions[action](id, null);
  return true;
}

function stepWindow(tab, step) {
  const control = WINDOW_CONTROLS[tab];
  if (!control) return;
  const index = WINDOWS.indexOf(state[control.field]);
  const next = WINDOWS[Math.min(WINDOWS.length - 1, Math.max(0, index + step))];
  if (next && next !== state[control.field]) {
    state[control.field] = next;
    control.sync();
    control.load();
  }
}

function handleShortcut(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (isTyping(event.target) || !$("#app").classList.contains("visible")) {
    return false;
  }
  if (!($("#menu").hidden && $("#confirm").hidden)) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const tab = activeTab();
  if (key === "?") {
    toggleShortcuts();
    return true;
  }
  if (/^[1-4]$/.test(key)) {
    closeMenu();
    switchToTab(TABS[Number(key) - 1]);
    return true;
  }
  if (key === "[" || key === "]") {
    stepWindow(tab, key === "]" ? 1 : -1);
    return true;
  }
  if (tab !== "accounts" && tab !== "keys") return false;
  if (key === "/") {
    $(`#${tab}-filter`).focus();
    return true;
  }
  if (key === "n") {
    if (tab === "keys") startCreateKey();
    else switchToTab("oauth");
    return true;
  }
  if (key === "j" || key === "ArrowDown") {
    moveCursor(tab, 1);
    return true;
  }
  if (key === "k" || key === "ArrowUp") {
    moveCursor(tab, -1);
    return true;
  }
  // Enter keeps its normal meaning on buttons, links and focused rows.
  const enterTaken =
    key === "Enter" &&
    event.target.closest?.("a, button, [tabindex], .inline-form");
  if ((key === "Enter" || key === "o") && !enterTaken) {
    const id = state[LISTS[tab].cursorField];
    if (!id) return false;
    if (tab === "accounts") toggleAccount(id);
    else toggleKey(id);
    return true;
  }
  return runRowShortcut(tab, key);
}

function toggleShortcuts(force) {
  const sheet = $("#shortcuts");
  const open = force ?? sheet.hidden;
  sheet.hidden = !open;
  $("#btn-shortcuts").setAttribute("aria-expanded", String(open));
}

$("#btn-shortcuts").addEventListener("click", () => toggleShortcuts());
document.addEventListener("pointerdown", (event) => {
  if (
    !$("#shortcuts").hidden &&
    !event.target.closest("#shortcuts, #btn-shortcuts")
  ) {
    toggleShortcuts(false);
  }
});

function handleEscape() {
  if (!$("#confirm").hidden) {
    resolveConfirm(false);
    return;
  }
  if (!$("#shortcuts").hidden) {
    toggleShortcuts(false);
    return;
  }
  const tab = activeTab();
  if (tab === "accounts") {
    const id = state.pendingExpandedAccountId || state.expandedAccountId;
    if (state.editingAccountId) cancelEditAccount();
    else if (id) setExpandedAccount(null);
    else setCursor("accounts", null);
    if (id) accountRow(id)?.focus();
  } else if (tab === "keys") {
    const id = state.pendingExpandedKeyId || state.expandedKeyId;
    if (state.creatingKey) cancelCreateKey();
    else if (state.editingKeyId) cancelEditKey();
    else if (id) setExpandedKey(null);
    else setCursor("keys", null);
    if (id) keyRow(id)?.focus();
  }
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    handleEscape();
    return;
  }
  if (handleShortcut(event)) event.preventDefault();
});

window.addEventListener("hashchange", () => {
  const tab = location.hash.slice(1);
  if (!(state.sessionActive && TABS.includes(tab)) || tab === activeTab()) {
    return;
  }
  closeMenu();
  resolveConfirm(false);
  switchToTab(tab);
});

initPwa({
  closeMenu: () => closeMenu({ restoreFocus: true }),
  refresh: () =>
    ({ usage: loadDashboard, accounts: loadAccounts, keys: loadKeys })[
      activeTab()
    ]?.(),
});

restoreSession();
