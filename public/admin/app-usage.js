import { renderDailyTokens } from "./app-charts.js";
import { api, toast } from "./app-core.js";
import {
  accountById,
  accountUsageForId,
  escapeHtml,
  normalizeUsage,
  usageForKey,
} from "./app-format.js";
import {
  $,
  $$,
  DAILY_TOKEN_DAYS,
  USAGE_DETAIL_TTL_MS,
  prefetchTimers,
  state,
  syncDashboardWindowButtons,
} from "./app-state.js";
import {
  DASHBOARD_LOADING_HTML,
  renderDashboard,
  renderUsageSlot,
} from "./app-usage-render.js";

function switchToTab(name) {
  if (name !== "accounts") {
    state.pendingExpandedAccountId = null;
    scheduleUsagePrefetch("account", null);
  }
  if (name !== "keys") {
    state.pendingExpandedKeyId = null;
    scheduleUsagePrefetch("key", null);
  }
  for (const t of $$(".tab")) {
    const active = t.dataset.tab === name;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
    t.tabIndex = active ? 0 : -1;
  }
  for (const p of $$(".tab-panel"))
    p.classList.toggle("active", p.id === `panel-${name}`);
  for (const control of $$(".top-ctl")) {
    control.hidden = control.dataset.for !== name;
  }
  history.replaceState(null, "", `#${name}`);
  // The chart is sized to its container, which has no width while hidden.
  if (name === "usage" && state.dashboardData && !state.dashboardLoading) {
    renderDashboard(state.dashboardData);
  }
}

async function loadDashboard() {
  const el = $("#dash-content");
  const refreshButton = $("#btn-refresh-dash");
  const requestSeq = state.dashboardRequestSeq + 1;

  state.dashboardRequestSeq = requestSeq;
  state.dashboardLoading = true;
  state.dashboardAbort?.abort();
  const controller = new AbortController();
  state.dashboardAbort = controller;
  if (refreshButton) refreshButton.disabled = true;
  if (state.dashboardData) el.classList.add("is-loading");
  else {
    const loading = $("#overview-loading");
    loading.innerHTML = DASHBOARD_LOADING_HTML;
    loading.hidden = false;
    el.hidden = true;
    $("#attention").hidden = true;
  }

  try {
    const data = await api(
      `/admin/usage/dashboard?windowMs=${state.dashboardWindowMs}`,
      { signal: controller.signal }
    );

    if (requestSeq !== state.dashboardRequestSeq) return;

    if (typeof data.windowMs === "number") {
      state.dashboardWindowMs = data.windowMs;
      syncDashboardWindowButtons();
    }

    state.dashboardData = data;
    state.dashboardError = null;
  } catch (e) {
    if (requestSeq !== state.dashboardRequestSeq) return;
    const message = e instanceof Error ? e.message : "Failed to load usage";
    if (state.dashboardData) toast(message, "error");
    else state.dashboardError = message;
  } finally {
    if (requestSeq === state.dashboardRequestSeq) {
      state.dashboardLoading = false;
      el.classList.remove("is-loading");
      if (refreshButton) refreshButton.disabled = false;
      renderOverviewWhenReady();
    }
  }
}

function renderOverviewWhenReady() {
  if (!state.accountsLoaded || state.dashboardLoading) return;
  if (!(state.dashboardData || state.dashboardError)) return;
  renderDashboard(state.dashboardData || {});
  if (state.dashboardError) {
    const plot = $("#dash-content").querySelector(".plot");
    if (plot)
      plot.innerHTML = `<p class="usage-note err">${escapeHtml(state.dashboardError)}</p>`;
  }
}

function invalidateUsageDetails(kind) {
  for (const [key, entry] of state.usageDetails) {
    if (key.startsWith(`${kind}:`))
      state.usageDetails.set(key, {
        ...entry,
        status: entry.data ? "ready" : "stale",
        updatedAt: 0,
      });
  }
}

function pruneUsageDetails(kind, ids) {
  for (const key of state.usageDetails.keys()) {
    if (key.startsWith(`${kind}:`) && !ids.has(key.split(":")[1]))
      state.usageDetails.delete(key);
  }
  for (const key of state.visibleUsageDetails.keys()) {
    if (key.startsWith(`${kind}:`) && !ids.has(key.split(":")[1]))
      state.visibleUsageDetails.delete(key);
  }
}

