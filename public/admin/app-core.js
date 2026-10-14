import { escapeHtml } from "./app-format.js";
import {
  $,
  $$,
  DEFAULT_KEY_USAGE_WINDOW_MS,
  clearPersistedToken,
  prefetchTimers,
  state,
  syncAccountWindowButtons,
  syncDashboardWindowButtons,
} from "./app-state.js";

async function api(path, options = {}) {
  const requestSeq = state.sessionRequestSeq;
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  let res;
  try {
    res = await fetch(path, { ...options, headers });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error(
      globalThis.navigator?.onLine === false
        ? "You're offline"
        : "Could not reach Kleis"
    );
  }
  if (
    requestSeq === state.sessionRequestSeq &&
    res.status === 401 &&
    state.sessionActive
  ) {
    logout();
    $("#login-error").textContent = "Your session ended. Sign in again.";
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const retryAfter = res.headers.get("Retry-After");
    if (res.status === 429 && retryAfter) {
      throw new Error(
        `${body?.message || "Too many requests"}. Retry in ${retryAfter}s`
      );
    }
    const error = new Error(body?.message || `Request failed (${res.status})`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

function toast(message, type = "success", action = null) {
  // Several requests failing together (say, offline) report the same error.
  for (const existing of $$("#toast-container .toast")) {
    if (
      !existing.classList.contains("removing") &&
      existing.classList.contains(type) &&
      existing.firstChild?.textContent === message
    ) {
      return;
    }
  }
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const text = document.createElement("span");
  text.textContent = message;
  el.append(text);
  const dismiss = () => {
    el.classList.add("removing");
    setTimeout(() => el.remove(), 180);
  };
  if (action) {
    const button = document.createElement("button");
    button.className = "toast-action";
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      dismiss();
      action.run();
    });
    el.append(button);
  }
  $("#toast-container").appendChild(el);
  setTimeout(dismiss, action ? 6000 : 3500);
}

function setButtonBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  if (busy) button.classList.add("is-busy");
  else button.classList.remove("is-busy");
  button.setAttribute?.("aria-busy", String(busy));
}

function runAction(result) {
  Promise.resolve(result).catch((error) => {
    console.error(error);
    toast(error instanceof Error ? error.message : String(error), "error");
  });
}

const mutationKey = (operation, target) =>
  JSON.stringify([operation, String(target ?? "")]);

function mutationAttributes(operations, target = null) {
  const names = [operations].flat();
  const busy = names.some((name) =>
    state.pendingMutations.has(mutationKey(name, target))
  );
  return `data-mutation="${names.join(" ")}" data-mutation-target="${escapeHtml(target ?? "")}" aria-busy="${busy}"${busy ? " disabled" : ""}`;
}

function syncMutationControls() {
  for (const button of $$("[data-mutation]")) {
    const busy = button.dataset.mutation
      .split(" ")
      .some((operation) =>
        state.pendingMutations.has(
          mutationKey(operation, button.dataset.mutationTarget)
        )
      );
    setButtonBusy(button, busy);
  }
}

function sessionRequest() {
  const requestSeq = state.sessionRequestSeq;
  const isCurrent = () => requestSeq === state.sessionRequestSeq;
  const check = () => {
    if (!isCurrent()) throw new Error("Session changed");
  };
  const wait = async (promise) => {
    const value = await promise;
    check();
    return value;
  };
  const request = (...args) => {
    check();
    return wait(api(...args));
  };
  request.confirm = (...args) => {
    check();
    return wait(showConfirm(...args));
  };
  request.wait = wait;
  request.isCurrent = isCurrent;
  return request;
}

function runMutation(operation, target, run) {
  const key = mutationKey(operation, target);
  const existing = state.pendingMutations.get(key);
  if (existing) return existing.promise;
  const pending = {};
  state.pendingMutations.set(key, pending);
  syncMutationControls();
  pending.promise = (async () => {
    try {
      return await run();
    } finally {
      // The next session can start the same operation before this one settles.
      if (state.pendingMutations.get(key) === pending) {
        state.pendingMutations.delete(key);
        syncMutationControls();
      }
    }
  })();
  return pending.promise;
}

function mutation(operation, run, targetOf = (id) => id) {
  return async (...args) => {
    const request = sessionRequest();
    try {
      return await runMutation(operation, targetOf(...args), () =>
        run(request, ...args)
      );
    } catch (error) {
      if (request.isCurrent()) toast(error.message, "error");
    }
  };
}

let confirmResolve = null;
let confirmAnchor = null;
let confirmReturnFocus = null;

function setConfirmAnchor(element) {
  confirmAnchor = element;
}

function positionPopover(popover, anchor) {
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
  if (!rect?.width) {
    popover.style.left = `${Math.max(8, (innerWidth - width) / 2) + scrollX}px`;
    popover.style.top = `${innerHeight * 0.2 + scrollY}px`;
    return;
  }
  const left =
    rect.left + width <= innerWidth - 8
      ? rect.left
      : Math.max(8, rect.right - width);
  const below = rect.bottom + 6;
  const top =
    below + height > innerHeight - 8
      ? Math.max(8, rect.top - height - 6)
      : below;
  popover.style.left = `${left + scrollX}px`;
  popover.style.top = `${top + scrollY}px`;
}

function showConfirm(
  title,
  message,
  actionLabel = "Confirm",
  { extrasHtml = "", danger = false } = {}
) {
  if (confirmResolve) resolveConfirm(false);
  return new Promise((resolve) => {
    confirmResolve = resolve;
    const popover = $("#confirm");
    $("#confirm-title").textContent = title;
    $("#confirm-message").textContent = message;
    $("#confirm-extras").innerHTML = extrasHtml;
    const action = $("#btn-confirm-action");
    action.textContent = actionLabel;
    action.className = `btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`;
    confirmReturnFocus = confirmAnchor;
    popover.hidden = false;
    positionPopover(popover, confirmAnchor);
    popover.focus();
  });
}

