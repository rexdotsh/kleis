import {
  accountLabel,
  checkedValues,
  escapeHtml,
  providerLabel,
  shortId,
} from "./app-format.js";
import { $, $$, PROVIDER_ORDER, state } from "./app-state.js";

const KEY_SCOPE_FORMS = {
  create: {
    providerSelector: ".key-scope-provider",
    pinSelector: ".key-account-pin",
    accountSelector: ".key-scope-account",
    accountContainer: "#key-account-scopes",
  },
  edit: {
    providerSelector: ".edit-key-scope-provider",
    pinSelector: ".edit-key-account-pin",
    accountSelector: ".edit-key-scope-account",
    accountContainer: "#edit-key-account-scopes",
  },
};

function renderKeyAccess(mode, key) {
  const container = $(KEY_SCOPE_FORMS[mode].accountContainer);
  if (container) container.innerHTML = keyAccessHtml(mode, key);
}

function accessNote({ on, hasAccounts, pinned, pinnedDisabled }) {
  if (!on) return { text: "No access", cls: "" };
  if (!hasAccounts) return { text: "No account connected", cls: "warn" };
  if (pinnedDisabled) return { text: "Account disabled", cls: "warn" };
  return pinned
    ? { text: "Always this account", cls: "" }
    : { text: "Follows the primary", cls: "" };
}

const accessNoteHtml = (note) =>
  `<span class="access-note${note.cls ? ` ${note.cls}` : ""}">${note.text}</span>`;

// One line per provider: whether the key may use it, and through which
// account. Pins only apply to their own provider.
function keyAccessHtml(mode, key = null) {
  const config = KEY_SCOPE_FORMS[mode];
  const allowed = key?.providerScopes?.length
    ? new Set(key.providerScopes)
    : null;
  const selectedIds = new Set(key?.accountScopes || []);
  const knownIds = new Set(state.accounts.map((account) => account.id));
  const unavailableIds =
    mode === "edit"
      ? Array.from(selectedIds).filter((id) => !knownIds.has(id))
      : [];

  const rows = PROVIDER_ORDER.map((provider) => {
    const on = !allowed || allowed.has(provider);
    const accounts = state.accounts
      .filter((account) => account.provider === provider)
      .sort(
        (left, right) =>
          Number(right.isPrimary) - Number(left.isPrimary) ||
          left.createdAt - right.createdAt
      );
    const primary = accounts.find((account) => account.isPrimary);
    const pinned = accounts.find((account) => selectedIds.has(account.id));
    const name = providerLabel(provider);
    const first = accounts.length
      ? `Primary account${primary ? ` (${escapeHtml(accountLabel(primary))})` : ""}`
      : "No accounts connected";
    const options = accounts
      .map(
        (account) =>
          `<option value="${account.id}"${account === pinned ? " selected" : ""}${account.enabled === false ? ' data-disabled="true"' : ""}>${escapeHtml(accountLabel(account))}${account.enabled === false ? " (disabled)" : ""}</option>`
      )
      .join("");
    const note = accessNote({
      on,
      hasAccounts: accounts.length > 0,
      pinned: Boolean(pinned),
      pinnedDisabled: pinned?.enabled === false,
    });
    return `<div class="access-row${on ? "" : " off"}" data-provider="${provider}">
        <label class="access-provider"><input type="checkbox" role="switch" class="toggle ${config.providerSelector.slice(1)}" value="${provider}"${on ? " checked" : ""}><span>${name}</span></label>
        <select class="field-input ${config.pinSelector.slice(1)}" data-provider="${provider}" aria-label="${name} account"${on && accounts.length ? "" : " disabled"}><option value="">${first}</option>${options}</select>
        ${accessNoteHtml(note)}
      </div>`;
  }).join("");
  const preserved = unavailableIds
    .map(
      (id) =>
        `<label class="scope-check"><input type="checkbox" value="${escapeHtml(id)}" class="${config.accountSelector.slice(1)}" data-preserved-scope="true" checked> Keep the pin to ${escapeHtml(shortId(id))}, which is not in the loaded account list</label>`
    )
    .join("");
  return `${rows}${preserved}`;
}

// null when every provider is on (no restriction); [] when none is.
function selectedProviderScopes(mode) {
  const toggles = Array.from($$(KEY_SCOPE_FORMS[mode].providerSelector));
  const on = toggles
    .filter((toggle) => toggle.checked)
    .map((toggle) => toggle.value);
  return on.length === toggles.length ? null : on;
}

function selectedAccountScopes(mode) {
  const config = KEY_SCOPE_FORMS[mode];
  const pinned = Array.from($$(config.pinSelector))
    .filter((select) => select.value && !select.disabled)
    .map((select) => select.value);
  return [...pinned, ...checkedValues(config.accountSelector)];
}

function syncScopedAccountAvailability(mode) {
  const config = KEY_SCOPE_FORMS[mode];
  for (const toggle of $$(config.providerSelector)) {
    const row = toggle.closest(".access-row");
    const select = row?.querySelector("select");
    if (!(row && select)) continue;
    const on = toggle.checked;
    const hasAccounts = select.options.length > 1;
    row.classList.toggle("off", !on);
    select.disabled = !(on && hasAccounts);
    const note = accessNote({
      on,
      hasAccounts,
      pinned: Boolean(select.value),
      pinnedDisabled: select.selectedOptions[0]?.dataset.disabled === "true",
    });
    const noteEl = row.querySelector(".access-note");
    if (noteEl) {
      noteEl.textContent = note.text;
      noteEl.className = `access-note${note.cls ? ` ${note.cls}` : ""}`;
    }
  }
}

export {
  renderKeyAccess,
  keyAccessHtml,
  selectedProviderScopes,
  selectedAccountScopes,
  syncScopedAccountAvailability,
};