function requestCachedDetail(cacheKey, path, render, notify) {
  const previous = state.usageDetails.get(cacheKey);
  if (previous?.status === "loading") {
    if (!notify) previous.notify = false;
    return previous.promise;
  }
  if (Date.now() - (previous?.updatedAt || 0) < USAGE_DETAIL_TTL_MS)
    return Promise.resolve(previous);
  const pending = { status: "loading", data: previous?.data, notify };
  state.usageDetails.set(cacheKey, pending);
  const requestSeq = state.sessionRequestSeq;
  pending.promise = (async () => {
    let entry;
    try {
      const data = await api(path);
      entry = { status: "ready", data, updatedAt: Date.now() };
    } catch (e) {
      entry = {
        status: "error",
        error: e.message,
        data: previous?.data,
        updatedAt: Date.now(),
      };
    }
    if (
      requestSeq !== state.sessionRequestSeq ||
      state.usageDetails.get(cacheKey) !== pending
    )
      return;
    state.usageDetails.set(cacheKey, entry);
    if (pending.notify) render();
    return entry;
  })();
  return pending.promise;
}

function requestUsageDetail(kind, id, { notify = true } = {}) {
  const windowMs =
    kind === "account" ? state.accountUsageWindowMs : state.keyUsageWindowMs;
  return requestCachedDetail(
    `${kind}:${id}:${windowMs}`,
    `/admin/${kind === "account" ? "accounts" : "keys"}/${id}/usage?windowMs=${windowMs}`,
    () => renderUsageSlot(kind, id),
    notify
  );
}

// Anthropic has no usage history for subscription accounts, so Claude
// accounts chart the tokens Kleis itself has proxied for them.
const hasDailyTokens = (id) => accountById(id)?.provider === "claude";

function requestDailyTokens(id, { notify = true } = {}) {
  return requestCachedDetail(
    `daily:${id}`,
    `/admin/accounts/${id}/daily-tokens?days=${DAILY_TOKEN_DAYS}`,
    () => renderDailyTokens(id),
    notify
  );
}

async function settleWithin(pending, timeoutMs) {
  let timer;
  await Promise.race([
    pending,
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

async function waitForDailyTokens(id, timeoutMs = 300) {
  if (!hasDailyTokens(id)) return;
  const cached = state.usageDetails.get(`daily:${id}`);
  const pending = requestDailyTokens(id);
  if (cached?.data) return;
  await settleWithin(pending, timeoutMs);
}

function usageHasTraffic(kind, id) {
  return (
    normalizeUsage(kind === "account" ? accountUsageForId(id) : usageForKey(id))
      .requestCount > 0
  );
}

async function waitForUsageDetail(kind, id, timeoutMs = 300) {
  if (!usageHasTraffic(kind, id)) return;
  const windowMs =
    kind === "account" ? state.accountUsageWindowMs : state.keyUsageWindowMs;
  const cached = state.usageDetails.get(`${kind}:${id}:${windowMs}`);
  const pending = requestUsageDetail(kind, id);
  if (cached?.data) return;
  await settleWithin(pending, timeoutMs);
}

function scheduleUsagePrefetch(kind, id) {
  clearTimeout(prefetchTimers.get(kind));
  prefetchTimers.delete(kind);
  const daily = kind === "account" && hasDailyTokens(id);
  if (!(id && (usageHasTraffic(kind, id) || daily))) return;
  const requestSeq = state.sessionRequestSeq;
  prefetchTimers.set(
    kind,
    setTimeout(() => {
      prefetchTimers.delete(kind);
      if (requestSeq !== state.sessionRequestSeq) return;
      if (usageHasTraffic(kind, id)) requestUsageDetail(kind, id);
      if (daily) requestDailyTokens(id);
    }, 120)
  );
}

export {
  switchToTab,
  loadDashboard,
  renderOverviewWhenReady,
  invalidateUsageDetails,
  pruneUsageDetails,
  requestUsageDetail,
  hasDailyTokens,
  requestDailyTokens,
  waitForDailyTokens,
  usageHasTraffic,
  waitForUsageDetail,
  scheduleUsagePrefetch,
};