function resolveConfirm(value) {
  const popover = $("#confirm");
  const wasOpen = popover.hidden === false;
  popover.hidden = true;
  if (confirmResolve) {
    confirmResolve(value);
    confirmResolve = null;
  }
  if (wasOpen && confirmReturnFocus?.isConnected) confirmReturnFocus.focus();
  confirmReturnFocus = null;
}

async function copyToClipboard(text, btn, confirmation = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    if (!btn?.isConnected) {
      toast(confirmation);
      return;
    }
    btn.dataset.confirmation = "Copied";
    btn.classList.add("copy-confirmed");
    setTimeout(() => {
      btn.classList.remove("copy-confirmed");
      delete btn.dataset.confirmation;
    }, 2000);
  } catch {
    toast("Failed to copy", "error");
  }
}

function syncConnectControls() {
  for (const group of $$(".seg[data-select]")) {
    const select = $(`#${group.dataset.select}`);
    for (const option of group.querySelectorAll("button")) {
      const selected = option.dataset.value === select.value;
      option.classList.toggle("on", selected);
      option.setAttribute("aria-checked", String(selected));
      option.disabled = select.disabled;
    }
  }
}

function clearReauthorization() {
  if (state.activeOAuth) return;
  state.reauthorizeAccountId = null;
  $("#oauth-reauthorize-target").style.display = "none";
  $("#oauth-provider").disabled = false;
  $("#oauth-codex-mode").disabled = false;
  $("#oauth-claude-mode").disabled = false;
  $("#btn-oauth-clear-target").disabled = false;
  syncConnectControls();
}

function updateOAuthProviderUI() {
  if (state.activeOAuth) return;
  const p = $("#oauth-provider").value;
  clearReauthorization();
  $("#oauth-codex-opts").style.display = p === "codex" ? "block" : "none";
  $("#oauth-claude-opts").style.display = p === "claude" ? "block" : "none";
}

function cancelOAuthFlow() {
  state.oauthRequestSeq++;
  $("#btn-oauth-start").dataset.mutationTarget = String(state.oauthRequestSeq);
  state.activeOAuth = null;
  $("#oauth-flow-active").style.display = "none";
  $("#oauth-flow-active").innerHTML = "";
  setButtonBusy($("#btn-oauth-start"), false);
  $("#btn-oauth-start").style.display = "";
  clearReauthorization();
}

function invalidateSessionRequests() {
  state.sessionRequestSeq++;
  state.dashboardAbort?.abort();
  state.dashboardRequestSeq++;
  state.accountsRequestSeq++;
  state.keysRequestSeq++;
  state.accountUsageRequestSeq++;
  state.keyUsageRequestSeq++;
  state.pendingMutations.clear();
  syncMutationControls();
  state.pendingResetRedemptions.clear();
  state.usageDetails.clear();
  state.visibleUsageDetails.clear();
  for (const timer of prefetchTimers.values()) clearTimeout(timer);
  prefetchTimers.clear();
  setButtonBusy($("#login-btn"), false);
  cancelOAuthFlow();
  resolveConfirm(false);
}

function logout() {
  state.sessionActive = false;
  invalidateSessionRequests();
  clearPersistedToken();
  state.token = "";
  state.accounts = [];
  state.accountsLoaded = false;
  state.overviewReady = false;
  state.accountsById = new Map();
  state.providerStatuses = [];
  state.accountUsageById = new Map();
  state.accountUsageWindowMs = DEFAULT_KEY_USAGE_WINDOW_MS;
  state.keys = [];
  state.keysById = new Map();
  state.keyUsageById = new Map();
  state.keyUsageWindowMs = DEFAULT_KEY_USAGE_WINDOW_MS;
  state.keysLoaded = false;
  state.showRevokedKeys = false;
  state.keyFilter = "";
  state.accountFilter = "";
  state.expandedAccountId = null;
  state.pendingExpandedAccountId = null;
  state.showAllReauthorize = false;
  state.expandedKeyId = null;
  state.pendingExpandedKeyId = null;
  state.cursorAccountId = null;
  state.cursorKeyId = null;
  state.editingKeyId = null;
  state.editingAccountId = null;
  state.creatingKey = false;
  state.setupOpen = false;
  state.setupKeyId = null;
  state.activeOAuth = null;
  state.reauthorizeAccountId = null;
  state.revealedKeyIds.clear();
  state.dashboardWindowMs = DEFAULT_KEY_USAGE_WINDOW_MS;
  state.dashboardData = null;
  state.dashboardError = null;
  state.dashboardLoading = false;
  $("#oauth-flow-active").style.display = "none";
  $("#oauth-flow-active").innerHTML = "";
  $("#dash-content").innerHTML = "";
  $("#overview-loading").hidden = true;
  $("#attention").innerHTML = "";
  $("#accounts-filter").value = "";
  $("#keys-filter").value = "";
  syncDashboardWindowButtons();
  syncAccountWindowButtons();
  $("#login-gate").classList.remove("hidden");
  $("#app").classList.remove("visible");
  $("#login-token").value = "";
  $("#login-error").textContent = "";
}

export {
  api,
  toast,
  setButtonBusy,
  runAction,
  mutationAttributes,
  syncMutationControls,
  sessionRequest,
  runMutation,
  mutation,
  setConfirmAnchor,
  resolveConfirm,
  copyToClipboard,
  syncConnectControls,
  clearReauthorization,
  updateOAuthProviderUI,
  cancelOAuthFlow,
  invalidateSessionRequests,
  logout,
};
