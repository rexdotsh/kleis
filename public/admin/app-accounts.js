import { renderAccounts } from "./app-accounts-render.js";
import {
  $,
  accountById,
  api,
  escapeHtml,
  mutation,
  parseOptionalJsonObject,
  runAction,
  state,
  syncAccountWindowButtons,
  toast,
  trimmedOrNull,
  usageMapFromList,
} from "./app-core.js";
import { renderKeys } from "./app-keys-render.js";
import {
  normalizeUsage,
  providerLabel,
  showLoading,
} from "./app-render-shared.js";
import {
  resetConfirmation,
  resetFeedback,
  resetOfferFor,
  resetProviders,
} from "./app-reset-credits.js";
import {
  invalidateUsageDetails,
  pruneUsageDetails,
  renderOverviewWhenReady,
  requestUsageDetail,
  switchToTab,
} from "./app-usage.js";

async function loadAccounts() {
  const requestSeq = ++state.accountsRequestSeq;
  invalidateUsageDetails("account");
  invalidateUsageDetails("daily");
  if (!state.accounts.length) showLoading("accounts-list");
  try {
    const [accountsResult, usageResult] = await Promise.allSettled([
      api("/admin/accounts"),
      api(`/admin/accounts/usage?windowMs=${state.accountUsageWindowMs}`),
    ]);

    if (accountsResult.status !== "fulfilled") {
      const error = accountsResult.reason;
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (requestSeq !== state.accountsRequestSeq) return;

    const accounts = accountsResult.value.accounts || [];
    const missingQuotas = new Set(
      accounts.filter((account) => !account.quota).map((account) => account.id)
    );
    state.accounts = accounts.map((account) => ({
      ...account,
      quota: account.quota || state.accountsById.get(account.id)?.quota,
      profile: account.profile || state.accountsById.get(account.id)?.profile,
      claudeResets: account.quota
        ? account.claudeResets
        : state.accountsById.get(account.id)?.claudeResets,
    }));
    state.accountsById = usageMapFromList(state.accounts, "id");
    pruneUsageDetails("account", state.accountsById);
    pruneUsageDetails("daily", state.accountsById);
    state.providerStatuses = accountsResult.value.providers || [];

    if (usageResult.status === "fulfilled") {
      if (typeof usageResult.value.windowMs === "number") {
        state.accountUsageWindowMs = usageResult.value.windowMs;
      }
      state.accountUsageById = usageMapFromList(
        usageResult.value.usage,
        "providerAccountId"
      );
    } else {
      toast(
        usageResult.reason?.message || "Failed to load account usage",
        "error"
      );
    }

    syncAccountWindowButtons();

    renderAccounts();
    if (state.keysLoaded) {
      renderKeys();
    }
    runAction(finishAccountLoad(requestSeq, missingQuotas));
    return accounts;
  } catch (e) {
    if (requestSeq !== state.accountsRequestSeq) return;
    if (!state.accounts.length)
      $("#accounts-list").innerHTML =
        `<div class="empty-state"><p class="err">${escapeHtml(e.message)}</p></div>`;
    toast(e.message, "error");
    state.accountsLoaded = true;
    renderOverviewWhenReady();
  }
}

async function finishAccountLoad(requestSeq, missingQuotas) {
  await loadMissingQuotas(requestSeq, missingQuotas);
  if (requestSeq !== state.accountsRequestSeq) return;
  state.accountsLoaded = true;
  renderOverviewWhenReady();
}

// /admin/accounts returns cached limit snapshots without waiting on providers;
// accounts without one yet (after a deploy, or a new account) fill in here.
async function loadMissingQuotas(requestSeq, missingQuotas) {
  const missing = state.accounts.some(
    (account) =>
      (account.provider === "codex" || account.provider === "claude") &&
      (!account.quota || missingQuotas.has(account.id))
  );
  if (!missing) return;
  try {
    const { quotas, profiles, claudeResets } = await api(
      "/admin/accounts/quotas"
    );
    if (requestSeq !== state.accountsRequestSeq) return;
    let changed = false;
    for (const account of state.accounts) {
      const quota = quotas?.[account.id];
      if (quota) {
        account.quota = quota;
        changed = true;
      }
      const profile = profiles?.[account.id];
      if (profile) {
        account.profile = profile;
        changed = true;
      }
      if (claudeResets && account.id in claudeResets) {
        account.claudeResets = claudeResets[account.id];
        changed = true;
      }
    }
    if (changed) {
      renderAccounts();
      if (state.keysLoaded) renderKeys();
    }
  } catch (e) {
    if (requestSeq !== state.accountsRequestSeq) return;
    toast(`Failed to load account limits: ${e.message}`, "error");
  }
}

async function loadAccountUsage() {
  const requestSeq = ++state.accountUsageRequestSeq;
  try {
    const usage = await api(
      `/admin/accounts/usage?windowMs=${state.accountUsageWindowMs}`
    );
    if (requestSeq !== state.accountUsageRequestSeq) return;
    if (typeof usage.windowMs === "number") {
      state.accountUsageWindowMs = usage.windowMs;
      syncAccountWindowButtons();
    }
    const byId = usageMapFromList(usage.usage, "providerAccountId");
    const expanded = state.expandedAccountId;
    if (expanded && normalizeUsage(byId.get(expanded)).requestCount > 0)
      await requestUsageDetail("account", expanded, { notify: false });
    if (requestSeq !== state.accountUsageRequestSeq) return;
    state.accountUsageById = byId;
    renderAccounts();
  } catch (e) {
    if (requestSeq !== state.accountUsageRequestSeq) return;
    toast(e.message, "error");
  }
}

const markPrimary = (provider, id) => {
  for (const account of state.accounts) {
    if (account.provider === provider) account.isPrimary = account.id === id;
  }
};

// Switches at once and rolls back if the server refuses; the toast offers
// an undo instead of asking first.
async function setPrimaryAction(request, id, { isUndo = false } = {}) {
  const account = accountById(id);
  if (!account || account.isPrimary) return;
  const previous = state.accounts.find(
    (candidate) =>
      candidate.provider === account.provider && candidate.isPrimary
  );
  const name = account.label || account.accountId || id;
  markPrimary(account.provider, id);
  renderAccounts();
  document
    .querySelector(`#accounts-list [data-account-id="${id}"] .dot.primary`)
    ?.classList.add("pop");
  try {
    await request(`/admin/accounts/${id}/primary`, { method: "POST" });
    toast(
      `${name} is now the primary ${providerLabel(account.provider)} account`,
      "success",
      previous && !isUndo
        ? {
            label: "Undo",
            run: () => setPrimary(previous.id, { isUndo: true }),
          }
        : null
    );
  } catch (e) {
    if (!request.isCurrent()) return;
    markPrimary(account.provider, previous?.id ?? null);
    renderAccounts();
    toast(e.message, "error");
  }
}

async function toggleProviderAction(request, provider, enabled) {
  if (!enabled) {
    const confirmed = await request.confirm(
      `Disable ${providerLabel(provider)}?`,
      `All ${providerLabel(provider)} accounts stop receiving proxy traffic and its models disappear from model registries. You can re-enable it at any time.`,
      "Disable",
      { danger: true }
    );
    if (!confirmed) return;
  }

  const status = state.providerStatuses.find(
    (entry) => entry.provider === provider
  );
  const previous = status?.enabled;
  if (status) status.enabled = enabled;
  document
    .querySelector(
      `[data-action="toggle-provider"][data-provider="${provider}"]`
    )
    ?.setAttribute("aria-checked", String(enabled));
  setTimeout(() => {
    if (request.isCurrent()) renderAccounts();
  }, 180);
  try {
    await request(`/admin/accounts/providers/${provider}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
    toast(`${providerLabel(provider)} ${enabled ? "enabled" : "disabled"}`);
    await loadAccounts();
  } catch (e) {
    if (!request.isCurrent()) return;
    if (status) status.enabled = previous;
    renderAccounts();
    toast(e.message, "error");
  }
}

async function deleteAccountAction(request, id) {
  const account = accountById(id);
  const name = account?.label || account?.accountId || id;
  const confirmed = await request.confirm(
    "Remove account?",
    `Remove "${name}" and its stored tokens. This cannot be undone.`,
    "Remove",
    { danger: true }
  );
  if (!confirmed) return;

  await request(`/admin/accounts/${id}`, { method: "DELETE" });
  toast("Account removed");
  await loadAccounts();
}

async function refreshAccountAction(request, id) {
  await request(`/admin/accounts/${id}/refresh`, { method: "POST" });
  toast("Token refreshed");
  await loadAccounts();
}

async function redeemResetCreditAction(request, accountId) {
  const account = accountById(accountId);
  const offer = resetOfferFor(account);
  if (!offer?.canUse) return;
  const reset = resetProviders[account.provider];
  const attempt = reset.attemptFor(account, offer);
  const confirmation = resetConfirmation(account, offer);
  const confirmed = await request.confirm(
    confirmation.title,
    confirmation.message,
    confirmation.action,
    { extrasHtml: confirmation.extrasHtml, danger: confirmation.danger }
  );
  if (!confirmed) return;

  const current = accountById(accountId);
  if (!current || current.provider !== account.provider) return;
  reset.begin?.(current, attempt);
  renderAccounts();
  let response;
  let error;
  try {
    response = await request(
      `/admin/accounts/${accountId}/tracking/${account.provider}/reset-credits/consume`,
      { method: "POST", body: JSON.stringify(attempt.body) }
    );
  } catch (cause) {
    error = cause;
  }
  if (!request.isCurrent()) return;
  const feedback = reset.settle(
    accountById(accountId) || current,
    attempt,
    response,
    error
  );
  renderAccounts();
  const refreshed = feedback.refresh ? await loadAccounts() : null;
  if (!request.isCurrent()) return;
  const { message, type } = resetFeedback(
    feedback,
    offer,
    refreshed?.find((entry) => entry.id === accountId)
  );
  toast(
    message,
    type,
    feedback.retryAllowed
      ? {
          label: "Retry",
          run: () => {
            if (feedback.retryAllowed()) return redeemResetCredit(accountId);
          },
        }
      : null
  );
}

function startEditAccount(id) {
  if (!accountById(id)) {
    toast("Account was not found", "error");
    return;
  }
  state.expandedAccountId = id;
  state.editingAccountId = id;
  renderAccounts();
  $("#edit-account-label")?.focus?.();
}

function cancelEditAccount() {
  state.editingAccountId = null;
  renderAccounts();
}

async function saveAccountEditsAction(request) {
  const accountId = state.editingAccountId;
  if (!accountId) {
    toast("Account was not found", "error");
    return;
  }

  const label = trimmedOrNull($("#edit-account-label").value);
  const editableAccountId = trimmedOrNull($("#edit-account-account-id").value);
  const metadataRaw = $("#edit-account-metadata").value.trim();

  let metadata;
  try {
    metadata = parseOptionalJsonObject(metadataRaw, "Metadata");
  } catch (error) {
    toast(error.message, "error");
    return;
  }

  await request(`/admin/accounts/${accountId}`, {
    method: "PATCH",
    body: JSON.stringify({ label, accountId: editableAccountId, metadata }),
  });
  state.editingAccountId = null;
  toast("Account updated");
  await loadAccounts();
}

async function importAccountAction(request) {
  const provider = $("#import-provider").value;
  const accessToken = $("#import-access-token").value.trim();
  const refreshToken = $("#import-refresh-token").value.trim();
  const expiresAtRaw = $("#import-expires-at").value.trim();
  const accountId = trimmedOrNull($("#import-account-id").value);
  const label = trimmedOrNull($("#import-label").value);
  const metadataRaw = $("#import-metadata").value.trim();

  if (!accessToken || !refreshToken) {
    toast("Access and refresh tokens are required", "error");
    return;
  }

  const expiresAt = expiresAtRaw
    ? Number(expiresAtRaw)
    : Date.now() + 60 * 60 * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    toast("Expires at must be a valid unix timestamp", "error");
    return;
  }

  let metadata;
  try {
    metadata = parseOptionalJsonObject(metadataRaw, "Metadata");
  } catch (error) {
    toast(error.message, "error");
    return;
  }

  const body = { accessToken, refreshToken, expiresAt };
  if (accountId) body.accountId = accountId;
  if (label) body.label = label;
  if (metadata) body.metadata = metadata;

  await request(`/admin/accounts/${provider}/import`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  toast("Account imported");
  for (const id of [
    "import-access-token",
    "import-refresh-token",
    "import-expires-at",
    "import-account-id",
    "import-label",
    "import-metadata",
  ]) {
    $(`#${id}`).value = "";
  }
  switchToTab("accounts");
  await loadAccounts();
}

const setPrimary = mutation("set-primary", setPrimaryAction);
const toggleProvider = mutation("toggle-provider", toggleProviderAction);
const deleteAccount = mutation("delete-account", deleteAccountAction);
const refreshAccount = mutation("refresh-account", refreshAccountAction);
const redeemResetCredit = mutation(
  "redeem-reset-credit",
  redeemResetCreditAction
);
const saveAccountEdits = mutation(
  "save-account",
  saveAccountEditsAction,
  () => state.editingAccountId
);

const importAccount = mutation(
  "import-account",
  importAccountAction,
  () => null
);

export {
  loadAccounts,
  loadAccountUsage,
  startEditAccount,
  cancelEditAccount,
  setPrimary,
  toggleProvider,
  deleteAccount,
  refreshAccount,
  redeemResetCredit,
  saveAccountEdits,
  importAccount,
};
