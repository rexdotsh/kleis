import type { Context } from "hono";

type AuthFailureRecord = {
  windowStartedAt: number;
  failureCount: number;
  blockedUntil: number;
  lastSeenAt: number;
};

type RegisterAuthFailureInput = {
  key: string;
  maxFailures: number;
  windowMs: number;
  blockMs: number;
  now?: number;
};

export type AuthRateLimitPolicy = {
  scope: string;
  maxFailures: number;
  windowMs: number;
  blockMs: number;
  message: string;
};

const records = new Map<string, AuthFailureRecord>();

const STALE_RECORD_TTL_MS = 60 * 60 * 1000;
const PRUNE_TRIGGER_SIZE = 5000;

const retryAfterSeconds = (blockedUntil: number, now: number): number =>
  Math.max(1, Math.ceil((blockedUntil - now) / 1000));

const pruneStaleRecords = (now: number): void => {
  if (records.size < PRUNE_TRIGGER_SIZE) {
    return;
  }

  for (const [key, record] of records) {
    if (
      record.blockedUntil <= now &&
      now - record.lastSeenAt > STALE_RECORD_TTL_MS
    ) {
      records.delete(key);
    }
  }
};

const currentRecord = (
  key: string,
  now: number,
  windowMs: number
): AuthFailureRecord => {
  const record = records.get(key);
  if (!record) {
    return {
      windowStartedAt: now,
      failureCount: 0,
      blockedUntil: 0,
      lastSeenAt: now,
    };
  }

  if (now - record.windowStartedAt >= windowMs) {
    return {
      windowStartedAt: now,
      failureCount: 0,
      blockedUntil: record.blockedUntil,
      lastSeenAt: now,
    };
  }

  return {
    ...record,
    lastSeenAt: now,
  };
};

const registerAuthFailure = (
  input: RegisterAuthFailureInput
): number | null => {
  const now = input.now ?? Date.now();
  pruneStaleRecords(now);

  const record = currentRecord(input.key, now, input.windowMs);
  if (record.blockedUntil > now) {
    records.set(input.key, record);
    return retryAfterSeconds(record.blockedUntil, now);
  }

  record.failureCount += 1;
  if (record.failureCount < input.maxFailures) {
    records.set(input.key, record);
    return null;
  }

  record.failureCount = 0;
  record.windowStartedAt = now;
  record.blockedUntil = now + input.blockMs;
  records.set(input.key, record);
  return retryAfterSeconds(record.blockedUntil, now);
};

const authRetryAfterSeconds = (
  key: string,
  now = Date.now()
): number | null => {
  const record = records.get(key);
  if (!record) {
    return null;
  }

  if (record.blockedUntil <= now) {
    if (now - record.lastSeenAt > STALE_RECORD_TTL_MS) {
      records.delete(key);
    }
    return null;
  }

  record.lastSeenAt = now;
  records.set(key, record);
  return retryAfterSeconds(record.blockedUntil, now);
};

const clearAuthFailures = (key: string): void => {
  records.delete(key);
};

const readClientAddress = (headers: Headers): string => {
  const cloudflareIp = headers.get("cf-connecting-ip")?.trim();
  if (cloudflareIp) {
    return cloudflareIp;
  }

  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) {
    return forwarded;
  }

  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }

  return "unknown";
};

const policyKey = (policy: AuthRateLimitPolicy, headers: Headers): string =>
  `${policy.scope}:${readClientAddress(headers)}`;

export const authRateLimitRetryAfter = (
  policy: AuthRateLimitPolicy,
  headers: Headers,
  now = Date.now()
): number | null => authRetryAfterSeconds(policyKey(policy, headers), now);

export const registerAuthRateLimitFailure = (
  policy: AuthRateLimitPolicy,
  headers: Headers,
  now = Date.now()
): number | null =>
  registerAuthFailure({
    key: policyKey(policy, headers),
    maxFailures: policy.maxFailures,
    windowMs: policy.windowMs,
    blockMs: policy.blockMs,
    now,
  });

export const clearAuthRateLimit = (
  policy: AuthRateLimitPolicy,
  headers: Headers
): void => {
  clearAuthFailures(policyKey(policy, headers));
};

export const authRateLimitedResponse = (
  context: Context,
  retryAfterSecondsValue: number,
  message: string
): Response => {
  context.header("Retry-After", String(retryAfterSecondsValue));
  context.header("Cache-Control", "no-store");
  return context.json(
    {
      error: "too_many_requests",
      message,
    },
    429
  );
};
