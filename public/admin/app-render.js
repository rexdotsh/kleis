import {
  $,
  accountById,
  accountUsageForId,
  activeKeysWithModelsUrl,
  api,
  cacheHitRate,
  completeOAuth,
  copyToClipboard,
  escapeHtml,
  expiryCountdown,
  formatBucketTime,
  formatCompact,
  formatCount,
  hasUsageMetrics,
  isKeyActive,
  keyById,
  maskKey,
  metadataHtml,
  modelsUrlForKey,
  normalizeUsage,
  relativeTime,
  state,
  tokenStatus,
  usageForKey,
  usageMetaParts,
  usageWindowLabel,
} from "./app-data.js";

function accountCardHtml(account) {
  const s = tokenStatus(account.expiresAt);
  const name = account.label || account.accountId || account.id;
  const usage = accountUsageForId(account.id);
  const windowLabel = usageWindowLabel(state.accountUsageWindowMs);
  const shortId =
    account.id.length > 12
      ? `${account.id.slice(0, 8)}...${account.id.slice(-4)}`
      : account.id;

  const setPrimaryBtn = account.isPrimary
    ? ""
    : `<button class="btn btn-ghost btn-sm" data-action="set-primary" data-account-id="${account.id}" type="button">set primary</button>`;
  const editBtn = `<button class="btn btn-ghost btn-sm" data-action="edit-account" data-account-id="${account.id}" type="button">edit</button>`;

  const identityParts = [];
  if (account.accountId && account.accountId !== name) {
    identityParts.push(
      `<span class="card-meta-item"><span style="color:var(--text-tertiary)">account:</span> ${escapeHtml(account.accountId)}</span>`
    );
  }
  identityParts.push(
    `<span class="card-meta-item"><span style="color:var(--text-tertiary)">id:</span> ${escapeHtml(shortId)}</span>`
  );
  if (account.createdAt) {
    identityParts.push(
      `<span class="card-meta-item"><span style="color:var(--text-tertiary)">created:</span> ${escapeHtml(relativeTime(account.createdAt))}</span>`
    );
  }

  const usageParts = usageMetaParts(usage, { windowLabel });

  const meta = metadataHtml(account.metadata);

  return `<div class="card" data-account-id="${account.id}" style="cursor:pointer">
    <div class="card-top">
      <div class="card-identity">
        <span class="badge badge-${account.provider}">${account.provider}</span>
        <span class="card-label">${escapeHtml(name)}</span>
        ${account.isPrimary ? '<span class="badge badge-primary">primary</span>' : ""}
      </div>
      <div class="card-actions">
        ${editBtn}
        ${setPrimaryBtn}
        <button class="btn btn-ghost btn-sm" data-action="refresh-account" data-account-id="${account.id}" type="button">refresh</button>
        <button class="btn btn-danger btn-sm" data-action="delete-account" data-account-id="${account.id}" type="button">delete</button>
      </div>
    </div>
    <div class="card-status">
      <span class="status-dot ${s.class}"></span>
      <span>${s.label}</span>
      <span class="dot-sep"></span>
      <span>${escapeHtml(expiryCountdown(account.expiresAt))}</span>
      ${account.lastRefreshAt ? `<span class="dot-sep"></span><span title="${escapeHtml(new Date(account.lastRefreshAt).toLocaleString())}">refreshed ${escapeHtml(relativeTime(account.lastRefreshAt))}</span>` : ""}
      ${account.lastRefreshStatus && account.lastRefreshStatus !== "success" ? `<span class="dot-sep"></span><span style="color:var(--red)">${escapeHtml(account.lastRefreshStatus)}</span>` : ""}
    </div>
    <div class="card-meta">${identityParts.join("")}</div>
    ${usageParts.length ? `<div class="card-meta" style="margin-top:6px">${usageParts.join("")}</div>` : ""}
    ${meta ? `<div class="card-meta" style="margin-top:6px">${meta}</div>` : ""}
  </div>`;
}

