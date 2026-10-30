import {
  $,
  api,
  escapeHtml,
  keyById,
  mutation,
  parseCommaSeparatedList,
  runMutation,
  sessionRequest,
  state,
  syncKeyWindowButtons,
  toast,
  trimmedOrNull,
  usageMapFromList,
} from "./app-core.js";
import {
  renderKeyAccess,
  renderKeys,
  selectedAccountScopes,
  selectedProviderScopes,
  syncScopedAccountAvailability,
} from "./app-keys-render.js";
import {
  dateInputValue,
  maskKey,
  normalizeUsage,
  showLoading,
} from "./app-render-shared.js";
import {
  invalidateUsageDetails,
  pruneUsageDetails,
  requestUsageDetail,
} from "./app-usage.js";
import { renderDashboard } from "./app-usage-render.js";

async function loadKeyUsage() {
  const requestSeq = ++state.keyUsageRequestSeq;
  try {
    const usage = await api(
      `/admin/keys/usage?windowMs=${state.keyUsageWindowMs}`
    );
    if (requestSeq !== state.keyUsageRequestSeq) return;
    if (typeof usage.windowMs === "number") {
      state.keyUsageWindowMs = usage.windowMs;
      syncKeyWindowButtons();
    }
    const byId = usageMapFromList(usage.usage, "apiKeyId");
    const expanded = state.expandedKeyId;
    if (expanded && normalizeUsage(byId.get(expanded)).requestCount > 0)
      await requestUsageDetail("key", expanded, { notify: false });
    if (requestSeq !== state.keyUsageRequestSeq) return;
    state.keyUsageById = byId;
    renderKeys();
  } catch (e) {
    if (requestSeq !== state.keyUsageRequestSeq) return;
    toast(e.message, "error");
  }
}

