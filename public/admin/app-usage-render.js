import { isAccountVisible } from "./app-account-visibility.js";
import {
  $,
  accountById,
  accountUsageForId,
  escapeHtml,
  keyById,
  state,
} from "./app-core.js";
import {
  DAY_MS,
  SKELETON_HTML,
  accountIssues,
  accountName,
  cacheReadRate,
  formatCompact,
  formatCount,
  icon,
  isAccountServing,
  keyName,
  normalizeUsage,
  providerName,
  providerStatusMap,
  renderWithMotion,
  requestsCellHtml,
  shortDate,
  successRateText,
  usageWindowLabel,
} from "./app-render-shared.js";

/* Usage inside expanded rows */

function usagePanelHtml(table, columns, message = "", loading = false) {
  const placeholder = loading
    ? Array.from(
        { length: 3 },
        () => `<div class="row skeleton"><span class="bone"></span></div>`
      ).join("")
    : `<p class="usage-note muted">${escapeHtml(message || "No usage in this window.")}</p>`;
  if (!(loading || message || table.body)) return "";
  const status = message
    ? ` <span class="usage-status err" title="${escapeHtml(message)}">Unavailable</span>`
    : "";
  return `<div class="usage-panel"><div class="list usage-table"><div class="row thead ${columns}"><span>${table.title}${status}</span>${table.head}</div>${table.body || placeholder}</div></div>`;
}

const DASHBOARD_LOADING_HTML = `<div class="kpis">${["Requests", "Success", "Tokens", "Cached input", "Avg latency"].map((label) => `<div class="kpi"><div class="kpi-label">${label}</div><div class="val"><span class="bone"></span></div><div class="sub">&nbsp;</div></div>`).join("")}</div><div class="chart"><div class="sh"><h2>Requests</h2></div><div class="plot"><span class="bone chart-bone"></span></div></div><div class="tables">${["By provider", "Top keys"].map((label) => `<div><div class="sh"><h2>${label}</h2></div><div class="list dashboard-table">${SKELETON_HTML}</div></div>`).join("")}</div>`;

function usageSlotHtml(kind, id) {
  const windowMs =
    kind === "account" ? state.accountUsageWindowMs : state.keyUsageWindowMs;
  const entry = state.usageDetails.get(`${kind}:${id}:${windowMs}`);
  const data = entry?.data || state.visibleUsageDetails.get(`${kind}:${id}`);
  if (entry?.data) state.visibleUsageDetails.set(`${kind}:${id}`, entry.data);
  const loading = !data && entry?.status !== "error";
  const message = entry?.status === "error" ? entry.error : "";
  return [
    kind === "account"
      ? keyListHtml(data?.apiKeys, data?.totals, message, loading)
      : accountListHtml(data?.accounts, data?.totals, message, loading),
    modelListHtml(data?.models, message, loading),
  ]
    .filter(Boolean)
    .join("");
}

function renderUsageSlot(kind, id) {
  const slot = document.querySelector(`[data-usage-for="${kind}:${id}"]`);
  if (!slot) return;
  const list = slot.closest?.("#accounts-list, #keys-list");
  const update = () => {
    slot.innerHTML = usageSlotHtml(kind, id);
  };
  if (list) renderWithMotion(list, update);
  else update();
}

function modelListHtml(rows, message, loading) {
  const body = [...(rows || [])]
    .sort((a, b) => (b.requestCount ?? 0) - (a.requestCount ?? 0))
    .map((row) => {
      const usage = normalizeUsage(row);
      const cached = cacheReadRate(
        usage.inputTotalTokens,
        usage.cacheReadTokens
      );
      return `<div class="row t-model"><span class="name"><span class="mono ellipsis">${escapeHtml(row.model?.trim() || "(unknown)")}</span><span class="tag d">${escapeHtml(`${providerName(row.provider)} \u00b7 ${row.endpoint}`)}</span></span><span class="num">${requestsCellHtml(row)}</span><span class="num muted">${formatCompact(usage.totalTokens)}</span><span class="num muted d">${cached === null ? "\u2014" : `${cached}%`}</span><span class="num muted d">${formatCount(usage.avgLatencyMs)} ms</span></div>`;
    })
    .join("");
  return usagePanelHtml(
    {
      title: "Model",
      head: '<span class="num">Requests</span><span class="num">Tokens</span><span class="num d">Cached</span><span class="num d">Latency</span>',
      body,
    },
    "t-model",
    message,
    loading
  );
}

