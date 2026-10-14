import { loadAccounts } from "./app-accounts.js";
import {
  api,
  invalidateSessionRequests,
  runAction,
  setButtonBusy,
} from "./app-core.js";
import { loadKeys } from "./app-keys.js";
import {
  $,
  clearPersistedToken,
  persistToken,
  readPersistedToken,
  state,
  syncAccountWindowButtons,
  syncDashboardWindowButtons,
  syncKeyWindowButtons,
} from "./app-state.js";
import { loadDashboard, switchToTab } from "./app-usage.js";
import { renderAttention } from "./app-usage-render.js";

// A saved token opens the app at once; the check runs alongside the data
// requests. Only a rejected token ends the session (api() handles the 401);
// a restart, timeout or 5xx keeps the saved token.
async function restoreSession() {
  const saved = readPersistedToken();
  if (!saved) return;
  invalidateSessionRequests();
  state.token = saved;
  enterApp();
  await api("/admin/session").catch(() => undefined);
}

async function handleLogin() {
  const token = $("#login-token").value.trim();
  if (!token) {
    $("#login-error").textContent = "Token is required";
    return;
  }
  invalidateSessionRequests();
  const requestSeq = state.sessionRequestSeq;
  state.token = token;
  const btn = $("#login-btn");
  setButtonBusy(btn, true);
  $("#login-error").textContent = "";
  try {
    await api("/admin/session");
    if (requestSeq !== state.sessionRequestSeq) return;
    persistToken(token);
    enterApp();
  } catch (e) {
    if (requestSeq !== state.sessionRequestSeq) return;
    $("#login-error").textContent =
      e?.status === 401
        ? "Invalid admin token"
        : e?.status
          ? `Could not reach Kleis: ${e.message}`
          : e?.message || "Could not reach Kleis";
    clearPersistedToken();
    state.token = "";
  } finally {
    if (requestSeq === state.sessionRequestSeq) setButtonBusy(btn, false);
  }
}

function enterApp() {
  state.sessionActive = true;
  $("#login-gate").classList.add("hidden");
  $("#app").classList.add("visible");
  const hash = location.hash.slice(1);
  switchToTab(hash && $(`#panel-${hash}`) ? hash : "usage");
  syncDashboardWindowButtons();
  syncAccountWindowButtons();
  syncKeyWindowButtons();
  renderAttention();
  runAction(loadDashboard());
  runAction(loadAccounts());
  runAction(loadKeys());
}

export { restoreSession, handleLogin, enterApp };