function renderAccounts() {
  const { accounts } = state;
  $("#accounts-count").textContent = accounts.length
    ? `(${accounts.length})`
    : "";

  if (!accounts.length) {
    $("#accounts-list").innerHTML =
      '<div class="empty-state"><div class="empty-state-text">No provider accounts connected yet.</div><button class="btn btn-primary btn-sm" type="button" data-action="go-connect">connect a provider</button></div>';
    return;
  }

  $("#accounts-list").innerHTML = accounts.map(accountCardHtml).join("");
}

function keyCardHtml(key) {
  const revoked = !!key.revokedAt;
  const status = revoked ? "revoked" : isKeyActive(key) ? "active" : "expired";
  const isRevealed = state.revealedKeyIds.has(key.id);
  const keyDisplay = isRevealed ? key.key : maskKey(key.key);
  const usage = usageForKey(key.id);
  const windowLabel = usageWindowLabel(state.keyUsageWindowMs);
  const modelsUrl = status === "active" ? modelsUrlForKey(key) : null;

  const scopeBadges = key.providerScopes
    ? key.providerScopes
        .map((p) => `<span class="badge badge-${p}">${p}</span>`)
        .join(" ")
    : '<span style="color:var(--text-tertiary)">all providers</span>';

  const metaParts = [`<span class="card-meta-item">${scopeBadges}</span>`];

  metaParts.push(
    ...usageMetaParts(usage, {
      windowLabel,
      includeMaxLatency: true,
    })
  );
  if (!revoked && key.expiresAt) {
    metaParts.push(
      `<span class="card-meta-item"><span class="badge badge-${status}">${escapeHtml(expiryCountdown(key.expiresAt))}</span></span>`
    );
  }

  const providerUsageParts = [];
  if (usage?.providers?.length) {
    for (const pu of usage.providers) {
      const metrics = normalizeUsage(pu);
      const puRate = metrics.successRate;
      const ratePart = puRate !== null ? ` (${puRate}% ok)` : "";
      providerUsageParts.push(
        `<span class="card-meta-item"><span class="badge badge-${pu.provider}">${pu.provider}</span> ${formatCount(metrics.requestCount)} reqs${ratePart}</span>`
      );
    }
  }

  const actionButtons = revoked
    ? `<button class="btn btn-ghost btn-sm" data-action="edit-key" data-key-id="${key.id}" type="button">edit</button><button class="btn btn-danger btn-sm" data-action="delete-key" data-key-id="${key.id}" type="button">delete</button>`
    : `<button class="btn btn-ghost btn-sm" data-action="edit-key" data-key-id="${key.id}" type="button">edit</button><button class="btn btn-ghost btn-sm" data-action="rotate-key" data-key-id="${key.id}" type="button">rotate</button><button class="btn btn-danger btn-sm" data-action="revoke-key" data-key-id="${key.id}" type="button">revoke</button>`;

  return `<div class="card" data-key-id="${key.id}" style="cursor:pointer">
    <div class="card-top">
      <div class="card-identity">
        <span class="card-label">${escapeHtml(key.label || "untitled")}</span>
        <span class="badge badge-${status}">${status}</span>
      </div>
      <div class="card-actions">
        <button class="btn btn-ghost btn-sm" data-action="copy-key" data-key-id="${key.id}" type="button">copy</button>
        ${modelsUrl ? `<button class="btn btn-ghost btn-sm" data-action="copy-models-url" data-key-id="${key.id}" type="button">copy models url</button>` : ""}
        <button class="btn btn-ghost btn-sm" data-action="toggle-key" data-key-id="${key.id}" type="button">${isRevealed ? "hide" : "show"}</button>
        ${actionButtons}
      </div>
    </div>
    <div class="card-key"><code>${escapeHtml(keyDisplay)}</code></div>
    <div class="card-meta">${metaParts.join("")}</div>
    ${providerUsageParts.length ? `<div class="card-meta" style="margin-top:6px">${providerUsageParts.join("")}</div>` : ""}
  </div>`;
}