function keyListHtml(rows, totals, message, loading) {
  const total = normalizeUsage(totals).requestCount;
  const body = [...(rows || [])]
    .sort((a, b) => (b.requestCount ?? 0) - (a.requestCount ?? 0))
    .map((row) => {
      const usage = normalizeUsage(row);
      const share = total
        ? `${((usage.requestCount / total) * 100).toFixed(1)}%`
        : "\u2014";
      const link = keyById(row.apiKeyId)
        ? ` data-key-id="${escapeHtml(row.apiKeyId)}" tabindex="0" role="button"`
        : "";
      return `<div class="row t-bykey"${link}><span class="ellipsis">${apiKeyDisplayHtml(row.apiKeyId)}</span><span class="num">${requestsCellHtml(row)}</span><span class="num muted">${share}</span><span class="num muted d">${formatCompact(usage.totalTokens)}</span><span class="num muted d">${formatCount(usage.avgLatencyMs)} ms</span></div>`;
    })
    .join("");
  return usagePanelHtml(
    {
      title: "Key",
      head: '<span class="num">Requests</span><span class="num">Share</span><span class="num d">Tokens</span><span class="num d">Latency</span>',
      body,
    },
    "t-bykey",
    message,
    loading
  );
}

// Requests refused before an account was chosen are stored under this id.
const NOT_ROUTED_ACCOUNT_ID = "__missing__";

function accountListHtml(rows, totals, message, loading) {
  const total = normalizeUsage(totals).requestCount;
  const body = (rows || [])
    .filter((row) => {
      const account = accountById(row.providerAccountId);
      return (
        !account ||
        isAccountVisible(account, {
          showFreeTier: state.showFreeTier,
          usage: row,
        })
      );
    })
    .map((row) => {
      const usage = normalizeUsage(row);
      const share = total
        ? `${((usage.requestCount / total) * 100).toFixed(1)}%`
        : "\u2014";
      const account = accountById(row.providerAccountId);
      let name = `<span class="mono muted" title="${escapeHtml(row.providerAccountId)}">Removed account</span>`;
      if (row.providerAccountId === NOT_ROUTED_ACCOUNT_ID) {
        name =
          '<span class="muted" title="Refused before an account was chosen">Not routed</span>';
      } else if (account) {
        name = escapeHtml(accountName(account));
      }
      const link = account
        ? ` data-account-id="${account.id}" tabindex="0" role="button"`
        : "";
      return `<div class="row t-bykey"${link}><span class="name"><span class="ellipsis">${name}</span><span class="tag d">${escapeHtml(providerName(row.provider))}</span></span><span class="num">${requestsCellHtml(row)}</span><span class="num muted">${share}</span><span class="num muted d">${formatCompact(usage.totalTokens)}</span><span class="num muted d">${formatCount(usage.avgLatencyMs)} ms</span></div>`;
    })
    .join("");
  return usagePanelHtml(
    {
      title: "Account",
      head: '<span class="num">Requests</span><span class="num">Share</span><span class="num d">Tokens</span><span class="num d">Latency</span>',
      body,
    },
    "t-bykey",
    message,
    loading
  );
}

function apiKeyDisplayHtml(apiKeyId) {
  const key = keyById(apiKeyId);
  if (key) return escapeHtml(keyName(key));
  return `<span class="mono muted">${escapeHtml(apiKeyId.slice(0, 8))}\u2026</span>`;
}

/* Overview */

