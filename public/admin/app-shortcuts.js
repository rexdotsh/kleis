import { cancelEditAccount, loadAccountUsage } from "./app-accounts.js";
import { resolveConfirm, runAction, setConfirmAnchor } from "./app-core.js";
import { keyById } from "./app-format.js";
import {
  cancelCreateKey,
  cancelEditKey,
  loadKeyUsage,
  startCreateKey,
} from "./app-keys.js";
import {
  LISTS,
  accountActions,
  accountRow,
  activeTab,
  keyActions,
  keyRow,
  moveCursor,
  setCursor,
  setExpandedAccount,
  setExpandedKey,
  toggleAccount,
  toggleKey,
} from "./app-lists.js";
import { closeMenu } from "./app-menu.js";
import {
  $,
  state,
  syncAccountWindowButtons,
  syncDashboardWindowButtons,
  syncKeyWindowButtons,
} from "./app-state.js";
import { loadDashboard, switchToTab } from "./app-usage.js";

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
    runAction(accountActions[action](id, null));
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
  runAction(keyActions[action](id, null));
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
    if (tab === "accounts") runAction(toggleAccount(id));
    else runAction(toggleKey(id));
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
    else if (id) runAction(setExpandedAccount(null));
    else setCursor("accounts", null);
    if (id) accountRow(id)?.focus();
  } else if (tab === "keys") {
    const id = state.pendingExpandedKeyId || state.expandedKeyId;
    if (state.creatingKey) cancelCreateKey();
    else if (state.editingKeyId) cancelEditKey();
    else if (id) runAction(setExpandedKey(null));
    else setCursor("keys", null);
    if (id) keyRow(id)?.focus();
  }
}

export { WINDOW_CONTROLS, TABS, handleShortcut, handleEscape };
