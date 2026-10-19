import type { Provider } from "../../db/schema";
import { isObjectRecord } from "../../utils/object";
import {
  CLAUDE_WINDOW_HEADERS,
  type LiveLimits,
} from "../account-tracking/live-limits";
import { createProxyResponseHeaders } from "./response";
import { readUpstreamErrorFields } from "./upstream-error";

const nonnegativeNumber = (value: unknown): number | null => {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const timestamp = (value: number | null): number | null =>
  value !== null && Number.isFinite(new Date(value).getTime()) ? value : null;

const futureTimestamp = (value: number | null, now: number): number | null => {
  const reset = timestamp(value);
  return reset !== null && reset > now ? reset : null;
};

const latestReset = (resets: (number | null)[]): number | null => {
  const valid = resets.filter((reset): reset is number => reset !== null);
  return valid.length ? Math.max(...valid) : null;
};

const retryReset = (headers: Headers, now: number): number | null => {
  const retryAfter = headers.get("retry-after");
  const seconds = nonnegativeNumber(retryAfter);
  const milliseconds = nonnegativeNumber(headers.get("retry-after-ms"));
  return latestReset([
    timestamp(
      seconds === null ? Date.parse(retryAfter ?? "") : now + seconds * 1000
    ),
    timestamp(milliseconds === null ? null : now + milliseconds),
  ]);
};

const exhaustedResets = (
  limits: LiveLimits | null,
  headers: Headers,
  provider: Provider,
  now: number
): number[] => {
  if (provider === "claude") {
    const header = (name: string) =>
      headers.get(`anthropic-ratelimit-unified-${name}`);
    const rejected = header("status") === "rejected";
    const claim = header("representative-claim")?.trim();
    const windowHeaders = Object.entries(CLAUDE_WINDOW_HEADERS);
    const claimedHeader = windowHeaders.find(([key]) => key === claim)?.[1];
    const utilization = claimedHeader
      ? nonnegativeNumber(header(`${claimedHeader}-utilization`))
      : null;
    if (!rejected && (utilization ?? 0) < 1) return [];
    const windows = limits?.provider === "claude" ? limits.windows : {};
    const reset = nonnegativeNumber(header("reset"));
    const unifiedReset = timestamp(reset === null ? null : reset * 1000);
    if (claim) {
      const claimedReset = futureTimestamp(
        timestamp(Date.parse(windows[claim]?.resetsAt ?? "")) ?? unifiedReset,
        now
      );
      return claimedReset === null ? [] : [claimedReset];
    }
    const resets = windowHeaders
      .filter(
        ([, name]) =>
          (nonnegativeNumber(header(`${name}-utilization`)) ?? 0) >= 1
      )
      .map(([key]) =>
        futureTimestamp(Date.parse(windows[key]?.resetsAt ?? ""), now)
      )
      .filter((value): value is number => value !== null);
    const unifiedFuture = futureTimestamp(unifiedReset, now);
    return resets.length || unifiedFuture === null ? resets : [unifiedFuture];
  }
  if (provider !== "codex") return [];
  const resets: number[] = [];
  for (const [name, value] of headers) {
    if (!/^x-codex-(?:.+-)?(?:primary|secondary)-used-percent$/.test(name))
      continue;
    const prefix = name.slice(0, -"-used-percent".length);
    const used = nonnegativeNumber(value);
    if (used === null || used < 100) continue;
    const absolute = nonnegativeNumber(headers.get(`${prefix}-reset-at`));
    const relative = nonnegativeNumber(
      headers.get(`${prefix}-reset-after-seconds`)
    );
    const reset = futureTimestamp(
      timestamp(absolute === null ? null : absolute * 1000) ??
        timestamp(relative === null ? null : now + relative * 1000),
      now
    );
    if (reset !== null) resets.push(reset);
  }
  return resets;
};

const withoutRetryHeaders = (source: HeadersInit): Headers => {
  const headers = createProxyResponseHeaders(source);
  headers.delete("retry-after");
  headers.delete("retry-after-ms");
  return headers;
};

export const createUsageLimitResponse = (input: {
  provider: Provider;
  accountLabel: string | null;
  resetsAt: number | null;
  now: number;
  headers?: HeadersInit;
  errorType?: string | null;
  errorCode?: string | null;
}): Response => {
  const provider = input.provider === "claude" ? "Claude" : "Codex";
  const account = input.accountLabel;
  const reset = futureTimestamp(input.resetsAt, input.now);
  const resetsAt = reset === null ? null : new Date(reset).toISOString();
  const minutes = Math.max(
    1,
    Math.ceil(((reset ?? input.now) - input.now) / 60_000)
  );
  const duration =
    minutes >= 60
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      : `${minutes}m`;
  const resetMessage = resetsAt
    ? `Resets at ${resetsAt} (in ${duration}).`
    : "Reset time unknown.";
  const message = `${provider} usage limit reached${account === null ? "" : ` for account ${JSON.stringify(account)}`}. ${resetMessage}`;
  const fields = { message, resets_at: resetsAt, account };
  const body =
    input.provider === "claude"
      ? { type: "error", error: { type: "rate_limit_error", ...fields } }
      : {
          error: {
            type: input.errorType ?? "usage_limit_reached",
            code: input.errorCode ?? "usage_limit_reached",
            ...fields,
          },
        };
  const headers = withoutRetryHeaders(input.headers ?? {});
  const retryHeaders = [...headers.keys()].filter((name) =>
    name.includes("retry")
  );
  for (const name of retryHeaders) headers.delete(name);
  headers.set("content-type", "application/json");
  return Response.json(body, { status: 429, headers });
};

export const rewriteUsageLimitResponse = (input: {
  response: Response;
  provider: Provider;
  accountLabel: string | null;
  liveLimits: LiveLimits | null;
  errorPayload: unknown;
  now: number;
}): Response | null => {
  if (input.response.status !== 429) return null;
  const payload = isObjectRecord(input.errorPayload)
    ? input.errorPayload
    : null;
  const error = isObjectRecord(payload?.error) ? payload.error : null;
  const { errorType, errorCode } = readUpstreamErrorFields(payload);
  const seconds = nonnegativeNumber(error?.resets_in_seconds);
  const absolute = nonnegativeNumber(error?.resets_at);
  const bodyReset =
    futureTimestamp(
      seconds === null ? null : input.now + seconds * 1000,
      input.now
    ) ??
    futureTimestamp(absolute === null ? null : absolute * 1000, input.now) ??
    futureTimestamp(
      typeof error?.resets_at === "string" ? Date.parse(error.resets_at) : null,
      input.now
    );
  const resets = exhaustedResets(
    input.liveLimits,
    input.response.headers,
    input.provider,
    input.now
  );
  const bodyLimited =
    input.provider === "codex" &&
    [errorType, errorCode].includes("usage_limit_reached");
  const rejected =
    input.provider === "claude" &&
    input.response.headers.get("anthropic-ratelimit-unified-status") ===
      "rejected";
  if (!resets.length && !bodyLimited && !rejected) {
    const retryAt = retryReset(input.response.headers, input.now);
    if (retryAt === null || retryAt - input.now <= 60_000) return null;
    return new Response(input.response.body, {
      status: input.response.status,
      statusText: input.response.statusText,
      headers: withoutRetryHeaders(input.response.headers),
    });
  }
  // Retry hints can describe throttling rather than the exhausted usage window.
  const resetsAt = latestReset(resets) ?? (bodyLimited ? bodyReset : null);
  const response = createUsageLimitResponse({
    provider: input.provider,
    accountLabel: input.accountLabel,
    resetsAt,
    now: input.now,
    headers: input.response.headers,
    errorType,
    errorCode,
  });
  input.response.body?.cancel().catch(() => undefined);
  return response;
};