function renderAttention() {
  const el = $("#attention");
  if (!el || !state.overviewReady) return;
  const statuses = providerStatusMap();
  const items = [];
  for (const account of state.accounts) {
    if (
      !isAccountVisible(account, {
        showFreeTier: state.showFreeTier,
        usage: accountUsageForId(account.id),
      })
    )
      continue;
    if (!isAccountServing(account, statuses)) continue;
    const issues = accountIssues(account);
    if (!issues.length) continue;
    items.push({
      severity: issues[0].severity,
      name: accountName(account),
      text: `${providerName(account.provider)} \u00b7 ${issues.map((issue) => issue.text).join(", ")}`,
      when: issues.find((issue) => issue.when)?.when || "",
      accountId: account.id,
    });
  }

  const totals = state.dashboardData?.totals;
  if (totals) {
    const metrics = normalizeUsage(totals);
    const failed =
      metrics.upstreamErrorCount + metrics.unclassifiedFailureCount;
    const errorRate = metrics.requestCount
      ? (failed + metrics.proxyErrorCount + metrics.rateLimitCount) /
        metrics.requestCount
      : 0;
    if (metrics.proxyErrorCount > 0 || errorRate >= 0.01) {
      items.push({
        severity: "warn",
        name: "Request errors",
        text: `${formatCount(failed)} upstream fails \u00b7 ${formatCount(metrics.rateLimitCount)} rate-limited (429) \u00b7 ${formatCount(metrics.proxyErrorCount)} proxy fails`,
        when: `last ${usageWindowLabel(state.dashboardWindowMs)}`,
        accountId: null,
      });
    }
  }

  items.sort(
    (a, b) => Number(b.severity === "err") - Number(a.severity === "err")
  );
  el.innerHTML = items.length
    ? `<div class="sh"><h2>Needs attention</h2><span class="muted">${items.length}</span></div><div class="list">${items
        .map(
          (item) =>
            `<div class="row attn${item.accountId ? "" : " static"}"${item.accountId ? ` data-account-id="${item.accountId}" tabindex="0" role="button"` : ""}><span class="dot ${item.severity}"></span><span class="ellipsis">${escapeHtml(item.name)}</span><span class="muted ellipsis d">${escapeHtml(item.text)}</span><span class="num muted small">${escapeHtml(item.when)}</span>${item.accountId ? icon("chev") : "<span></span>"}<span class="l2">${escapeHtml(item.text)}</span></div>`
        )
        .join("")}</div>`
    : "";
}

function deltaText(current, previous) {
  if (!previous) return "";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "0%";
  return `${pct > 0 ? "+" : "\u2212"}${Math.abs(pct)}%`;
}

function kpisHtml(metrics, previous, windowLabel) {
  const cached = cacheReadRate(
    metrics.inputTotalTokens,
    metrics.cacheReadTokens
  );
  const errors = Math.max(0, metrics.requestCount - metrics.successCount);
  const requestsDelta = deltaText(metrics.requestCount, previous.requestCount);
  const kpis = [
    [
      "Requests",
      formatCompact(metrics.requestCount),
      requestsDelta ? `${requestsDelta} vs previous ${windowLabel}` : "",
    ],
    [
      "Success",
      successRateText(metrics),
      errors ? `${formatCount(errors)} errors` : "No errors",
    ],
    [
      "Tokens",
      formatCompact(metrics.totalTokens),
      deltaText(metrics.totalTokens, previous.totalTokens),
    ],
    [
      "Cached input",
      cached === null ? "\u2014" : `${cached}%`,
      cached === null ? "" : "of input tokens",
    ],
    [
      "Avg latency",
      `${formatCount(metrics.avgLatencyMs)}<span class="unit">ms</span>`,
      deltaText(metrics.avgLatencyMs, previous.avgLatencyMs),
    ],
  ];
  return `<div class="kpis">${kpis
    .map(
      ([label, value, sub]) =>
        `<div class="kpi"><div class="kpi-label">${label}</div><div class="val">${value}</div><div class="sub">${sub}</div></div>`
    )
    .join("")}</div>`;
}

