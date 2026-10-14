import {
  escapeHtml,
  formatCompact,
  formatCount,
  usageWindowLabel,
} from "./app-format.js";
import { DAY_MS, shortDate } from "./app-render-shared.js";
import { DAILY_TOKEN_DAYS, state } from "./app-state.js";

/* Daily tokens chart inside expanded Claude accounts */

const utcDayFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const utcShortDateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function dailyTokensBodyHtml(id) {
  const entry = state.usageDetails.get(`daily:${id}`);
  const days = entry?.data?.daily || [];
  const peak = Math.max(0, ...days.map((day) => day.totalTokens || 0));
  const bars = days.length
    ? days.map(
        (day) =>
          `<span class="daily-bar${day.totalTokens ? "" : " zero"}" style="height:${peak ? ((day.totalTokens || 0) / peak) * 100 : 0}%"></span>`
      )
    : Array.from(
        { length: DAILY_TOKEN_DAYS },
        () => '<span class="daily-bar zero"></span>'
      );
  let summary = "&nbsp;";
  if (entry?.data) {
    const total = entry.data.totals?.totalTokens || 0;
    summary = `${escapeHtml(formatCompact(total))} tokens \u00b7 ${days.length} days`;
  } else if (entry?.status === "error") {
    summary = `<span class="err" title="${escapeHtml(entry.error)}">Unavailable</span>`;
  }
  const first = days[0]?.dayStart;
  const label = entry?.data
    ? `Tokens per UTC day through Kleis over the last ${days.length} days`
    : "Loading tokens per day through Kleis";
  return `<div class="daily-head"><span class="fact-label">Daily tokens via Kleis</span><span class="daily-total">${summary}</span></div>
    <div class="daily-plot" role="img" aria-label="${label}">${bars.join("")}<div class="tip" hidden></div></div>
    <div class="daily-axis"><span>${first === undefined ? "&nbsp;" : escapeHtml(utcShortDateFormat.format(first))}</span><span>Today (UTC)</span></div>`;
}

function renderDailyTokens(id) {
  const slot = document.querySelector(`[data-daily-for="${id}"]`);
  if (slot) slot.innerHTML = dailyTokensBodyHtml(id);
}

function showDailyTokensTip(plot, clientX) {
  const id = plot.closest("[data-daily-for]")?.dataset.dailyFor;
  const days = state.usageDetails.get(`daily:${id}`)?.data?.daily;
  if (!days?.length) return;
  const rect = plot.getBoundingClientRect();
  const index = Math.max(
    0,
    Math.min(
      days.length - 1,
      Math.floor(((clientX - rect.left) / rect.width) * days.length)
    )
  );
  const bars = plot.querySelectorAll(".daily-bar");
  for (const [barIndex, bar] of bars.entries())
    bar.classList.toggle("on", barIndex === index);
  const day = days[index];
  const tip = plot.querySelector(".tip");
  tip.innerHTML = `<span class="muted">${escapeHtml(utcDayFormat.format(day.dayStart))}</span><span>${escapeHtml(formatCount(day.totalTokens || 0))} tokens</span><span class="muted">${escapeHtml(formatCount(day.requestCount || 0))} req</span>`;
  tip.hidden = false;
  const center = ((index + 0.5) / days.length) * rect.width;
  const left = Math.min(
    Math.max(0, center - tip.offsetWidth / 2),
    rect.width - tip.offsetWidth
  );
  tip.style.left = `${Math.max(0, left)}px`;
}

function hideDailyTokensTip() {
  for (const tip of document.querySelectorAll(".daily-plot .tip:not([hidden])"))
    tip.hidden = true;
  for (const bar of document.querySelectorAll(".daily-bar.on"))
    bar.classList.remove("on");
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
  dailyTokensBodyHtml,
  renderDailyTokens,
  showDailyTokensTip,
  hideDailyTokensTip,
  requestChartHtml,
  showChartHover,
  hideChartHover,
};
