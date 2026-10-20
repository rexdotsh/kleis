import {
  cancelEditAccount,
  deleteAccount,
  loadAccountUsage,
  redeemResetCredit,
  refreshAccount,
  saveAccountEdits,
  setPrimary,
  startEditAccount,
} from "./app-accounts.js";
import { renderAccounts } from "./app-accounts-render.js";
import { isAccountVisible } from "./app-account-visibility.js";
import {
  $,
  $$,
  FREE_TIER_CURSOR_ID,
  REVOKED_KEYS_CURSOR_ID,
  accountById,
  accountUsageForId,
  copyToClipboard,
  keyById,
  modelsUrlForKey,
  resolveConfirm,
  runAction,
  setConfirmAnchor,
  setShowFreeTier,
  setShowRevokedKeys,
  state,
  syncAccountWindowButtons,
  syncDashboardWindowButtons,
  syncKeyWindowButtons,
  toast,
} from "./app-core.js";
import {
  cancelCreateKey,
  cancelEditKey,
  createKey,
  deleteKey,
  loadKeyUsage,
  revokeKey,
  rotateKey,
  saveKeyEdits,
  startCreateKey,
  startEditKey,
} from "./app-keys.js";
import { renderKeys, renderOpenCodeSetup } from "./app-keys-render.js";
import { reauthorizeAccount } from "./app-oauth.js";
import { resetOfferFor } from "./app-reset-credits.js";
import {
  loadDashboard,
  scheduleUsagePrefetch,
  switchToTab,
  usageHasTraffic,
  waitForDailyTokens,
  waitForUsageDetail,
} from "./app-usage.js";

const accountActions = {
  "edit-account": startEditAccount,
  "save-account": saveAccountEdits,
  "cancel-edit-account": cancelEditAccount,
  "set-primary": (id) => setPrimary(id),
  "refresh-account": (id) => refreshAccount(id),
  "reauthorize-account": (id) => reauthorizeAccount(id),
  "redeem-reset-credit": (id) => redeemResetCredit(id),
  "delete-account": (id) => deleteAccount(id),
  "toggle-free-tier": (_id, button) => toggleFreeTier(button),
  "clear-filter": () => {
    state.accountOwner = "";
    clearFilter("#accounts-filter", "accountFilter", renderAccounts);
  },
};

const keyActions = {
  "copy-key": (id, button) => {
    const key = keyById(id);
    if (key) runAction(copyToClipboard(key.key, button, "Key copied"));
    else toast("Key unavailable", "error");
  },
  "copy-models-url": (id, button) => {
    const modelsUrl = modelsUrlForKey(keyById(id));
    if (modelsUrl) {
      runAction(
        copyToClipboard(`${modelsUrl}/api.json`, button, "Models URL copied")
      );
    } else {
      toast("Scoped models URL unavailable", "error");
    }
  },
  "open-setup": openOpenCodeSetup,
  "toggle-key": (id) => {
    if (state.revealedKeyIds.has(id)) {
      state.revealedKeyIds.delete(id);
    } else {
      state.revealedKeyIds.add(id);
      state.expandedKeyId = id;
    }
    renderKeys();
  },
  "edit-key": startEditKey,
  "save-key": saveKeyEdits,
  "cancel-edit-key": cancelEditKey,
  "open-create-key": startCreateKey,
  "submit-key": createKey,
  "cancel-create-key": cancelCreateKey,
  "rotate-key": rotateKey,
  "revoke-key": revokeKey,
  "delete-key": deleteKey,
  "toggle-free-tier": (_id, button) => toggleFreeTier(button),
  "clear-filter": () => clearFilter("#keys-filter", "keyFilter", renderKeys),
  "toggle-revoked": (_id, button) => toggleRevokedKeys(button),
};

const activeTab = () => $(".tab.active")?.dataset.tab;

function clearFilter(inputId, field, render) {
  $(inputId).value = "";
  state[field] = "";
  render();
}
const accountRow = (id) => $(`#accounts-list .row[data-account-id="${id}"]`);
const keyRow = (id) => $(`#keys-list .row[data-key-id="${id}"]`);
const accountCursorRow = (id) =>
  id === FREE_TIER_CURSOR_ID ? $(".free-tier-heading") : accountRow(id);

function toggleFreeTier(button) {
  const list = button?.closest("#keys-list") ? "#keys-list" : "#accounts-list";
  setShowFreeTier(!state.showFreeTier);
  renderAccounts();
  if (state.keysLoaded || state.creatingKey || state.editingKeyId) renderKeys();
  if (state.cursorAccountId && !accountCursorRow(state.cursorAccountId)) {
    state.cursorAccountId = null;
  }
  $(`${list} [data-action="toggle-free-tier"]`)?.focus({ preventScroll: true });
}

function toggleRevokedKeys(button) {
  const open = button.getAttribute("aria-expanded") === "true";
  setShowRevokedKeys(!open);
  if (open && keyById(state.expandedKeyId)?.revokedAt) {
    state.expandedKeyId = null;
    state.editingKeyId = null;
  }
  if (open && keyById(state.pendingExpandedKeyId)?.revokedAt) {
    state.pendingExpandedKeyId = null;
  }
  state.cursorKeyId = REVOKED_KEYS_CURSOR_ID;
  renderKeys();
  $(".revoked-heading")?.focus({ preventScroll: true });
}

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

