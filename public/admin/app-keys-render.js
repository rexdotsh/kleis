import {
  $,
  $$,
  PROVIDER_ORDER,
  accountById,
  checkedValues,
  escapeHtml,
  isKeyActive,
  modelsUrlForKey,
  mutationAttributes,
  state,
  syncMutationControls,
  usageForKey,
} from "./app-core.js";
import {
  DAY_MS,
  PROVIDERS,
  accountLabel,
  accountName,
  actionMutationAttributes,
  cacheReadRate,
  dateInputValue,
  fact,
  formFoot,
  formRow,
  formatCompact,
  hasTraffic,
  icon,
  kbd,
  keyName,
  maskKey,
  normalizeUsage,
  providerLabel,
  providerName,
  relativeTime,
  renderPreservingForm,
  renderWithMotion,
  requestsCellHtml,
  shortDate,
  shortId,
  untilText,
  usageFact,
  usageWindowLabel,
} from "./app-render-shared.js";
import { requestUsageDetail } from "./app-usage.js";
import { usageSlotHtml } from "./app-usage-render.js";

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

function keyFormHtml(mode, key = null) {
  const create = mode === "create";
  const prefix = create ? "key-" : "edit-key-";
  const rows = [
    formRow(
      "Label",
      "Shown in lists and usage.",
      `<input id="${prefix}label" class="field-input" type="text" maxlength="120" placeholder="my-laptop" autocomplete="off" value="${escapeHtml(key?.label || "")}">`,
      `${prefix}label`
    ),
    formRow(
      "Access",
      "Switch a provider off to block it. Each provider uses its primary account unless you pick one.",
      `<div id="${prefix}account-scopes" class="access">${keyAccessHtml(mode, key)}</div>`
    ),
    formRow(
      "Models",
      "Comma separated. Leave empty to allow every model.",
      `<input id="${prefix}model-scopes" class="field-input mono" type="text" placeholder="All models" autocomplete="off" spellcheck="false" value="${escapeHtml(key?.modelScopes?.join(", ") || "")}">`,
      `${prefix}model-scopes`
    ),
    create
      ? ""
      : formRow(
          "Expires",
          "Leave empty for a key that never expires.",
          `<input id="edit-key-expires-at" class="field-input field-date" type="date" value="${key.expiresAt ? dateInputValue(key.expiresAt) : ""}">`,
          "edit-key-expires-at"
        ),
  ];
  const submit = create
    ? `<button id="btn-submit-key" class="btn btn-primary btn-sm" data-action="submit-key" ${mutationAttributes("submit-key")} type="button">Create key</button>`
    : `<button id="btn-save-key" class="btn btn-primary btn-sm" data-action="save-key" data-key-id="${key.id}" ${mutationAttributes("save-key", key.id)} type="button">Save</button>`;
  return `<div class="${create ? "create-form" : "detail"} inline-form" data-form="${create ? "create-key" : `edit-key:${key.id}`}"${key ? ` data-detail-for="${key.id}"` : ""}>
    ${create ? '<div class="form-title">New API key</div>' : ""}
    <div class="form-rows">${rows.join("")}</div>
    ${formFoot(submit, create ? "cancel-create-key" : "cancel-edit-key")}
  </div>`;
}

// Each provider the key may use and the account it goes through.
function keyAccess(key) {
  const pinned = new Map();
  for (const accountId of key.accountScopes || []) {
    const account = accountById(accountId);
    if (account) pinned.set(account.provider, account);
  }
  const providers = key.providerScopes?.length
    ? PROVIDERS.filter((provider) => key.providerScopes.includes(provider))
    : PROVIDERS;
  return {
    restricted: providers.length < PROVIDERS.length,
    routes: providers.map((provider) => ({
      provider,
      account: pinned.get(provider) ?? null,
    })),
  };
}