function renderKeys() {
  const { keys, showRevokedKeys } = state;
  const visibleKeys = showRevokedKeys
    ? keys
    : keys.filter((key) => !key.revokedAt);
  const hiddenRevokedCount = keys.length - visibleKeys.length;

  if (!showRevokedKeys && hiddenRevokedCount > 0) {
    $("#keys-count").textContent = `(${visibleKeys.length}/${keys.length})`;
  } else {
    $("#keys-count").textContent = visibleKeys.length
      ? `(${visibleKeys.length})`
      : "";
  }

  const showRevokedToggle = $("#toggle-show-revoked-keys");
  if (showRevokedToggle) {
    showRevokedToggle.checked = showRevokedKeys;
  }

  if (!visibleKeys.length) {
    if (keys.length && !showRevokedKeys) {
      $("#keys-list").innerHTML =
        '<div class="empty-state"><div class="empty-state-text">No active API keys. Revoked keys are hidden.</div><button class="btn btn-ghost btn-sm" type="button" data-action="show-revoked">show revoked</button></div>';
      return;
    }

    $("#keys-list").innerHTML =
      '<div class="empty-state"><div class="empty-state-text">No API keys created yet.</div><button class="btn btn-primary btn-sm" type="button" data-action="open-create-key">create one</button></div>';
    return;
  }

  const activeIds = new Set(visibleKeys.map((k) => k.id));
  for (const id of state.revealedKeyIds) {
    if (!activeIds.has(id)) state.revealedKeyIds.delete(id);
  }

  $("#keys-list").innerHTML = visibleKeys.map(keyCardHtml).join("");
}

const DETAIL_EMPTY_STATE_HTML =
  '<div class="empty-state"><div class="empty-state-text">No usage data in this window.</div></div>';

const DETAIL_LOADING_HTML =
  '<div class="loading-indicator"><span class="spinner spinner-lg"></span></div>';

function renderDetailStats(totals) {
  const metrics = normalizeUsage(totals);
  const rate = metrics.successRate ?? 0;
  const stats = [
    [formatCount(metrics.requestCount), "requests"],
    [`${rate}%`, "success"],
    [formatCount(metrics.clientErrorCount), "4xx other"],
    [formatCount(metrics.serverErrorCount), "5xx"],
    [formatCount(metrics.authErrorCount), "auth"],
    [formatCount(metrics.rateLimitCount), "429"],
    [`${formatCount(metrics.avgLatencyMs)}ms`, "avg latency"],
    [`${formatCount(metrics.maxLatencyMs)}ms`, "max latency"],
    [formatCount(metrics.inputTokens), "input tokens"],
    [formatCount(metrics.outputTokens), "output tokens"],
    [formatCount(metrics.cacheReadTokens), "cache read"],
    [formatCount(metrics.cacheWriteTokens), "cache write"],
  ];
  let html = `<div class="detail-stats">${stats.map(([v, l]) => `<div class="detail-stat"><div class="detail-stat-value">${v}</div><div class="detail-stat-label">${l}</div></div>`).join("")}</div>`;
  if (metrics.lastRequestAt) {
    html += `<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:16px">last request: ${escapeHtml(new Date(metrics.lastRequestAt).toLocaleString())}</div>`;
  }
  return html;
}

const USAGE_TABLE_HEADERS = [
  "reqs",
  "ok",
  "4xx other",
  "5xx",
  "auth",
  "429",
  "avg ms",
  "max ms",
  "input tok",
  "output tok",
  "cache read",
  "cache write",
];

const ENDPOINT_LEAD_COLS = [
  [
    "provider",
    (ep) => `<span class="badge badge-${ep.provider}">${ep.provider}</span>`,
  ],
  ["endpoint", (ep) => escapeHtml(ep.endpoint)],
];

const MODEL_LEAD_COLS = [
  [
    "provider",
    (modelRow) =>
      `<span class="badge badge-${modelRow.provider}">${modelRow.provider}</span>`,
  ],
  ["endpoint", (modelRow) => escapeHtml(modelRow.endpoint)],
  [
    "model",
    (modelRow) => `<code>${escapeHtml(modelRow.model || "(none)")}</code>`,
  ],
];

