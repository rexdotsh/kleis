export type UsageRequestSource = "proxy" | "upstream";

type RequestOutcomeCounts = {
  successCount?: number;
  clientErrorCount?: number;
  serverErrorCount?: number;
  authErrorCount?: number;
  rateLimitCount?: number;
  proxyErrorCount?: number;
  upstreamErrorCount?: number;
};

type ClassifiedRequestOutcome = Required<RequestOutcomeCounts>;

const c = (v?: number): number => (v && v > 0 ? Math.trunc(v) : 0);

export const classifyRequestOutcome = (
  statusCode: number,
  source: UsageRequestSource
): ClassifiedRequestOutcome => {
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
    c(counts.clientErrorCount) +
    c(counts.serverErrorCount) +
    c(counts.authErrorCount);
  const attributedFailures =
    c(counts.proxyErrorCount) + c(counts.upstreamErrorCount);

  return Math.max(0, totalFailures - attributedFailures);
};

export const countScoredFailures = (counts: RequestOutcomeCounts): number =>
  c(counts.proxyErrorCount) + countUnattributedFailures(counts);

export const calculateSuccessRate = (
  counts: RequestOutcomeCounts
): number | null => {
  const successCount = c(counts.successCount);
  const denominator = successCount + countScoredFailures(counts);

  if (denominator <= 0) {
    return null;
  }

  return Math.round((successCount / denominator) * 100);
};