function routeText(route, { named = false } = {}) {
  if (route.account) return `via ${accountName(route.account)}`;
  const primary = named
    ? state.accounts.find(
        (account) => account.provider === route.provider && account.isPrimary
      )
    : null;
  return primary ? `via primary (${accountName(primary)})` : "via primary";
}

// null when the key can use every provider through its primary account.
function keyScopeParts(key) {
  const { restricted, routes } = keyAccess(key);
  if (!(restricted || routes.some((route) => route.account))) return null;
  return routes.map((route) => ({
    provider: `${providerName(route.provider)}${routes.length === 1 ? " only" : ""}`,
    via: routeText(route),
  }));
}

const modelCountText = (key) =>
  key.modelScopes?.length
    ? `${key.modelScopes.length} model${key.modelScopes.length === 1 ? "" : "s"}`
    : "";

function keyScopeHtml(key) {
  const parts = keyScopeParts(key);
  const access = parts
    ? parts
        .map(
          (part) =>
            `${escapeHtml(part.provider)} <span class="muted">${escapeHtml(part.via)}</span>`
        )
        .join('<span class="muted"> \u00b7 </span>')
    : "All providers";
  const models = modelCountText(key);
  return models
    ? `${access} <span class="muted" title="${escapeHtml(key.modelScopes.join(", "))}">\u00b7 ${models}</span>`
    : access;
}

function keyScopeText(key) {
  const parts = keyScopeParts(key);
  return [
    parts
      ? parts.map((part) => `${part.provider} ${part.via}`).join(" \u00b7 ")
      : "All providers",
    modelCountText(key),
  ]
    .filter(Boolean)
    .join(" \u00b7 ");
}

function keyMatches(key, filter) {
  return [
    key.label,
    key.key,
    key.id,
    ...(key.providerScopes || []),
    ...(key.modelScopes || []),
  ].some((value) => value && String(value).toLowerCase().includes(filter));
}

function keyFacts(key) {
  const usage = normalizeUsage(usageForKey(key.id));
  const cached = cacheReadRate(usage.inputTotalTokens, usage.cacheReadTokens);
  const access = keyAccess(key);
  let expiry;
  if (key.revokedAt) {
    expiry = fact("Revoked", shortDate(key.revokedAt), [
      escapeHtml(relativeTime(key.revokedAt)),
    ]);
  } else if (key.expiresAt) {
    const expired = key.expiresAt <= Date.now();
    expiry = fact(
      "Expires",
      expired
        ? '<span class="err">Expired</span>'
        : escapeHtml(untilText(key.expiresAt)),
      [shortDate(key.expiresAt)]
    );
  } else {
    expiry = fact("Expires", "Never");
  }
  return [
    usageFact(usageForKey(key.id), state.keyUsageWindowMs),
    fact("Tokens", formatCompact(usage.totalTokens), [
      cached === null ? "" : `${cached}% cached input`,
      usage.outputTokens ? `${formatCompact(usage.outputTokens)} output` : "",
    ]),
    fact(
      "Access",
      escapeHtml(
        access.restricted
          ? `${access.routes.map((route) => providerName(route.provider)).join(", ")} only`
          : "All providers"
      ),
      [
        ...access.routes.map(
          (route) =>
            `${escapeHtml(providerName(route.provider))} ${escapeHtml(routeText(route, { named: true }))}`
        ),
        key.modelScopes?.length
          ? `<span title="${escapeHtml(key.modelScopes.join(", "))}">${escapeHtml(key.modelScopes.join(", "))}</span>`
          : "",
      ]
    ),
    expiry,
    fact("Created", key.createdAt ? shortDate(key.createdAt) : "\u2014", [
      `<span class="mono" title="${escapeHtml(key.id)}">${escapeHtml(key.id)}</span>`,
    ]),
  ].join("");
}