function usageTableHtml(rows, leadCols) {
  const headers = [...leadCols.map((c) => c[0]), ...USAGE_TABLE_HEADERS];
  let html = `<table class="detail-table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>`;
  for (const row of rows) {
    const metrics = normalizeUsage(row);
    const lead = leadCols.map((c) => `<td>${c[1](row)}</td>`).join("");
    html += `<tr>${lead}<td>${formatCount(metrics.requestCount)}</td><td>${formatCount(metrics.successCount)}</td><td>${metrics.clientErrorCount ? formatCount(metrics.clientErrorCount) : "-"}</td><td>${metrics.serverErrorCount ? formatCount(metrics.serverErrorCount) : "-"}</td><td>${metrics.authErrorCount ? formatCount(metrics.authErrorCount) : "-"}</td><td>${metrics.rateLimitCount ? formatCount(metrics.rateLimitCount) : "-"}</td><td>${formatCount(metrics.avgLatencyMs)}</td><td>${formatCount(metrics.maxLatencyMs)}</td><td>${formatCount(metrics.inputTokens)}</td><td>${formatCount(metrics.outputTokens)}</td><td>${formatCount(metrics.cacheReadTokens)}</td><td>${formatCount(metrics.cacheWriteTokens)}</td></tr>`;
  }
  html += "</tbody></table>";
  return html;
}

function renderUsageTable(title, rows, leadCols) {
  if (!rows.length) return "";
  return `<div class="detail-section-title">${title}</div><div style="overflow:auto">${usageTableHtml(rows, leadCols)}</div>`;
}

function renderBucketTimeline(buckets) {
  if (buckets.length <= 1) {
    return "";
  }

  const maxReqs = Math.max(
    ...buckets.map((bucket) => normalizeUsage(bucket).requestCount)
  );
  let html =
    '<div class="detail-section-title">request timeline (1m buckets)</div>';
  for (const b of buckets) {
    const metrics = normalizeUsage(b);
    const errPct = metrics.requestCount
      ? ((metrics.clientErrorCount +
          metrics.authErrorCount +
          metrics.rateLimitCount +
          metrics.serverErrorCount) /
          metrics.requestCount) *
        100
      : 0;
    const okPct = 100 - errPct;
    const pct = maxReqs ? (metrics.requestCount / maxReqs) * 100 : 0;
    const time = new Date(b.bucketStart).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    html += `<div class="detail-bar-row">
      <span class="detail-bar-label">${time}</span>
      <div class="detail-bar-track">
        <div class="detail-bar-fill" style="width:${pct * (okPct / 100)}%;background:var(--green)"></div>
        <div class="detail-bar-fill" style="width:${pct * (errPct / 100)}%;background:var(--red)"></div>
      </div>
      <span class="detail-bar-count">${metrics.requestCount}</span>
    </div>`;
  }

  return html;
}

function renderTokenBucketTable(buckets) {
  if (!buckets.length) {
    return "";
  }

  let html =
    '<div class="detail-section-title">token timeline (1m buckets)</div>';
  html +=
    '<div style="overflow:auto"><table class="detail-table"><thead><tr><th>bucket</th><th>input tok</th><th>output tok</th><th>cache read</th><th>cache write</th><th>total tok</th></tr></thead><tbody>';

  for (const bucket of buckets) {
    const metrics = normalizeUsage(bucket);
    const bucketLabel = new Date(bucket.bucketStart).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    html += `<tr><td>${bucketLabel}</td><td>${formatCount(metrics.inputTokens)}</td><td>${formatCount(metrics.outputTokens)}</td><td>${formatCount(metrics.cacheReadTokens)}</td><td>${formatCount(metrics.cacheWriteTokens)}</td><td>${formatCount(metrics.totalTokens)}</td></tr>`;
  }

  html += "</tbody></table></div>";
  return html;
}

