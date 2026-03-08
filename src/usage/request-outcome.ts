export const usageRequestSources = ["proxy", "upstream"] as const;

export type UsageRequestSource = (typeof usageRequestSources)[number];

type RequestOutcomeCounts = {
  successCount?: number;
  clientErrorCount?: number;
  serverErrorCount?: number;
  authErrorCount?: number;
  rateLimitCount?: number;
  proxyErrorCount?: number;
  upstreamErrorCount?: number;
};

const toNonNegativeCount = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.trunc(parsed));
};

export const classifyRequestOutcome = (
  statusCode: number,
  source: UsageRequestSource
): {
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  authErrorCount: number;
  rateLimitCount: number;
  proxyErrorCount: number;
  upstreamErrorCount: number;
} => {
  const isSuccess = statusCode >= 200 && statusCode < 400;
  const isAuthError = statusCode === 401 || statusCode === 403;
  const isRateLimitError = statusCode === 429;
  const isClientError = statusCode >= 400 && statusCode < 500;
  const isNonRateLimitFailure = !isSuccess && !isRateLimitError;

  return {
    successCount: isSuccess ? 1 : 0,
    clientErrorCount:
      isClientError && !isAuthError && !isRateLimitError ? 1 : 0,
    serverErrorCount: statusCode >= 500 ? 1 : 0,
    authErrorCount: isAuthError ? 1 : 0,
    rateLimitCount: isRateLimitError ? 1 : 0,
    proxyErrorCount: source === "proxy" && isNonRateLimitFailure ? 1 : 0,
    upstreamErrorCount: source === "upstream" && isNonRateLimitFailure ? 1 : 0,
  };
};

export const countUnattributedFailures = (
  counts: RequestOutcomeCounts
): number => {
  const totalFailures =
    toNonNegativeCount(counts.clientErrorCount) +
    toNonNegativeCount(counts.serverErrorCount) +
    toNonNegativeCount(counts.authErrorCount);
  const attributedFailures =
    toNonNegativeCount(counts.proxyErrorCount) +
    toNonNegativeCount(counts.upstreamErrorCount);

  return Math.max(0, totalFailures - attributedFailures);
};

export const countScoredFailures = (counts: RequestOutcomeCounts): number =>
  toNonNegativeCount(counts.proxyErrorCount) +
  countUnattributedFailures(counts);

export const calculateSuccessRate = (
  counts: RequestOutcomeCounts
): number | null => {
  const successCount = toNonNegativeCount(counts.successCount);
  const denominator = successCount + countScoredFailures(counts);

  if (denominator <= 0) {
    return null;
  }

  return Math.round((successCount / denominator) * 100);
};
