import { loadAccounts } from "./app-accounts.js";
import {
  cancelOAuthFlow,
  copyToClipboard,
  mutation,
  mutationAttributes,
  syncConnectControls,
  toast,
} from "./app-core.js";
import { accountById, escapeHtml, providerLabel } from "./app-format.js";
import { accountName, providerName } from "./app-render-shared.js";
import { $, state } from "./app-state.js";
import { switchToTab } from "./app-usage.js";

async function reauthorizeAccountAction(request, id) {
  const account = accountById(id);
  if (!account || !["codex", "claude"].includes(account.provider)) return;
  if (state.activeOAuth) {
    const confirmed = await request.confirm(
      "Replace active OAuth flow?",
      "The current authorization code will no longer work in this form.",
      "Start over"
    );
    if (!confirmed) return;
    cancelOAuthFlow();
  }
  if ($("#btn-oauth-start").disabled) cancelOAuthFlow();
  state.reauthorizeAccountId = id;
  const target = $("#oauth-reauthorize-target");
  $("#oauth-reauthorize-label").textContent =
    `Reauthorizing ${account.label || account.accountId || providerLabel(account.provider)}. Its settings and API-key scopes stay attached.${account.provider === "claude" ? " Sign in to the same Claude account and organization; Kleis cannot check this for you." : ""}`;
  target.style.display = "flex";
  $("#oauth-provider").value = account.provider;
  $("#oauth-provider").disabled = true;
  $("#oauth-codex-opts").style.display =
    account.provider === "codex" ? "block" : "none";
  $("#oauth-claude-opts").style.display =
    account.provider === "claude" ? "block" : "none";
  if (account.provider === "claude") {
    $("#oauth-claude-mode").value = account.metadata?.oauthMode || "max";
    $("#oauth-claude-mode").disabled = true;
  }
  syncConnectControls();
  switchToTab("oauth");
  toast(`Reauthorizing ${account.label || account.provider}`);
}