async function loadKeys() {
  const requestSeq = ++state.keysRequestSeq;
  invalidateUsageDetails("key");
  if (!state.keysLoaded) showLoading("keys-list");
  try {
    const [keysResult, usageResult] = await Promise.allSettled([
      api("/admin/keys"),
      api(`/admin/keys/usage?windowMs=${state.keyUsageWindowMs}`),
    ]);

    if (keysResult.status !== "fulfilled") {
      const error = keysResult.reason;
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (requestSeq !== state.keysRequestSeq) return;

    state.keys = keysResult.value.keys || [];
    state.keysById = usageMapFromList(state.keys, "id");
    pruneUsageDetails("key", state.keysById);
    state.keysLoaded = true;

    if (usageResult.status === "fulfilled") {
      if (typeof usageResult.value.windowMs === "number") {
        state.keyUsageWindowMs = usageResult.value.windowMs;
      }
      state.keyUsageById = usageMapFromList(
        usageResult.value.usage,
        "apiKeyId"
      );
    } else {
      toast(
        usageResult.reason?.message || "Failed to load API key usage",
        "error"
      );
    }

    syncKeyWindowButtons();
    renderKeys();
    if (state.dashboardData && !state.dashboardLoading) {
      renderDashboard(state.dashboardData);
    }
  } catch (e) {
    if (requestSeq !== state.keysRequestSeq) return;
    if (!state.keysLoaded)
      $("#keys-list").innerHTML =
        `<div class="empty-state"><p class="err">${escapeHtml(e.message)}</p></div>`;
    toast(e.message, "error");
  }
}

function startCreateKey() {
  state.creatingKey = true;
  renderKeys();
  $("#key-label")?.focus?.();
}

function cancelCreateKey() {
  state.creatingKey = false;
  renderKeys();
}

async function createKeyAction(request) {
  const label = trimmedOrNull($("#key-label").value);
  const providerScopes = selectedProviderScopes("create");
  if (providerScopes?.length === 0) {
    toast("Turn on at least one provider", "error");
    return;
  }
  const accountScopes = selectedAccountScopes("create");
  const modelScopes = parseCommaSeparatedList($("#key-model-scopes").value);
  const body = {
    ...(label ? { label } : {}),
    ...(providerScopes ? { providerScopes } : {}),
    ...(accountScopes.length ? { accountScopes } : {}),
    ...(modelScopes.length ? { modelScopes } : {}),
  };

  const data = await request("/admin/keys", {
    method: "POST",
    body: JSON.stringify(body),
  });
  state.creatingKey = false;
  state.expandedKeyId = data.key.id;
  state.revealedKeyIds.add(data.key.id);
  toast("API key created");
  await loadKeys();
}

function startEditKey(id) {
  const key = keyById(id);
  if (!key) {
    toast("API key was not found", "error");
    return;
  }
  state.expandedKeyId = id;
  state.editingKeyId = id;
  renderKeys();
  renderKeyAccess("edit", key);
  syncScopedAccountAvailability("edit");
  $("#edit-key-label")?.focus?.();
}

function cancelEditKey() {
  state.editingKeyId = null;
  renderKeys();
}

async function saveKeyEditsAction(request) {
  const keyId = state.editingKeyId;
  const existing = keyById(keyId);
  if (!existing) {
    toast("API key was not found", "error");
    return;
  }

  const label = trimmedOrNull($("#edit-key-label").value);
  const providerScopes = selectedProviderScopes("edit");
  if (providerScopes?.length === 0) {
    toast("Turn on at least one provider", "error");
    return;
  }
  const accountScopes = selectedAccountScopes("edit");
  const modelScopes = parseCommaSeparatedList(
    $("#edit-key-model-scopes").value
  );

  const body = {
    label,
    providerScopes,
    accountScopes: accountScopes.length ? accountScopes : null,
    modelScopes: modelScopes.length ? modelScopes : null,
  };

  const expiresDate = $("#edit-key-expires-at").value.trim();
  const originalDate =
    existing.expiresAt == null ? "" : dateInputValue(existing.expiresAt);
  if (expiresDate !== originalDate) {
    if (expiresDate) {
      const parsedExpiresAt = new Date(`${expiresDate}T23:59:59`).getTime();
      if (!Number.isFinite(parsedExpiresAt)) {
        toast("Pick a valid expiry date", "error");
        return;
      }
      body.expiresAt = parsedExpiresAt;
    } else {
      body.expiresAt = null;
    }
  }

  await request(`/admin/keys/${keyId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  state.editingKeyId = null;
  toast("API key updated");
  await loadKeys();
}

async function rotateKeyAction(request, id) {
  const existing = keyById(id);
  if (!existing) {
    toast("API key was not found", "error");
    return;
  }

  const label = existing.label || maskKey(existing.key);
  const expired = existing.expiresAt && existing.expiresAt <= Date.now();
  const confirmed = await request.confirm(
    "Rotate API key?",
    `The current secret for "${label}" stops working immediately; usage history is kept.${expired ? " The key stays expired until you change its expiry." : ""}`,
    "Rotate",
    { danger: true }
  );
  if (!confirmed) return;

  const data = await request(`/admin/keys/${id}/rotate`, {
    method: "POST",
    body: "{}",
  });
  const key = keyById(id);
  if (key) Object.assign(key, data.key);
  state.expandedKeyId = id;
  state.revealedKeyIds.add(id);
  renderKeys();
  toast("API key rotated");
  await loadKeys();
}

function revokeKeyRequest(id) {
  const request = sessionRequest();
  return runMutation("revoke-key-request", id, async () => {
    if (keyById(id)?.revokedAt) return;
    await request(`/admin/keys/${id}/revoke`, { method: "POST" });
    const key = keyById(id);
    if (key) key.revokedAt = Date.now();
  });
}

async function revokeKeyAction(request, id) {
  const key = keyById(id);
  const label = key?.label || maskKey(key?.key || id);
  const confirmed = await request.confirm(
    "Revoke API key?",
    `Clients using "${label}" stop working immediately. This cannot be undone.`,
    "Revoke",
    { danger: true }
  );
  if (!confirmed) return;

  await request.wait(revokeKeyRequest(id));
  toast("Key revoked");
  await loadKeys();
}

async function deleteKeyAction(request, id) {
  const key = keyById(id);
  const label = key?.label || maskKey(key?.key || id);
  const confirmed = await request.confirm(
    "Delete revoked key?",
    `Delete "${label}" and its usage history permanently. This cannot be undone.`,
    "Delete",
    { danger: true }
  );
  if (!confirmed) return;

  await request(`/admin/keys/${id}`, { method: "DELETE" });
  state.revealedKeyIds.delete(id);
  toast("Key deleted");
  await loadKeys();
}

const createKey = mutation("submit-key", createKeyAction);
const saveKeyEdits = mutation(
  "save-key",
  saveKeyEditsAction,
  () => state.editingKeyId
);
const rotateKey = mutation("rotate-key", rotateKeyAction);
const revokeKey = mutation("revoke-key", revokeKeyAction);
const deleteKey = mutation("delete-key", deleteKeyAction);

export {
  loadKeyUsage,
  loadKeys,
  startCreateKey,
  cancelCreateKey,
  startEditKey,
  cancelEditKey,
  createKey,
  saveKeyEdits,
  rotateKey,
  revokeKey,
  deleteKey,
};
