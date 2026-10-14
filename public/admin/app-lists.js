import {
  cancelEditAccount,
  deleteAccount,
  redeemResetCredit,
  refreshAccount,
  saveAccountEdits,
  setPrimary,
  startEditAccount,
} from "./app-accounts.js";
import { renderAccounts } from "./app-accounts-render.js";
import { copyToClipboard, runAction, toast } from "./app-core.js";
import { keyById, modelsUrlForKey } from "./app-format.js";
import {
  cancelCreateKey,
  cancelEditKey,
  createKey,
  deleteKey,
  revokeKey,
  rotateKey,
  saveKeyEdits,
  startCreateKey,
  startEditKey,
} from "./app-keys.js";
import { renderKeys, renderOpenCodeSetup } from "./app-keys-render.js";
import { reauthorizeAccount } from "./app-oauth.js";
import { $, $$, state } from "./app-state.js";
import {
  scheduleUsagePrefetch,
  switchToTab,
  usageHasTraffic,
  waitForDailyTokens,
  waitForUsageDetail,
} from "./app-usage.js";

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

function openOpenCodeSetup(id = null) {
  state.setupKeyId =
    id ?? state.setupKeyId ?? state.expandedKeyId ?? state.cursorKeyId;
  state.setupOpen = true;
  renderOpenCodeSetup();
  $("#opencode-setup").scrollIntoView({ block: "nearest" });
}

export {
  accountActions,
  keyActions,
  activeTab,
  accountRow,
  keyRow,
  setExpandedAccount,
  setExpandedKey,
  LISTS,
  setCursor,
  moveCursor,
  toggleAccount,
  toggleKey,
  showAccount,
  showKey,
  openOpenCodeSetup,
};