function providerTableHtml(data, metrics) {
  const providers = data.byProvider || [];
  const models = new Map();
  for (const row of data.byModel || []) {
    const name = row.model?.trim() || "(unknown)";
    const group = models.get(row.provider) ?? new Map();
    const entry = group.get(name) ?? {
      requestCount: 0,
      totalTokens: 0,
      inputTotalTokens: 0,
      cacheReadTokens: 0,
    };
    const usage = normalizeUsage(row);
    entry.requestCount += usage.requestCount;
    entry.totalTokens += usage.totalTokens;
    entry.inputTotalTokens += usage.inputTotalTokens;
    entry.cacheReadTokens += usage.cacheReadTokens;
    group.set(name, entry);
    models.set(row.provider, group);
  }
  const cachedText = (usage) => {
    const rate = cacheReadRate(usage.inputTotalTokens, usage.cacheReadTokens);
    return rate === null ? "\u2014" : `${rate}%`;
  };

  const rows = providers
    .map((row) => {
      const usage = normalizeUsage(row);
      const share = metrics.requestCount
        ? Math.round((usage.requestCount / metrics.requestCount) * 100)
        : 0;
      const modelRows = Array.from(models.get(row.provider) ?? [])
        .sort((a, b) => b[1].requestCount - a[1].requestCount)
        .map(
          ([name, entry]) =>
            `<div class="row t-prov"><span class="model ellipsis">${escapeHtml(name)}</span><span class="num muted">${formatCount(entry.requestCount)}</span><span></span><span class="num muted d">${formatCompact(entry.totalTokens)}</span><span class="num muted d">${cachedText(entry)}</span></div>`
        )
        .join("");
      return `<div class="row t-prov"><span>${escapeHtml(providerName(row.provider))}</span><span class="num">${formatCount(usage.requestCount)}</span><span class="num muted">${share}%</span><span class="num d">${formatCompact(usage.totalTokens)}</span><span class="num muted d">${cachedText(usage)}</span></div>${modelRows}`;
    })
    .join("");

  return `<div><div class="sh"><h2>By provider</h2></div><div class="list dashboard-table" tabindex="0" aria-label="Usage by provider"><div class="row thead t-prov"><span>Provider</span><span class="num">Requests</span><span class="num">Share</span><span class="num d">Tokens</span><span class="num d">Cached</span></div>${rows || '<p class="list-note muted">No usage in this window.</p>'}</div></div>`;
}

function topKeysHtml(data, metrics) {
  const rows = (data.byKey || []).slice(0, 5);
  const body = rows
    .map((row) => {
      const share = metrics.requestCount
        ? ((row.requestCount / metrics.requestCount) * 100).toFixed(1)
        : "0.0";
      return `<div class="row t-keys" data-key-id="${escapeHtml(row.apiKeyId)}" tabindex="0" role="button"><span class="ellipsis">${apiKeyDisplayHtml(row.apiKeyId)}</span><span class="num">${formatCount(row.requestCount)}</span><span class="num muted">${share}%</span></div>`;
    })
    .join("");
  return `<div><div class="sh"><h2>Top keys</h2><div class="right"><button class="link small" type="button" data-action="go-keys">View all keys</button></div></div><div class="list dashboard-table" tabindex="0" aria-label="Top keys"><div class="row thead t-keys"><span>Key</span><span class="num">Requests</span><span class="num">Share</span></div>${body || '<p class="list-note muted">No usage in this window.</p>'}</div></div>`;
}

function renderDashboard(rawData) {
  if (!state.accountsLoaded) return;
  state.overviewReady = true;
  $("#overview-loading").hidden = true;
  $("#attention").hidden = false;
  $("#dash-content").hidden = false;
  renderAttention();
  const el = $("#dash-content");
  const data = rawData || {};
  const metrics = normalizeUsage(data?.totals);

  const width = el.clientWidth || 1200;
  const windowLabel = usageWindowLabel(
    data.windowMs ?? state.dashboardWindowMs
  );
  el.innerHTML = [
    kpisHtml(metrics, normalizeUsage(data.previousTotals), windowLabel),
    requestChartHtml(data, width),
    `<div class="tables">${providerTableHtml(data, metrics)}${topKeysHtml(data, metrics)}</div>`,
  ].join("");

  const plot = el.querySelector(".plot");
  if (plot?.querySelector(".plot-svg")) {
    let frame = 0;
    let pointerX = 0;
    plot.addEventListener("pointermove", (event) => {
      pointerX = event.clientX;
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        showChartHover(plot, pointerX);
      });
    });
    plot.addEventListener("pointerleave", () => {
      cancelAnimationFrame(frame);
      frame = 0;
      hideChartHover(plot);
    });
  }
}