function renderKeyDetailBody(data) {
  const { totals } = data;
  if (!totals.requestCount) {
    return DETAIL_EMPTY_STATE_HTML;
  }

  return [
    renderDetailStats(totals),
    renderUsageTable(
      "by provider / endpoint",
      data.endpoints,
      ENDPOINT_LEAD_COLS
    ),
    renderUsageTable(
      "by provider / endpoint / model",
      data.models || [],
      MODEL_LEAD_COLS
    ),
    renderBucketTimeline(data.buckets),
    renderTokenBucketTable(data.buckets),
  ].join("");
}

function apiKeyDisplayHtml(apiKeyId) {
  const key = keyById(apiKeyId);
  if (key) {
    return escapeHtml(key.label || maskKey(key.key));
  }
  return `<code>${escapeHtml(apiKeyId.slice(0, 8))}...</code>`;
}

function renderAccountDetailBody(data) {
  const { totals } = data;
  if (!totals.requestCount) {
    return DETAIL_EMPTY_STATE_HTML;
  }

  return [
    renderDetailStats(totals),
    renderUsageTable("by API key", data.apiKeys, [
      ["api key", (k) => apiKeyDisplayHtml(k.apiKeyId)],
    ]),
    renderUsageTable(
      "by provider / endpoint",
      data.endpoints,
      ENDPOINT_LEAD_COLS
    ),
    renderUsageTable(
      "by provider / endpoint / model",
      data.models || [],
      MODEL_LEAD_COLS
    ),
    renderBucketTimeline(data.buckets),
    renderTokenBucketTable(data.buckets),
  ].join("");
}

async function openUsageDetailModal({ title, path, renderBody }) {
  $("#key-detail-title").textContent = title;
  $("#key-detail-body").innerHTML = DETAIL_LOADING_HTML;
  $("#modal-key-detail").classList.add("open");

  try {
    const data = await api(path);
    $("#key-detail-body").innerHTML = renderBody(data);
  } catch (e) {
    $("#key-detail-body").innerHTML =
      `<div class="empty-state"><div class="empty-state-text" style="color:var(--red)">${escapeHtml(e.message)}</div></div>`;
  }
}

async function openKeyDetail(keyId) {
  const key = keyById(keyId);
  const label = key?.label || maskKey(key?.key || keyId);
  await openUsageDetailModal({
    title: label,
    path: `/admin/keys/${keyId}/usage?windowMs=${state.keyUsageWindowMs}`,
    renderBody: renderKeyDetailBody,
  });
}

async function openAccountDetail(accountId) {
  const account = accountById(accountId);
  const label = account?.label || account?.accountId || accountId;
  const title = account
    ? `${account.provider} account: ${label}`
    : `account: ${label}`;

  await openUsageDetailModal({
    title,
    path: `/admin/accounts/${accountId}/usage?windowMs=${state.accountUsageWindowMs}`,
    renderBody: renderAccountDetailBody,
  });
}

function setupSnippet(key) {
  if (!key) {
    return [
      "# No active API keys with a models URL.",
      "# Create an API key first, then reopen this dialog.",
    ].join("\n");
  }

  const modelsUrl = modelsUrlForKey(key);
  return [
    "# Terminal",
    `export OPENCODE_MODELS_URL="${modelsUrl}"`,
    "opencode models --refresh",
    "opencode",
    "",
    "# Inside OpenCode",
    "/connect",
    "# provider: kleis",
    `# token: ${key.key}`,
  ].join("\n");
}

function openSetupModal() {
  const select = $("#setup-key-select");
  const snippet = $("#setup-snippet");
  if (!select || !snippet) return;

  const keys = activeKeysWithModelsUrl();

  select.innerHTML = keys.length
    ? keys
        .map(
          (k) =>
            `<option value="${k.id}">${escapeHtml(k.label || maskKey(k.key))}</option>`
        )
        .join("")
    : '<option value="">no active keys</option>';

  const selected = keys.length ? keys[0] : null;
  snippet.textContent = setupSnippet(selected);
  $("#modal-opencode-setup").classList.add("open");
}