function keyDetailHtml(key) {
  if (state.editingKeyId === key.id) return keyFormHtml("edit", key);
  const revoked = Boolean(key.revokedAt);
  const revealed = state.revealedKeyIds.has(key.id);
  const button = (label, action, shortcut = "", cls = "btn btn-ghost btn-sm") =>
    `<button class="${cls}" data-action="${action}" data-key-id="${key.id}" ${actionMutationAttributes(action, key.id)} type="button">${label}${shortcut ? kbd(shortcut) : ""}</button>`;
  const keyLine = revealed
    ? `<div class="key-line"><code>${escapeHtml(key.key)}</code>${button("Copy", "copy-key")}${button("Hide", "toggle-key")}</div>`
    : "";
  const actions = revoked
    ? [
        button("Edit", "edit-key", "E"),
        button(
          "Delete",
          "delete-key",
          "Del",
          "btn btn-ghost btn-sm btn-remove"
        ),
      ]
    : [
        button("Copy key", "copy-key", "C"),
        button(revealed ? "Hide key" : "Show key", "toggle-key", "S"),
        button("Edit", "edit-key", "E"),
        button("Rotate", "rotate-key", "R"),
        button(
          "Revoke",
          "revoke-key",
          "Del",
          "btn btn-ghost btn-sm btn-remove"
        ),
      ];
  const entering = state.enteringDetail === `key:${key.id}` ? " entering" : "";
  return `<div class="detail${entering}" data-detail-for="${key.id}" data-flip="detail:${key.id}">
    ${keyLine}
    <div class="facts">${keyFacts(key)}</div>
    ${hasTraffic(usageForKey(key.id)) ? `<div class="usage-slot usage-grid" data-usage-for="key:${key.id}">${usageSlotHtml("key", key.id)}</div>` : ""}
    <div class="actions">${actions.join("")}<div class="right"><span>Collapse <span class="kbd">esc</span></span></div></div>
  </div>`;
}

function keyRowHtml(key) {
  const revoked = Boolean(key.revokedAt);
  const active = isKeyActive(key);
  const open = state.expandedKeyId === key.id;
  const usage = usageForKey(key.id);
  const metrics = normalizeUsage(usage);
  const expiringSoon =
    active && key.expiresAt && key.expiresAt - Date.now() < 3 * DAY_MS;
  let dot = "";
  if (!active) dot = "off";
  else if (expiringSoon) dot = "warn";
  let tag = "";
  if (revoked) tag = "Revoked";
  else if (!active) tag = "Expired";
  else if (key.expiresAt) tag = `Expires ${untilText(key.expiresAt)}`;
  const lastUsed = metrics.lastRequestAt
    ? relativeTime(metrics.lastRequestAt)
    : "\u2014";
  const name = keyName(key);
  const cursor = state.cursorKeyId === key.id ? " cursor" : "";

  return `<div class="row t-key${open ? " open" : ""}${active || open ? "" : " dim"}${cursor}" data-key-id="${key.id}" data-flip="key:${key.id}" tabindex="0" role="button" aria-expanded="${open}">
    <span class="name"><span class="dot ${dot}"></span><span class="ellipsis">${escapeHtml(name)}</span>${tag ? `<span class="tag${expiringSoon ? " warn" : ""}">${escapeHtml(tag)}</span>` : ""}</span>
    <span class="mono muted ellipsis d">${escapeHtml(maskKey(key.key))}</span>
    <span class="ellipsis d">${keyScopeHtml(key)}</span>
    <span class="num">${revoked && !metrics.requestCount ? '<span class="muted">\u2014</span>' : requestsCellHtml(usage)}</span>
    <span class="num muted d">${escapeHtml(lastUsed)}</span>
    <button class="more" type="button" data-menu="key" data-key-id="${key.id}" aria-label="Actions for ${escapeHtml(name)}" aria-haspopup="menu" aria-expanded="false">${icon("more")}</button>
    <span class="l2">${escapeHtml([maskKey(key.key), keyScopeText(key), metrics.lastRequestAt ? lastUsed : ""].filter(Boolean).join(" \u00b7 "))}</span>
  </div>${open ? keyDetailHtml(key) : ""}`;
}

