import type { Database } from "../db";
import type { ProviderAccountRecord } from "../db/repositories/provider-accounts";
import {
  accountCooldowns,
  logRateLimitFailover,
  readRateLimitReset,
} from "../domain/providers/rate-limit-failover";
import {
  refreshProviderAccount,
  refreshProviderAccountAfterAuthFailure,
} from "../domain/providers/provider-service";
import { readUpstreamResponseError } from "../providers/proxies/upstream-error";
import { sendWithAuthReplay } from "./auth-replay";

export const sendWithRateLimitFailover = async <
  Attempt extends { response: Response },
>(input: {
  database: Database;
  account: ProviderAccountRecord;
  remaining: readonly ProviderAccountRecord[];
  enabled: boolean;
  signal: AbortSignal;
  send(account: ProviderAccountRecord): Promise<Attempt>;
  onResponse(account: ProviderAccountRecord, response: Response): Promise<void>;
}): Promise<{ account: ProviderAccountRecord; attempt: Attempt }> => {
  let account = input.account;
  const remaining = [...input.remaining];
  while (true) {
    input.signal.throwIfAborted();
    const result = await sendWithAuthReplay({
      account,
      signal: input.signal,
      send: input.send,
      refresh: (id, token) =>
        refreshProviderAccountAfterAuthFailure(
          input.database,
          id,
          token,
          input.signal
        ),
    });
    account = result.account;
    const response = result.attempt.response;
    await input.onResponse(account, response);
    // Only HTTP rejections are replayable. Stream errors belong to the response
    // already returned to the client and never enter this loop.
    if (!input.enabled || response.status !== 429) return result;
    const { errorType, errorCode } = await readUpstreamResponseError(response);
    const limited =
      account.provider === "claude"
        ? errorType === "rate_limit_error" ||
          response.headers.get("anthropic-ratelimit-unified-status") ===
            "rejected"
        : errorType === "usage_limit_reached" ||
          errorCode === "usage_limit_reached";
    if (!limited) return result;
    accountCooldowns.mark(
      account.id,
      readRateLimitReset(account.provider, response.headers)
    );
    const next = remaining.find(
      (candidate) => !accountCooldowns.resetAt(candidate.id)
    );
    if (!next) return result;
    remaining.splice(0, remaining.indexOf(next) + 1);
    input.signal.throwIfAborted();
    await response.body?.cancel().catch(() => undefined);
    const ready =
      next.expiresAt > Date.now()
        ? next
        : await refreshProviderAccount(input.database, next.id, Date.now());
    if (!ready) throw new Error("Failover account is unavailable");
    logRateLimitFailover(account, ready);
    account = ready;
  }
};
