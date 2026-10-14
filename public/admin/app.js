import { importAccount, loadAccounts, toggleProvider } from "./app-accounts.js";
import { renderAccounts } from "./app-accounts-render.js";
import { hideDailyTokensTip, showDailyTokensTip } from "./app-charts.js";
import {
  cancelOAuthFlow,
  clearReauthorization,
  copyToClipboard,
  logout,
  resolveConfirm,
  runAction,
  setConfirmAnchor,
  syncConnectControls,
  updateOAuthProviderUI,
} from "./app-core.js";
import { keyById } from "./app-format.js";
import { syncScopedAccountAvailability } from "./app-key-access.js";
import { loadKeys, startCreateKey } from "./app-keys.js";
import {
  renderKeys,
  renderOpenCodeSetup,
  setupSnippet,
} from "./app-keys-render.js";
import {
  accountActions,
  activeTab,
  keyActions,
  openOpenCodeSetup,
  showAccount,
  showKey,
  toggleAccount,
  toggleKey,
} from "./app-lists.js";
import { closeMenu, menuAnchor, openMenu } from "./app-menu.js";
import { reauthorizeAccount, startOAuth } from "./app-oauth.js";
import { handleLogin, restoreSession } from "./app-session.js";
import {
  TABS,
  WINDOW_CONTROLS,
  handleEscape,
  handleShortcut,
} from "./app-shortcuts.js";
import { $, $$, state } from "./app-state.js";
import { loadDashboard, switchToTab } from "./app-usage.js";
import { renderDashboard } from "./app-usage-render.js";
import { initPwa } from "./app-pwa.js";

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
    runAction(
      accountActions[item.dataset.action]?.(item.dataset.accountId, null)
    );
  } else {
    runAction(keyActions[item.dataset.action]?.(item.dataset.keyId, null));
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
      runAction(toggleProvider(provider, enabled === "true"));
    else if (action === "go-connect") {
      clearReauthorization();
      switchToTab("oauth");
    } else runAction(accountActions[action]?.(accountId, button));
    return;
  }
  const linkedKey = event.target.closest(".usage-slot .row[data-key-id]");
  if (linkedKey) {
    runAction(showKey(linkedKey.dataset.keyId));
    return;
  }
  if (event.target.closest(".detail")) return;
  const row = event.target.closest(".row[data-account-id]");
  if (row) runAction(toggleAccount(row.dataset.accountId));
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
    runAction(
      keyActions[button.dataset.action]?.(button.dataset.keyId, button)
    );
    return;
  }
  const linkedAccount = event.target.closest(
    ".usage-slot .row[data-account-id]"
  );
  if (linkedAccount) {
    runAction(showAccount(linkedAccount.dataset.accountId));
    return;
  }
  if (event.target.closest(".detail, .inline-form")) return;
  const row = event.target.closest(".row[data-key-id]");
  if (row) runAction(toggleKey(row.dataset.keyId));
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
    else runAction(open(row));
  });
}

$("#attention").addEventListener("click", (event) => {
  const row = event.target.closest(".row[data-account-id]");
  if (row) runAction(showAccount(row.dataset.accountId));
});

$("#dash-content").addEventListener("click", (event) => {
  if (event.target.closest('[data-action="go-keys"]')) {
    switchToTab("keys");
    return;
  }
  const row = event.target.closest(".row[data-key-id]");
  if (row) runAction(showKey(row.dataset.keyId));
});

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
  if (key)
    runAction(copyToClipboard(setupSnippet(key), button, "Commands copied"));
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
    runAction(reauthorizeAccount(button.dataset.accountId));
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
  runAction(handleLogin());
});
$("#btn-logout").addEventListener("click", logout);
$("#btn-refresh-accounts").addEventListener("click", () =>
  runAction(loadAccounts())
);
$("#btn-refresh-keys").addEventListener("click", () => runAction(loadKeys()));
$("#btn-refresh-dash").addEventListener("click", () =>
  runAction(loadDashboard())
);
$("#btn-create-key").addEventListener("click", startCreateKey);
$("#btn-oauth-start").addEventListener("click", () => runAction(startOAuth()));
$("#btn-import-account").addEventListener("click", () =>
  runAction(importAccount())
);

for (const control of Object.values(WINDOW_CONTROLS)) {
  $(control.selector).addEventListener("click", (event) => {
    const button = event.target.closest(".dash-window-btn");
    const windowMs = Number(button?.dataset.window);
    if (!windowMs || windowMs === state[control.field]) return;
    state[control.field] = windowMs;
    control.sync();
    runAction(control.load());
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

runAction(restoreSession());