function keyActivity(key) {
  const metrics = normalizeUsage(usageForKey(key.id));
  return [metrics.requestCount, metrics.lastRequestAt ?? 0];
}

function compareKeys(a, b) {
  const rank = (key) => {
    if (key.revokedAt) return 2;
    return isKeyActive(key) ? 0 : 1;
  };
  const [aCount, aLast] = keyActivity(a);
  const [bCount, bLast] = keyActivity(b);
  return (
    rank(a) - rank(b) ||
    bCount - aCount ||
    bLast - aLast ||
    (b.createdAt ?? 0) - (a.createdAt ?? 0)
  );
}

function renderKeys() {
  const { keys, showRevokedKeys } = state;
  const activeCount = keys.filter(isKeyActive).length;
  const revokedCount = keys.filter((key) => key.revokedAt).length;
  const filter = state.keyFilter.trim().toLowerCase();
  $("#keys-count").textContent = keys.length
    ? `${activeCount} active \u00b7 ${keys.length} total`
    : "";

  let visible = keys.filter(
    (key) => showRevokedKeys || !key.revokedAt || key.id === state.expandedKeyId
  );
  if (filter) visible = visible.filter((key) => keyMatches(key, filter));
  visible = [...visible].sort(compareKeys);

  const visibleIds = new Set(visible.map((key) => key.id));
  for (const id of state.revealedKeyIds) {
    if (!visibleIds.has(id)) state.revealedKeyIds.delete(id);
  }

  const toggle = revokedCount
    ? ` \u00b7 <button class="link" type="button" data-action="${showRevokedKeys ? "hide-revoked" : "show-revoked"}">${showRevokedKeys ? "Hide revoked" : `Show ${revokedCount} revoked`}</button>`
    : "";
  let foot = "";
  if (filter) {
    foot = `${visible.length} match${visible.length === 1 ? "" : "es"}${toggle}`;
  } else if (keys.length) {
    foot = `Showing ${visible.length === keys.length ? "all " : ""}${visible.length}${visible.length === keys.length ? "" : ` of ${keys.length}`}, most active first${toggle}`;
  }
  $("#keys-foot").innerHTML = foot ? `<span>${foot}</span>` : "";

  const createForm = state.creatingKey ? keyFormHtml("create") : "";
  let body;
  if (!keys.length) {
    body = createForm
      ? ""
      : '<div class="empty-state"><p>No API keys yet.</p><button class="btn btn-primary btn-sm" type="button" data-action="open-create-key">Create a key</button></div>';
  } else if (visible.length) {
    body = `<div class="row thead t-key"><span>Label</span><span class="d">Key</span><span class="d">Access</span><span class="num">Requests ${escapeHtml(usageWindowLabel(state.keyUsageWindowMs))}</span><span class="num d">Last used</span><span></span></div>${visible.map(keyRowHtml).join("")}`;
  } else {
    body = filter
      ? `<div class="empty-state"><p>No keys match \u201c${escapeHtml(state.keyFilter.trim())}\u201d.</p><button class="link small" type="button" data-action="clear-filter">Clear filter</button></div>`
      : '<div class="empty-state"><p>No active API keys.</p><button class="btn btn-primary btn-sm" type="button" data-action="open-create-key">Create a key</button></div>';
  }

  const list = $("#keys-list");
  renderWithMotion(
    list,
    () => renderPreservingForm(list, `${createForm}${body}`),
    {
      anchor: state.motionAnchor,
    }
  );
  syncMutationControls();
  if (state.creatingKey) syncScopedAccountAvailability("create");
  if (state.editingKeyId) syncScopedAccountAvailability("edit");
  const expanded = state.expandedKeyId;
  if (
    expanded &&
    expanded !== state.editingKeyId &&
    visibleIds.has(expanded) &&
    hasTraffic(usageForKey(expanded))
  ) {
    requestUsageDetail("key", expanded);
  }
  if (state.setupOpen) renderOpenCodeSetup();
}

