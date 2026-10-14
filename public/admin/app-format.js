import { $$, APP_ORIGIN, state } from "./app-state.js";

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function relativeTime(ts) {
  if (!ts) return "never";
  const d = ts - Date.now();
  const abs = Math.abs(d);
  if (abs < 60_000) return d >= 0 ? "in <1m" : "just now";
  if (abs < 3_600_000) {
    const minutes = Math.floor(abs / 60_000);
    return d >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  }
  if (abs < 86_400_000) {
    const hours = Math.floor(abs / 3_600_000);
    return d >= 0 ? `in ${hours}h` : `${hours}h ago`;
  }
  return formatShortDate(ts);
}

function tokenStatus(expiresAt) {
  if (!expiresAt) return { label: "unknown", class: "unknown" };
  return expiresAt > Date.now()
    ? { label: "active", class: "active" }
    : { label: "expired", class: "expired" };
}

function maskKey(k) {
  return k.length <= 14 ? k : `${k.slice(0, 9)}\u2026${k.slice(-4)}`;
}

function keyById(keyId) {
  return state.keysById.get(keyId) || null;
}

function accountById(accountId) {
  return state.accountsById.get(accountId) || null;
}

function isKeyActive(key) {
  if (key.revokedAt) return false;
  if (key.expiresAt && key.expiresAt < Date.now()) return false;
  return true;
}

function modelsUrlForKey(key) {
  if (!key) return null;
  if (typeof key.scopedModelsUrl === "string" && key.scopedModelsUrl.trim()) {
    return key.scopedModelsUrl;
  }
  if (
    typeof key.modelsDiscoveryToken === "string" &&
    key.modelsDiscoveryToken.trim()
  ) {
    return `${APP_ORIGIN}/api/${key.modelsDiscoveryToken}`;
  }
  return null;
}

function accountUsageForId(accountId) {
  return state.accountUsageById.get(accountId) || null;
}

function usageForKey(keyId) {
  return state.keyUsageById.get(keyId) || null;
}

function usageWindowLabel(windowMs) {
  if (windowMs % 86_400_000 === 0 && windowMs > 86_400_000) {
    return `${windowMs / 86_400_000}d`;
  }
  if (windowMs % 3_600_000 === 0) return `${windowMs / 3_600_000}h`;
  if (windowMs % 60_000 === 0) return `${windowMs / 60_000}m`;
  return `${Math.floor(windowMs / 1000)}s`;
}

function usageNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const countFormat = new Intl.NumberFormat("en-US");
const shortDateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

function formatCount(value) {
  return countFormat.format(usageNumber(value));
}

function formatShortDate(timestamp) {
  return shortDateFormat.format(timestamp);
}

function formatCompact(n) {
  const v = usageNumber(n);
  if (v >= 1_000_000_000_000) return `${(v / 1_000_000_000_000).toFixed(2)}T`;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(v);
}

function cacheReadRate(inputTotalTokens, cacheReadTokens) {
  return inputTotalTokens > 0
    ? Math.round((cacheReadTokens / inputTotalTokens) * 100)
    : null;
}

function normalizeUsage(rawUsage) {
  const usage = rawUsage || {};
  const requestCount = usageNumber(usage.requestCount);
  const successCount = usageNumber(usage.successCount);
  const clientErrorCount = usageNumber(usage.clientErrorCount);
  const serverErrorCount = usageNumber(usage.serverErrorCount);
  const authErrorCount = usageNumber(usage.authErrorCount);
  const rateLimitCount = usageNumber(usage.rateLimitCount);
  const proxyErrorCount = usageNumber(usage.proxyErrorCount);
  const upstreamErrorCount = usageNumber(usage.upstreamErrorCount);
  const avgLatencyMs = usageNumber(usage.avgLatencyMs);
  const maxLatencyMs = usageNumber(usage.maxLatencyMs);
  const inputTokens = usageNumber(usage.inputTokens);
  const inputTotalTokens = usageNumber(
    usage.inputTotalTokens ??
      inputTokens +
        usageNumber(usage.cacheReadTokens) +
        usageNumber(usage.cacheWriteTokens)
  );
  const outputTokens = usageNumber(usage.outputTokens);
  const reasoningTokens = usageNumber(usage.reasoningTokens);
  const cacheReadTokens = usageNumber(usage.cacheReadTokens);
  const cacheWriteTokens = usageNumber(usage.cacheWriteTokens);
  const successRate =
    typeof usage.successRate === "number" && Number.isFinite(usage.successRate)
      ? Math.max(0, Math.min(100, Math.trunc(usage.successRate)))
      : null;
  const unclassifiedFailureCount = Math.max(
    0,
    clientErrorCount +
      serverErrorCount +
      authErrorCount -
      proxyErrorCount -
      upstreamErrorCount
  );

  return {
    requestCount,
    successCount,
    clientErrorCount,
    serverErrorCount,
    authErrorCount,
    rateLimitCount,
    proxyErrorCount,
    upstreamErrorCount,
    successRate,
    unclassifiedFailureCount,
    avgLatencyMs,
    maxLatencyMs,
    inputTokens,
    inputTotalTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: usageNumber(
      usage.totalTokens ?? inputTotalTokens + outputTokens
    ),
    lastRequestAt:
      typeof usage.lastRequestAt === "number" &&
      Number.isFinite(usage.lastRequestAt)
        ? usage.lastRequestAt
        : null,
  };
}

function hasUsageMetrics(metrics) {
  if (!metrics) return false;
  return (
    metrics.requestCount > 0 ||
    metrics.totalTokens > 0 ||
    metrics.cacheReadTokens > 0 ||
    metrics.cacheWriteTokens > 0 ||
    metrics.lastRequestAt !== null
  );
}

function usageMapFromList(items, idField) {
  const map = new Map();
  if (!Array.isArray(items)) return map;
  for (const u of items) {
    if (u?.[idField]) map.set(u[idField], u);
  }
  return map;
}

function formatMetadataForInput(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "";
  }

  return JSON.stringify(metadata, null, 2);
}

const trimmedOrNull = (value) => value.trim() || null;

const parseCommaSeparatedList = (value) =>
  value
    ? Array.from(
        new Set(
          value
            .split(/[\n,]/)
            .map((item) => item.trim())
            .filter(Boolean)
        )
      )
    : [];

const checkedValues = (selector) =>
  Array.from($$(selector))
    .filter((input) => input.checked)
    .map((input) => input.value);

const shortId = (value) =>
  value && value.length > 14
    ? `${value.slice(0, 8)}\u2026${value.slice(-4)}`
    : value || "";

const accountLabel = (account) =>
  account.label || account.accountId || shortId(account.id);

function dateInputValue(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseOptionalJsonObject(raw, fieldLabel) {
  if (!raw) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${fieldLabel} must be valid JSON`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${fieldLabel} must be a JSON object`);
  }

  return parsed;
}

function providerLabel(provider) {
  return { codex: "Codex", claude: "Claude" }[provider] || provider || "";
}

export {
  escapeHtml,
  relativeTime,
  tokenStatus,
  maskKey,
  keyById,
  accountById,
  isKeyActive,
  modelsUrlForKey,
  accountUsageForId,
  usageForKey,
  usageWindowLabel,
  formatCount,
  formatShortDate,
  formatCompact,
  cacheReadRate,
  normalizeUsage,
  hasUsageMetrics,
  usageMapFromList,
  formatMetadataForInput,
  trimmedOrNull,
  parseCommaSeparatedList,
  checkedValues,
  shortId,
  accountLabel,
  dateInputValue,
  parseOptionalJsonObject,
  providerLabel,
};