function showKeyReveal(fullKey) {
  const reveal = document.createElement("div");
  reveal.className = "key-reveal";
  const value = document.createElement("span");
  value.className = "key-reveal-value";
  value.textContent = fullKey;
  reveal.append(value);
  const btn = document.createElement("button");
  btn.className = "btn btn-ghost btn-sm";
  btn.type = "button";
  btn.textContent = "copy";
  btn.addEventListener("click", () => copyToClipboard(fullKey, btn));
  reveal.append(btn);
  $("#keys-list").prepend(reveal);
  setTimeout(() => reveal.remove(), 30_000);
}

function renderOAuthFlow(data, provider) {
  const container = $("#oauth-flow-active");
  container.style.display = "block";

  const urlStep = `<div class="oauth-step"><span class="oauth-step-num">1</span><div><div style="margin-bottom:4px">Open the authorization page:</div><div class="oauth-url"><a href="${escapeHtml(data.authorizationUrl)}" target="_blank" rel="noopener">${escapeHtml(data.authorizationUrl)}</a></div></div></div>`;

  const instrStep = data.instructions
    ? `<div class="oauth-step"><span class="oauth-step-num">2</span><div><div class="oauth-instructions">${escapeHtml(data.instructions)}</div></div></div>`
    : "";

  const lastNum = data.instructions ? 3 : 2;
  const isDevice = data.method === "auto";

  const completeStep = isDevice
    ? '<div style="margin-bottom:8px">Once you have authorized, click complete:</div><button class="btn btn-primary" type="button" id="btn-oauth-complete">complete flow</button>'
    : '<div style="margin-bottom:8px">After authorizing, paste callback code or full callback URL:</div><input id="oauth-code" class="field-input" type="text" placeholder="code or callback URL" style="margin-bottom:8px"><button class="btn btn-primary" type="button" id="btn-oauth-complete">complete flow</button>';

  container.innerHTML = `<div class="oauth-flow-panel">
    <div class="oauth-flow-title">Active Flow: <span class="badge badge-${provider}">${provider}</span></div>
    ${urlStep}${instrStep}
    <div class="oauth-step"><span class="oauth-step-num">${lastNum}</span><div>${completeStep}</div></div>
  </div>`;

  $("#btn-oauth-complete").addEventListener("click", completeOAuth);
}