const TICK_STEPS_MS = [
  5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440, 2880, 7200, 10_080,
].map((minutes) => minutes * 60_000);

function chartTicks(start, end, plotWidth) {
  const maxTicks = Math.max(2, Math.min(8, Math.floor(plotWidth / 80)));
  const step =
    TICK_STEPS_MS.find((ms) => (end - start) / ms <= maxTicks) ??
    TICK_STEPS_MS.at(-1);
  const ticks = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  if (step >= DAY_MS) {
    if (cursor.getTime() < start) cursor.setDate(cursor.getDate() + 1);
    while (cursor.getTime() <= end) {
      ticks.push({ at: cursor.getTime(), date: true });
      cursor.setDate(cursor.getDate() + step / DAY_MS);
    }
    return ticks;
  }
  for (let at = cursor.getTime(); at <= end; at += step) {
    if (at < start) continue;
    const date = new Date(at);
    ticks.push({
      at,
      date: date.getHours() === 0 && date.getMinutes() === 0,
    });
  }
  return ticks;
}

function bucketLabel(bucketSizeMs) {
  const minutes = Math.round(bucketSizeMs / 60_000);
  if (minutes === 1) return "minute";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? "hour" : `${hours} hours`;
}

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});

const dayFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
});

const timeLabel = (timestamp) => timeFormat.format(timestamp);

const chart = {
  slots: [],
  current: [],
  previous: null,
  width: 0,
  plotWidth: 0,
  x: () => 0,
  y: () => 0,
};

function niceCeil(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (factor * magnitude >= value) return factor * magnitude;
  }
  return 10 * magnitude;
}

