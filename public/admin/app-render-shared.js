import { mutationAttributes } from "./app-core.js";
import {
  escapeHtml,
  formatCount,
  formatShortDate,
  maskKey,
  normalizeUsage,
  relativeTime,
  usageWindowLabel,
} from "./app-format.js";
import { $ } from "./app-state.js";

const PROVIDERS = ["codex", "claude"];
const PROVIDER_NAMES = { codex: "Codex", claude: "Claude" };
const DAY_MS = 86_400_000;

const providerName = (provider) => PROVIDER_NAMES[provider] || provider;
const icon = (name) =>
  `<svg width="16" height="16" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const accountName = (account) =>
  account.label || account.accountId || maskKey(account.id);
const keyName = (key) => key.label || maskKey(key.key);
const shortDate = formatShortDate;
const hasTraffic = (usage) => normalizeUsage(usage).requestCount > 0;

const actionMutationAttributes = (action, target) =>
  mutationAttributes(
    action === "revoke-key" ? [action, "revoke-key-request"] : action,
    target
  );

function untilText(timestamp) {
  const diff = timestamp - Date.now();
  if (diff <= 0) return relativeTime(timestamp);
  if (diff < 60_000) return "in <1m";
  if (diff < 3_600_000) return `in ${Math.floor(diff / 60_000)}m`;
  if (diff < DAY_MS) return `in ${Math.floor(diff / 3_600_000)}h`;
  return `in ${Math.floor(diff / DAY_MS)}d`;
}

const SKELETON_HTML = Array.from(
  { length: 6 },
  (_, index) =>
    `<div class="row skeleton"><span class="bone" style="width:${[46, 38, 52, 34, 44, 40][index]}%"></span></div>`
).join("");

const listSkeletonRows = (columns) =>
  Array.from(
    { length: 3 },
    () =>
      `<div class="row skeleton ${columns}"><span class="bone"></span><span class="l2">&nbsp;</span></div>`
  ).join("");
const accountColumnsHtml = (requests = "Requests") =>
  `<span class="col d">Limits</span><span class="col num d">Token expires</span><span class="col num">${requests}</span><span></span>`;
const ACCOUNT_LOADING_HTML = PROVIDERS.map(
  (provider) =>
    `<div class="group t-acc"><span class="group-name"><span class="cap">${providerName(provider)}</span></span>${accountColumnsHtml()}</div><div class="group-rows">${listSkeletonRows("t-acc")}</div>`
).join("");
const KEY_LOADING_HTML = `<div class="row thead t-key"><span>Label</span><span class="d">Key</span><span class="d">Access</span><span class="num">Requests</span><span class="num d">Last used</span></div>${listSkeletonRows("t-key")}${listSkeletonRows("t-key")}`;

const kbd = (key) => `<span class="kbd" aria-hidden="true">${key}</span>`;

function requestsCellHtml(usage) {
  const metrics = normalizeUsage(usage);
  const failed = failedCount(metrics);
  const count = `<span${metrics.requestCount ? "" : ' class="muted"'}>${formatCount(metrics.requestCount)}</span>`;
  return failed
    ? `<span class="warn small">${formatCount(failed)} failed</span>&ensp;${count}`
    : count;
}

function fact(label, value, subs = [], extra = "") {
  const lines = subs
    .filter(Boolean)
    .map((sub) => `<div class="fact-sub">${sub}</div>`)
    .join("");
  return `<div class="fact"><div class="fact-label">${label}</div><div class="fact-value">${value}</div>${lines}${extra}</div>`;
}

function usageFact(rawUsage, windowMs) {
  const usage = normalizeUsage(rawUsage);
  const failed = failedCount(usage);
  const label = `Last ${escapeHtml(usageWindowLabel(windowMs))}`;
  if (!usage.requestCount) return fact(label, "0 requests", ["no traffic"]);
  const problems = [
    failed && `${formatCount(failed)} failed`,
    usage.rateLimitCount && `${formatCount(usage.rateLimitCount)} rate-limited`,
  ].filter(Boolean);
  return fact(
    label,
    `${formatCount(usage.requestCount)} request${usage.requestCount === 1 ? "" : "s"}`,
    [
      `${successRateText(usage)} success \u00b7 ${formatCount(usage.avgLatencyMs)} ms avg`,
      problems.length
        ? `<span class="warn">${problems.join(" \u00b7 ")}</span>`
        : usage.lastRequestAt &&
          `last request ${escapeHtml(relativeTime(usage.lastRequestAt))}`,
    ]
  );
}

function formRow(label, description, control, forId = "") {
  const title = forId
    ? `<label for="${forId}">${label}</label>`
    : `<span>${label}</span>`;
  return `<div class="form-row"><div class="form-row-label">${title}${description ? `<p>${description}</p>` : ""}</div><div class="form-row-control">${control}</div></div>`;
}

function formFoot(primaryButton, cancelAction) {
  return `<div class="form-foot"><div></div><div class="form-foot-buttons">${primaryButton}<button class="btn btn-ghost btn-sm" data-action="${cancelAction}" type="button">Cancel</button></div></div>`;
}

/* Inline forms survive list re-renders */

function fieldKey(input) {
  if (input.type === "checkbox" || input.type === "radio") {
    return `${input.name || input.className}:${input.value}`;
  }
  return input.id || `${input.className}:${input.dataset.provider ?? ""}`;
}

const isChoice = (input) => input.type === "checkbox" || input.type === "radio";

function renderPreservingForm(container, html) {
  const form = container.querySelector?.(".inline-form");
  const saved = form
    ? {
        id: form.dataset.form,
        focus: form.contains(document.activeElement)
          ? fieldKey(document.activeElement)
          : null,
        fields: new Map(
          Array.from(
            form.querySelectorAll("input, textarea, select"),
            (input) => [
              fieldKey(input),
              isChoice(input) ? input.checked : input.value,
            ]
          )
        ),
      }
    : null;
  container.innerHTML = html;
  const next = saved && container.querySelector(".inline-form");
  if (!next || next.dataset.form !== saved.id) return;
  for (const input of next.querySelectorAll("input, textarea, select")) {
    const key = fieldKey(input);
    if (saved.fields.has(key)) {
      if (isChoice(input)) input.checked = saved.fields.get(key);
      else input.value = saved.fields.get(key);
    }
    if (key === saved.focus) input.focus();
  }
}

function showLoading(containerId) {
  const el = $(`#${containerId}`);
  if (el && !el.querySelector(".skeleton")) {
    el.innerHTML =
      containerId === "accounts-list" ? ACCOUNT_LOADING_HTML : KEY_LOADING_HTML;
  }
}

function failedCount(metrics) {
  return (
    metrics.proxyErrorCount +
    metrics.upstreamErrorCount +
    metrics.unclassifiedFailureCount
  );
}

function successRateText(metrics) {
  if (!metrics.requestCount) return "\u2014";
  const rate = (metrics.successCount / metrics.requestCount) * 100;
  return rate >= 100 ? "100%" : `${(Math.floor(rate * 10) / 10).toFixed(1)}%`;
}

export {
  PROVIDERS,
  DAY_MS,
  providerName,
  icon,
  accountName,
  keyName,
  shortDate,
  hasTraffic,
  actionMutationAttributes,
  untilText,
  SKELETON_HTML,
  accountColumnsHtml,
  ACCOUNT_LOADING_HTML,
  KEY_LOADING_HTML,
  kbd,
  requestsCellHtml,
  fact,
  usageFact,
  formRow,
  formFoot,
  renderPreservingForm,
  showLoading,
  successRateText,
};
