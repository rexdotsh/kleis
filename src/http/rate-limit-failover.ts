export const isRateLimitFailoverEnabled = (): boolean =>
  process.env.KLEIS_RATE_LIMIT_FAILOVER === "1";

export const shouldPersistRateLimitFailover = (
  accountScopeIds: readonly string[] | null | undefined
): boolean => !accountScopeIds?.length;

export const shouldRetryRateLimitWithNextAccount = (input: {
  failoverEnabled: boolean;
  failoverAttempted: boolean;
  canFailover: boolean;
  statusCode: number;
  hasNextAccount: boolean;
}): boolean =>
  input.failoverEnabled &&
  !input.failoverAttempted &&
  input.canFailover &&
  input.statusCode === 429 &&
  input.hasNextAccount;