function keyMenuItems(key) {
  const revoked = Boolean(key.revokedAt);
  const active = isKeyActive(key);
  return [
    !revoked && { label: "Copy key", action: "copy-key", shortcut: "C" },
    active &&
      modelsUrlForKey(key) && {
        label: "Copy models URL",
        action: "copy-models-url",
        shortcut: "M",
      },
    !revoked && {
      label: state.revealedKeyIds.has(key.id) ? "Hide key" : "Show key",
      action: "toggle-key",
      shortcut: "S",
    },
    { label: "Edit", action: "edit-key", shortcut: "E" },
    !revoked && { label: "Rotate", action: "rotate-key", shortcut: "R" },
    active &&
      modelsUrlForKey(key) && {
        label: "Use with OpenCode",
        action: "open-setup",
        shortcut: "U",
      },
    "separator",
    revoked
      ? {
          label: "Delete",
          action: "delete-key",
          shortcut: "Del",
          danger: true,
        }
      : {
          label: "Revoke",
          action: "revoke-key",
          shortcut: "Del",
          danger: true,
        },
  ];
}

/* OpenCode setup */

// OpenCode v2 loads models in its background service, so the URL goes into
// that service's environment; the key is entered with /connect.
function setupSnippet(key, { maskKey: masked = false } = {}) {
  return [
    "# Terminal",
    `opencode service set env OPENCODE_MODELS_URL "${modelsUrlForKey(key)}"`,
    "opencode",
    "",
    "# Inside OpenCode",
    "/connect",
    "# provider: kleis",
    `# key: ${masked ? maskKey(key.key) : key.key}`,
  ].join("\n");
}

const setupKeys = () =>
  state.keys
    .filter((key) => isKeyActive(key) && modelsUrlForKey(key))
    .sort(
      (a, b) =>
        normalizeUsage(usageForKey(b.id)).requestCount -
        normalizeUsage(usageForKey(a.id)).requestCount
    );

function renderOpenCodeSetup() {
  const panel = $("#opencode-setup");
  $("#btn-opencode")?.setAttribute("aria-expanded", String(state.setupOpen));
  if (!panel) return;
  panel.hidden = !state.setupOpen;
  if (!state.setupOpen) {
    panel.innerHTML = "";
    return;
  }
  const keys = setupKeys();
  const key =
    keys.find((candidate) => candidate.id === state.setupKeyId) ?? keys[0];
  const options = keys
    .map(
      (candidate) =>
        `<option value="${candidate.id}"${candidate === key ? " selected" : ""}>${escapeHtml(keyName(candidate))}</option>`
    )
    .join("");
  const body = key
    ? `<pre class="snippet-block">${escapeHtml(setupSnippet(key, { maskKey: !state.revealedKeyIds.has(key.id) }))}</pre>
      <p class="setup-note">Then pick a model marked Kleis in <span class="mono">/models</span>. Needs OpenCode v2.</p>`
    : '<p class="setup-note">No active keys yet. Create one first.</p>';
  panel.innerHTML = `<div class="setup">
    <div class="setup-head">
      <span class="setup-title">Use with OpenCode</span>
      ${keys.length ? `<select id="setup-key" class="field-input" aria-label="Key">${options}</select>` : ""}
      <div class="right">
        ${key ? `<button class="link small" type="button" data-action="copy-setup" data-key-id="${key.id}">Copy commands</button>` : ""}
        <button class="link small" type="button" data-action="close-setup">Close</button>
      </div>
    </div>
    ${body}
  </div>`;
}

export {
  renderKeyAccess,
  keyAccessHtml,
  selectedProviderScopes,
  selectedAccountScopes,
  syncScopedAccountAvailability,
  renderKeys,
  keyMenuItems,
  setupSnippet,
  renderOpenCodeSetup,
};
