import type { Provider } from "../../db/schema";
import { isObjectRecord } from "../../utils/object";
import type { LiveLimits } from "../account-tracking/live-limits";
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

const limitResets = (
  limits: LiveLimits | null,
  headers: Headers,
  provider: Provider,
  now: number
): (number | null)[] => {
  if (provider === "claude") {
    const reset = nonnegativeNumber(
      headers.get("anthropic-ratelimit-unified-reset")
    );
    if (reset !== null) return [timestamp(reset * 1000)];
    if (limits?.provider !== "claude") return [];
    // Unexhausted windows can reset days after the window blocking this request.
    return Object.values(limits.windows)
      .filter((window) => (window.utilization ?? 100) >= 100)
      .map((window) => timestamp(Date.parse(window.resetsAt ?? "")));
  }
  if (provider !== "codex") return [];
  return ["primary", "secondary"].flatMap((name) => {
    const prefix = `x-codex-${name}`;
    const used = nonnegativeNumber(headers.get(`${prefix}-used-percent`));
    if (used !== null && used < 100) return [];
    const absolute = nonnegativeNumber(headers.get(`${prefix}-reset-at`));
    const relative = nonnegativeNumber(
      headers.get(`${prefix}-reset-after-seconds`)
    );
    if (used === null && absolute === null && relative === null) return [];
    return [
      timestamp(absolute === null ? null : absolute * 1000) ??
        timestamp(relative === null ? null : now + relative * 1000),
    ];
  });
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
  const resetsAt =
    input.resetsAt === null ? null : new Date(input.resetsAt).toISOString();
  const minutes = Math.max(
    1,
    Math.ceil(((input.resetsAt ?? input.now) - input.now) / 60_000)
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
  const headers = createProxyResponseHeaders(input.headers ?? {});
  headers.delete("retry-after");
  headers.delete("retry-after-ms");
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
    timestamp(seconds === null ? null : input.now + seconds * 1000) ??
    timestamp(absolute === null ? null : absolute * 1000) ??
    timestamp(
      typeof error?.resets_at === "string" ? Date.parse(error.resets_at) : null
    );
  const resets = limitResets(
    input.liveLimits,
    input.response.headers,
    input.provider,
    input.now
  );
  const resetsAt =
    retryReset(input.response.headers, input.now) ??
    latestReset(resets) ??
    (input.provider === "codex" ? bodyReset : null);
  const usageLimited =
    [errorType, errorCode].some(
      (code) =>
        code === "usage_limit_reached" ||
        code === "insufficient_quota" ||
        code === "usage_not_included"
    ) ||
    resets.length > 0 ||
    (input.provider === "claude" &&
      input.response.headers.get("anthropic-ratelimit-unified-status") ===
        "rejected") ||
    (typeof error?.message === "string" &&
      /\b(?:usage|subscription) limit\b/i.test(error.message));
  if (resetsAt === null ? !usageLimited : resetsAt - input.now <= 60_000) {
    return null;
  }
  return createUsageLimitResponse({
    provider: input.provider,
    accountLabel: input.accountLabel,
    resetsAt,
    now: input.now,
    headers: input.response.headers,
    errorType,
    errorCode,
  });
};