function requestChartHtml(data, width) {
  const size = data.bucketSizeMs;
  const buckets = data.buckets || [];
  if (!size || !buckets.length) return emptyChartHtml();
  const windowMs = data.windowMs ?? state.dashboardWindowMs;
  const end =
    typeof data.now === "number" ? data.now : buckets.at(-1).bucketStart + size;
  const since = typeof data.since === "number" ? data.since : end - windowMs;
  const first = Math.floor(since / size) * size;
  const last = Math.floor((end - 1) / size) * size;
  const slots = [];
  for (let at = first; at <= last; at += size) slots.push(at);
  if (slots.length < 2) return emptyChartHtml();

  const counts = new Map(
    buckets.map((bucket) => [bucket.bucketStart, bucket.requestCount])
  );
  const previousCounts = new Map(
    (data.previousBuckets || []).map((bucket) => [
      bucket.bucketStart + windowMs,
      bucket.requestCount,
    ])
  );
  const current = slots.map((at) => counts.get(at) ?? 0);
  const previous = data.previousBuckets?.length
    ? slots.map((at) => previousCounts.get(at) ?? 0)
    : null;

  const height = width < 640 ? 128 : 160;
  const top = 8;
  const plotWidth = width - 48;
  const plotHeight = height - top - 24;
  const step = niceCeil(Math.max(3, ...current, ...(previous || [])) / 3);
  const yMax = step * 3;
  const x = (index) => (index / (slots.length - 1)) * plotWidth;
  const y = (value) => top + (1 - value / yMax) * plotHeight;
  const points = (series) =>
    series
      .map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
      .join(" ");
  Object.assign(chart, { slots, current, previous, width, plotWidth, x, y });

  let svg = `<svg class="plot-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Requests per ${bucketLabel(size)}"><g class="grid">`;
  for (let k = 0; k <= 3; k++) {
    const gy = Math.round(y(step * k)) + 0.5;
    const label = formatCompact(step * k).replace(/\.0(?=[KMBT])/, "");
    svg += `<line x1="0" x2="${plotWidth}" y1="${gy}" y2="${gy}"/><text x="${width}" y="${gy + 4}" text-anchor="end">${label}</text>`;
  }
  svg += "</g><g>";
  for (const tick of chartTicks(first, last, plotWidth)) {
    const tx = ((tick.at - first) / (last - first)) * plotWidth;
    if (tx > plotWidth - 40) continue;
    svg += `<text x="${tx.toFixed(1)}" y="${height - 4}">${escapeHtml(tick.date ? shortDate(tick.at) : timeLabel(tick.at))}</text>`;
  }
  svg += "</g>";
  if (previous)
    svg += `<polyline class="line-prev" points="${points(previous)}"/>`;
  svg += `<polyline class="line" points="${points(current)}"/><g class="hover" visibility="hidden"><line class="hover-line" y1="${top}" y2="${top + plotHeight}"/><circle class="hover-dot" r="3"/></g></svg>`;

  const windowLabel = usageWindowLabel(windowMs);
  const range =
    windowMs >= 2 * DAY_MS
      ? `${shortDate(first)} \u2013 ${shortDate(end)}`
      : `Last ${windowLabel}`;
  return `<div class="chart">
    <div class="sh"><h2>Requests</h2><span class="muted small">per ${bucketLabel(size)}</span>
      <div class="right legend"><span><i class="sw"></i>${escapeHtml(range)}</span>${previous ? `<span><i class="sw prev"></i>Previous ${escapeHtml(windowLabel)}</span>` : ""}</div>
    </div>
    <div class="plot">${svg}<div class="tip" hidden></div></div>
  </div>`;
}

function emptyChartHtml() {
  return '<div class="chart"><div class="sh"><h2>Requests</h2></div><div class="plot"><p class="usage-note muted">No usage in this window.</p></div></div>';
}

function showChartHover(plot, clientX) {
  if (chart.slots.length < 2) return;
  const offset = clientX - plot.getBoundingClientRect().left;
  const index = Math.max(
    0,
    Math.min(
      chart.slots.length - 1,
      Math.round((offset / chart.plotWidth) * (chart.slots.length - 1))
    )
  );
  const hx = chart.x(index);
  const hover = plot.querySelector(".hover");
  hover.setAttribute("visibility", "visible");
  const line = hover.querySelector(".hover-line");
  line.setAttribute("x1", String(Math.round(hx) + 0.5));
  line.setAttribute("x2", String(Math.round(hx) + 0.5));
  const dot = hover.querySelector(".hover-dot");
  dot.setAttribute("cx", hx.toFixed(1));
  dot.setAttribute("cy", chart.y(chart.current[index]).toFixed(1));

  const at = new Date(chart.slots[index]);
  const day = dayFormat.format(at);
  const tip = plot.querySelector(".tip");
  tip.innerHTML = `<span class="muted">${escapeHtml(`${day} \u00b7 ${timeLabel(at)}`)}</span><span>${formatCount(chart.current[index])} requests</span>${chart.previous ? `<span class="muted">prev ${formatCount(chart.previous[index])}</span>` : ""}`;
  tip.hidden = false;
  const tipWidth = tip.offsetWidth;
  const left =
    hx + 12 + tipWidth > chart.plotWidth ? hx - 12 - tipWidth : hx + 12;
  tip.style.left = `${Math.max(0, left)}px`;
}

function hideChartHover(plot) {
  plot.querySelector(".hover")?.setAttribute("visibility", "hidden");
  const tip = plot.querySelector(".tip");
  if (tip) tip.hidden = true;
}

export {
  DASHBOARD_LOADING_HTML,
  usageSlotHtml,
  renderUsageSlot,
  renderAttention,
  renderDashboard,
  requestChartHtml,
  showChartHover,
  hideChartHover,
};