function dashDelta(current, previous) {
  if (!previous || previous === 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function dashDeltaHtml(value, inverted) {
  if (value === null || value === undefined) return "";
  const sign = value > 0 ? "+" : "";
  const cls =
    value === 0
      ? "neutral"
      : value > 0 !== (inverted || false)
        ? "positive"
        : "negative";
  return `<div class="dash-kpi-delta ${cls}">${sign}${value}% vs prev</div>`;
}

function renderDashKpis(m, pm) {
  const cr = cacheHitRate(m.inputTokens, m.cacheReadTokens);
  const prevCr = cacheHitRate(pm.inputTokens, pm.cacheReadTokens);

  const kpis = [
    {
      label: "requests",
      value: formatCompact(m.requestCount),
      delta: dashDelta(m.requestCount, pm.requestCount),
      accent: "var(--amber)",
    },
    {
      label: "success rate",
      value: m.successRate !== null ? `${m.successRate}%` : "-",
      delta: dashDelta(
        m.successRate ?? 0,
        pm.requestCount
          ? Math.round((pm.successCount / pm.requestCount) * 100)
          : 0
      ),
      accent: "var(--green)",
    },
    {
      label: "tokens",
      value: formatCompact(m.totalTokens),
      delta: dashDelta(m.totalTokens, pm.inputTokens + pm.outputTokens),
      accent: "var(--amber)",
    },
    {
      label: "cache hit",
      value: `${cr}%`,
      delta: dashDelta(cr, prevCr),
      accent: "var(--copilot)",
    },
    {
      label: "avg latency",
      value: `${formatCount(m.avgLatencyMs)}ms`,
      delta: dashDelta(m.avgLatencyMs, pm.avgLatencyMs),
      inverted: true,
      accent: "var(--text-secondary)",
    },
  ];

  return `<div class="dash-kpi-row">${kpis
    .map(
      (k) =>
        `<div class="dash-kpi" style="border-top-color:${k.accent}"><div class="dash-kpi-label">${k.label}</div><div class="dash-kpi-value">${k.value}</div>${dashDeltaHtml(k.delta, k.inverted)}</div>`
    )
    .join("")}</div>`;
}

function renderSvgBarChart(buckets, seriesExtractor, bucketSizeMs) {
  if (!buckets.length) return "";

  const bucketSeries = buckets.map((bucket) => {
    const series = seriesExtractor(bucket);
    let total = 0;
    for (const item of series) total += item.value;
    return { bucket, series, total };
  });

  const W = 700;
  const H = 140;
  const PL = 44;
  const PR = 8;
  const PT = 12;
  const PB = 24;
  const chartW = W - PL - PR;
  const chartH = H - PT - PB;

  let maxVal = 0;
  for (const item of bucketSeries) {
    if (item.total > maxVal) maxVal = item.total;
  }
  if (maxVal === 0) return "";

  const step = chartW / bucketSeries.length;
  const barW = Math.max(1.5, Math.min(12, step * 0.8));

  let svg = `<svg class="dash-chart-svg" viewBox="0 0 ${W} ${H}">`;

  const gridValues = [maxVal, Math.round(maxVal / 2), 0];
  for (let i = 0; i < gridValues.length; i++) {
    const y = PT + (chartH * i) / 2;
    svg += `<line x1="${PL}" y1="${y}" x2="${W - PR}" y2="${y}" stroke="var(--border-subtle)" stroke-width="0.5"/>`;
    svg += `<text x="${PL - 4}" y="${y + 3}" text-anchor="end" fill="var(--text-tertiary)" font-size="9" font-family="var(--font-mono)">${formatCompact(gridValues[i])}</text>`;
  }

  for (let i = 0; i < bucketSeries.length; i++) {
    const item = bucketSeries[i];
    const x = PL + i * step + (step - barW) / 2;
    let currentY = PT + chartH - (item.total / maxVal) * chartH;
    for (const s of item.series) {
      const h = (s.value / maxVal) * chartH;
      if (h > 0.5) {
        const tip = `${formatBucketTime(item.bucket.bucketStart, bucketSizeMs)}: ${formatCount(s.value)} ${s.label}`;
        svg += `<rect x="${x}" y="${currentY}" width="${barW}" height="${h}" fill="${s.color}" rx="0.5"><title>${escapeHtml(tip)}</title></rect>`;
        currentY += h;
      }
    }
  }

  const labelCount = Math.min(6, bucketSeries.length);
  if (labelCount > 1) {
    const labelStep = Math.max(1, Math.floor(bucketSeries.length / labelCount));
    for (let i = 0; i < bucketSeries.length; i += labelStep) {
      const x = PL + i * step + step / 2;
      svg += `<text x="${x}" y="${H - 4}" text-anchor="middle" fill="var(--text-tertiary)" font-size="8" font-family="var(--font-mono)">${escapeHtml(formatBucketTime(bucketSeries[i].bucket.bucketStart, bucketSizeMs))}</text>`;
    }
  }

  svg += "</svg>";
  return svg;
}

function requestSeriesExtractor(bucket) {
  const m = normalizeUsage(bucket);
  const errCount =
    m.clientErrorCount +
    m.serverErrorCount +
    m.authErrorCount +
    m.rateLimitCount;
  return [
    { value: m.successCount, color: "var(--green)", label: "success" },
    { value: errCount, color: "var(--red)", label: "errors" },
  ];
}

function tokenSeriesExtractor(bucket) {
  const m = normalizeUsage(bucket);
  return [
    { value: m.inputTokens, color: "var(--amber)", label: "input" },
    { value: m.outputTokens, color: "var(--green)", label: "output" },
  ];
}

function renderProviderBreakdown(providers, totalMetrics) {
  if (!providers.length) return "";
  let html = '<div class="dash-provider-grid">';
  for (const p of providers) {
    const pm = normalizeUsage(p);
    const pct = totalMetrics.requestCount
      ? Math.round((pm.requestCount / totalMetrics.requestCount) * 100)
      : 0;
    const barPct = pct > 0 ? Math.max(pct, 2) : 0;
    const tokTotal = pm.inputTokens + pm.outputTokens;
    const cr = cacheHitRate(pm.inputTokens, pm.cacheReadTokens);
    html += `<div class="dash-provider-row">
      <div class="dash-provider-info">
        <span class="badge badge-${p.provider}">${p.provider}</span>
        <span class="dash-provider-pct">${pct}%</span>
      </div>
      <div class="dash-provider-track">
        <div class="dash-provider-fill" style="width:${barPct}%;background:var(--${p.provider})"></div>
      </div>
      <span class="dash-provider-stat">${formatCount(pm.requestCount)} reqs</span>
      <span class="dash-provider-stat">${formatCompact(tokTotal)} tok</span>
      <span class="dash-provider-stat">${cr}% cache</span>
    </div>`;
  }
  html += "</div>";
  return html;
}

function renderDashTable(title, rows, leadCols) {
  if (!rows.length) return "";
  return `<div class="dash-card" style="overflow:auto"><div class="dash-chart-title">${title}</div>${usageTableHtml(rows, leadCols)}</div>`;
}

const DASH_KEY_LEAD_COLS = [["key", (row) => apiKeyDisplayHtml(row.apiKeyId)]];

function renderDashboard(data) {
  const el = $("#dash-content");
  if (!data || !data.totals) {
    el.innerHTML =
      '<div class="dash-empty">No usage data in this window.</div>';
    return;
  }

  const m = normalizeUsage(data.totals);
  if (!hasUsageMetrics(m)) {
    el.innerHTML =
      '<div class="dash-empty">No usage data in this window.</div>';
    return;
  }

  const {
    previousTotals,
    byProvider = [],
    byEndpoint = [],
    byModel = [],
    byKey = [],
    buckets = [],
    bucketSizeMs,
  } = data;
  const pm = normalizeUsage(previousTotals);

  let html = renderDashKpis(m, pm);

  const reqChart = renderSvgBarChart(
    buckets,
    requestSeriesExtractor,
    bucketSizeMs
  );
  const tokChart = renderSvgBarChart(
    buckets,
    tokenSeriesExtractor,
    bucketSizeMs
  );

  if (reqChart || tokChart) {
    html += '<div class="dash-grid-2">';
    if (reqChart) {
      html += `<div class="dash-card"><div class="dash-chart-title">request volume</div>${reqChart}<div class="dash-legend"><span class="dash-legend-item"><span class="dash-legend-dot" style="background:var(--green)"></span>success</span><span class="dash-legend-item"><span class="dash-legend-dot" style="background:var(--red)"></span>errors</span></div></div>`;
    }
    if (tokChart) {
      html += `<div class="dash-card"><div class="dash-chart-title">token usage</div>${tokChart}<div class="dash-legend"><span class="dash-legend-item"><span class="dash-legend-dot" style="background:var(--amber)"></span>input</span><span class="dash-legend-item"><span class="dash-legend-dot" style="background:var(--green)"></span>output</span></div></div>`;
    }
    html += "</div>";
  }

  if (byProvider.length) {
    html += `<div class="dash-card"><div class="dash-chart-title">by provider</div>${renderProviderBreakdown(byProvider, m)}</div>`;
  }

  html += renderDashTable("by model", byModel, MODEL_LEAD_COLS);
  html += renderDashTable("by API key", byKey, DASH_KEY_LEAD_COLS);
  html += renderDashTable("by endpoint", byEndpoint, ENDPOINT_LEAD_COLS);

  if (m.lastRequestAt) {
    html += `<div class="dash-last-request">last request: ${escapeHtml(new Date(m.lastRequestAt).toLocaleString())}</div>`;
  }

  el.innerHTML = html;
}

export {
  DETAIL_LOADING_HTML,
  openAccountDetail,
  openKeyDetail,
  openSetupModal,
  renderAccounts,
  renderDashboard,
  renderKeys,
  renderOAuthFlow,
  setupSnippet,
  showKeyReveal,
};