async function setExpanded(tab, id) {
  const list = LISTS[tab];
  const seq = ++list.openSeq;
  const sessionSeq = state.sessionRequestSeq;
  state[list.pendingField] = id;
  if (id && (tab === "accounts" || usageHasTraffic("key", id)))
    await list.wait(id);
  if (
    seq !== list.openSeq ||
    sessionSeq !== state.sessionRequestSeq ||
    state[list.pendingField] !== id
  )
    return false;
  state[list.pendingField] = null;
  if (id && (activeTab() !== tab || !state[list.recordsField].has(id)))
    return false;
  state[list.expandedField] = id;
  if (state[list.editingField] !== id) state[list.editingField] = null;
  if (id) state[list.cursorField] = id;
  state.enteringDetail = id ? `${list.kind}:${id}` : null;
  state.motionAnchor = state.enteringDetail;
  list.render();
  state.enteringDetail = null;
  state.motionAnchor = null;
  if (id) revealDetail(list.container, id);
  return true;
}

const LISTS = {
  accounts: {
    kind: "account",
    openSeq: 0,
    container: "#accounts-list",
    selector: "#accounts-list :is(.row[data-account-id], [data-cursor-id])",
    idOf: (row) => row.dataset.accountId ?? row.dataset.cursorId,
    cursorField: "cursorAccountId",
    pendingField: "pendingExpandedAccountId",
    expandedField: "expandedAccountId",
    editingField: "editingAccountId",
    recordsField: "accountsById",
    render: renderAccounts,
    wait: (id) =>
      Promise.all([waitForUsageDetail("account", id), waitForDailyTokens(id)]),
  },
  keys: {
    kind: "key",
    openSeq: 0,
    container: "#keys-list",
    selector: "#keys-list :is(.row[data-key-id], [data-cursor-id])",
    idOf: (row) => row.dataset.keyId ?? row.dataset.cursorId,
    cursorField: "cursorKeyId",
    pendingField: "pendingExpandedKeyId",
    expandedField: "expandedKeyId",
    editingField: "editingKeyId",
    recordsField: "keysById",
    render: renderKeys,
    wait: (id) => waitForUsageDetail("key", id),
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
    list.kind,
    row?.dataset.accountId ?? row?.dataset.keyId ?? null
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
  if (id === FREE_TIER_CURSOR_ID) {
    accountCursorRow(id)?.click();
    return;
  }
  const applied = await setExpanded(
    "accounts",
    (state.pendingExpandedAccountId || state.expandedAccountId) === id
      ? null
      : id
  );
  if (applied) accountRow(id)?.focus({ preventScroll: true });
}

async function toggleKey(id) {
  if (id === REVOKED_KEYS_CURSOR_ID) {
    $(".revoked-heading")?.click();
    return;
  }
  const applied = await setExpanded(
    "keys",
    (state.pendingExpandedKeyId || state.expandedKeyId) === id ? null : id
  );
  if (applied) keyRow(id)?.focus({ preventScroll: true });
}

function reveal(row) {
  row?.scrollIntoView({ block: "center" });
  row?.focus({ preventScroll: true });
}

async function showAccount(id) {
  const account = accountById(id);
  if (!account) return;
  if (
    !state.showFreeTier &&
    !isAccountVisible(account, { usage: accountUsageForId(id) })
  ) {
    setShowFreeTier(true);
    if (state.keysLoaded) renderKeys();
  }
  if (state.accountFilter) {
    state.accountFilter = "";
    $("#accounts-filter").value = "";
  }
  state.accountOwner = "";
  switchToTab("accounts");
  if (await setExpanded("accounts", id)) reveal(accountRow(id));
}

async function showKey(id) {
  if (!keyById(id)) return;
  if (state.keyFilter) {
    state.keyFilter = "";
    $("#keys-filter").value = "";
  }
  switchToTab("keys");
  if (await setExpanded("keys", id)) reveal(keyRow(id));
}

function openOpenCodeSetup(id = null) {
  state.setupKeyId =
    id ?? state.setupKeyId ?? state.expandedKeyId ?? state.cursorKeyId;
  state.setupOpen = true;
  renderOpenCodeSetup();
  $("#opencode-setup").scrollIntoView({ block: "nearest" });
}

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
  u: "redeem-reset-credit",
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
    if (
      action === "redeem-reset-credit" &&
      !resetOfferFor(accountById(id))?.canUse
    )
      return false;
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
    else if (id) runAction(setExpanded("accounts", null));
    else setCursor("accounts", null);
    if (id) accountRow(id)?.focus();
  } else if (tab === "keys") {
    const id = state.pendingExpandedKeyId || state.expandedKeyId;
    if (state.creatingKey) cancelCreateKey();
    else if (state.editingKeyId) cancelEditKey();
    else if (id) runAction(setExpanded("keys", null));
    else setCursor("keys", null);
    if (id) keyRow(id)?.focus();
  }
}

export {
  accountActions,
  keyActions,
  activeTab,
  LISTS,
  moveCursor,
  toggleAccount,
  toggleKey,
  showAccount,
  showKey,
  openOpenCodeSetup,
  WINDOW_CONTROLS,
  isTyping,
  TABS,
  WINDOWS,
  runRowShortcut,
  stepWindow,
  toggleShortcuts,
  handleEscape,
};
