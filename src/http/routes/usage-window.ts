import { z } from "zod";

const USAGE_WINDOW_MIN_MS = 60_000;
const USAGE_WINDOW_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const usageWindowQuerySchema = z.strictObject({
  windowMs: z.coerce
    .number()
    .int()
    .min(USAGE_WINDOW_MIN_MS)
    .max(USAGE_WINDOW_MAX_MS)
    .optional(),
});

export const resolveUsageWindow = (windowMs: number | undefined) => {
  const resolvedWindowMs = windowMs ?? DEFAULT_USAGE_WINDOW_MS;
  const now = Date.now();
  return {
    windowMs: resolvedWindowMs,
    since: now - resolvedWindowMs,
    now,
  };
};