async function startOAuthAction(request) {
  if (state.activeOAuth) return;
  const requestSeq = state.oauthRequestSeq;
  const provider = $("#oauth-provider").value;
  $("#btn-oauth-start").style.display = "none";
  const flow = $("#oauth-flow-active");
  flow.style.display = "block";
  renderOAuthLoading(
    provider,
    provider === "codex" && $("#oauth-codex-mode").value === "headless"
  );

  try {
    const body = {};
    if (provider === "codex")
      body.options = { mode: $("#oauth-codex-mode").value };
    else if (provider === "claude")
      body.options = { mode: $("#oauth-claude-mode").value };

    if (state.reauthorizeAccountId) {
      const target = accountById(state.reauthorizeAccountId);
      if (target?.provider !== provider)
        throw new Error("Reauthorization target does not match provider");
      body.options = {
        ...body.options,
        replaceAccountId: state.reauthorizeAccountId,
      };
    }

    const data = await request(`/admin/accounts/${provider}/oauth/start`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (requestSeq !== state.oauthRequestSeq) return;
    const account = accountById(state.reauthorizeAccountId);
    state.activeOAuth = {
      provider,
      ...data,
      accountName:
        account?.label || account?.accountId || (account ? account.id : null),
      mode: body.options?.mode || null,
    };
    $("#oauth-provider").disabled = true;
    $("#oauth-codex-mode").disabled = true;
    $("#oauth-claude-mode").disabled = true;
    $("#btn-oauth-clear-target").disabled = true;
    syncConnectControls();
    renderOAuthFlow(data, provider);
  } catch (e) {
    if (!request.isCurrent() || requestSeq !== state.oauthRequestSeq) return;
    toast(e.message, "error");
    flow.innerHTML = `<div class="flow"><p class="err">${escapeHtml(e.message)}</p><button id="btn-oauth-retry" class="btn btn-ghost" type="button">Start over</button></div>`;
    $("#btn-oauth-retry").addEventListener?.("click", cancelOAuthFlow);
  }
}

async function completeOAuthAction(request) {
  if (!state.activeOAuth) return;
  const requestSeq = state.oauthRequestSeq;
  try {
    const body = { state: state.activeOAuth.state };
    const codeInput = $("#oauth-code");
    if (codeInput) {
      const code = codeInput.value.trim();
      if (!code) throw new Error("Authorization code is required");
      body.code = code;
    }
    await request(
      `/admin/accounts/${state.activeOAuth.provider}/oauth/complete`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    );
    if (requestSeq !== state.oauthRequestSeq) return;
    toast(
      state.reauthorizeAccountId ? "Account reauthorized" : "Account connected"
    );
    cancelOAuthFlow();
    switchToTab("accounts");
    await loadAccounts();
  } catch (e) {
    if (!request.isCurrent() || requestSeq !== state.oauthRequestSeq) return;
    const error = $("#oauth-flow-error");
    error.textContent = `${e.message}. If this code was consumed or the flow expired, cancel and start over.`;
    error.hidden = false;
  }
}

const reauthorizeAccount = mutation(
  "reauthorize-account",
  reauthorizeAccountAction
);
const startOAuth = mutation(
  "start-oauth",
  startOAuthAction,
  () => state.oauthRequestSeq
);
const completeOAuth = mutation(
  "complete-oauth",
  completeOAuthAction,
  () => state.activeOAuth?.state
);

/* Connect */

function renderOAuthLoading(provider, isDevice) {
  const target = accountById(state.reauthorizeAccountId);
  const name = target ? accountName(target) : null;
  const container = $("#oauth-flow-active");
  container.innerHTML = `<div class="flow" aria-busy="true"><p class="flow-title">${name ? `Reauthorizing <strong>${escapeHtml(name)}</strong>` : `Signing in to ${escapeHtml(providerName(provider))}`}</p><div class="field"><span class="field-label">1 \u00b7 Open this link and approve</span><div class="input-row"><span class="bone flow-url-skeleton"></span><button class="btn btn-ghost btn-sm" type="button" disabled>Copy</button></div></div><div class="field"><span class="field-label">2 \u00b7 ${isDevice ? "Enter this code on that page" : "Paste the code you get back"}</span>${isDevice ? '<div class="device-code"><span class="bone"></span></div>' : '<div class="field-input flow-input-skeleton"><span class="bone"></span></div>'}</div><div class="flow-actions"><button class="btn btn-primary btn-block" type="button" disabled>${isDevice ? "I\u2019ve approved it" : "Connect account"}</button><button id="btn-oauth-loading-cancel" class="btn btn-ghost" type="button">Start over</button></div></div>`;
  $("#btn-oauth-loading-cancel").addEventListener?.("click", cancelOAuthFlow);
}

function renderOAuthFlow(data, provider) {
  const container = $("#oauth-flow-active");
  container.style.display = "block";
  $("#btn-oauth-start").style.display = "none";

  const isDevice = data.method === "auto";
  const target = state.activeOAuth?.accountName;
  const url = escapeHtml(data.authorizationUrl);
  const deviceCode = isDevice
    ? (data.instructions || "").replace(/^Enter code:\s*/i, "")
    : "";

  const steps = [
    `<div class="field"><span class="field-label">1 \u00b7 Open this link and approve</span><div class="input-row"><a class="mono ellipsis" href="${url}" target="_blank" rel="noopener">${url}</a><button class="btn btn-ghost btn-sm" type="button" id="btn-oauth-copy-url">Copy</button></div></div>`,
  ];
  if (isDevice) {
    steps.push(
      `<div class="field"><span class="field-label">2 \u00b7 Enter this code on that page</span><div class="device-code">${escapeHtml(deviceCode)}</div></div>`
    );
  } else {
    steps.push(
      `<div class="field"><label class="field-label" for="oauth-code">2 \u00b7 Paste the code you get back</label><input id="oauth-code" class="field-input mono" type="text" placeholder="${provider === "codex" ? "Code or callback URL" : "Authorization code"}" autocomplete="off" spellcheck="false"></div>`
    );
  }

  container.innerHTML = `<div class="flow">
    <p class="flow-title">${target ? `Reauthorizing <strong>${escapeHtml(target)}</strong>` : `Signing in to ${escapeHtml(providerName(provider))}`}</p>
    ${steps.join("")}
    <p id="oauth-flow-error" class="oauth-flow-error" role="alert" hidden></p>
    <div class="flow-actions">
      <button class="btn btn-primary btn-block" type="button" id="btn-oauth-complete" ${mutationAttributes("complete-oauth", data.state)}>${isDevice ? "I\u2019ve approved it" : "Connect account"}</button>
      <button class="btn btn-ghost" type="button" id="btn-oauth-cancel">Start over</button>
    </div>
  </div>`;

  $("#btn-oauth-complete").addEventListener("click", completeOAuth);
  $("#btn-oauth-cancel").addEventListener("click", cancelOAuthFlow);
  const copyUrl = $("#btn-oauth-copy-url");
  copyUrl.addEventListener("click", () =>
    copyToClipboard(data.authorizationUrl, copyUrl)
  );
  ($("#oauth-code") || $("#btn-oauth-complete")).focus();
}

export {
  reauthorizeAccount,
  startOAuth,
  completeOAuth,
  renderOAuthLoading,
  renderOAuthFlow,
};
