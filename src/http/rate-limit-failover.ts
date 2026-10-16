import type { Database } from "../db";
import type { ProviderAccountRecord } from "../db/repositories/provider-accounts";
import {
  logRateLimitFailover,
  readRateLimitReset,
} from "../domain/providers/rate-limit-failover";
import {
  refreshProviderAccount,
  refreshProviderAccountAfterAuthFailure,
} from "../domain/providers/provider-service";
import {
  accountCooldowns,
  type AccountCooldownObservation,
} from "../providers/account-tracking/rate-limit-cooldowns";
import {
  readClaudeLiveLimits,
  readCodexLiveLimits,
} from "../providers/account-tracking/live-limits";
import { isSubscriptionLimitResponse } from "../providers/proxies/subscription-limit";
import { sendWithAuthReplay } from "./auth-replay";

export const sendWithRateLimitFailover = async <
  Attempt extends { response: Response },
>(input: {
  database: Database;
  account: ProviderAccountRecord;
  remaining: readonly ProviderAccountRecord[];
  enabled: boolean;
  signal: AbortSignal;
  send(
    account: ProviderAccountRecord,
    observation: AccountCooldownObservation
  ): Promise<Attempt>;
  onResponse(
    account: ProviderAccountRecord,
    response: Response,
    observation: AccountCooldownObservation
  ): Promise<void>;
}): Promise<{ account: ProviderAccountRecord; attempt: Attempt }> => {
  let account = input.account;
  const remaining = [...input.remaining];
  while (true) {
    input.signal.throwIfAborted();
    const sent = await sendWithAuthReplay({
      account,
      signal: input.signal,
      send: async (current) => {
        const observation = accountCooldowns.capture(current);
        const attempt = await input.send(current, observation);
        return { response: attempt.response, attempt, observation };
      },
      refresh: (id, token) =>
        refreshProviderAccountAfterAuthFailure(
          input.database,
          id,
          token,
          input.signal
        ),
    });
    account = sent.account;
    const { attempt, observation } = sent.attempt;
    const result = { account, attempt };
    const response = attempt.response;
    await input.onResponse(account, response, observation);
    // Only HTTP rejections are replayable. Stream errors belong to the response
    // already returned to the client and never enter this loop.
    if (!input.enabled || response.status !== 429) return result;
    if (
      !(await isSubscriptionLimitResponse(
        account.provider,
        response,
        input.signal
      ))
    )
      return result;
    observation.mark(
      readRateLimitReset(account.provider, response.headers),
      account.provider === "claude"
        ? readClaudeLiveLimits(response.headers)
        : readCodexLiveLimits(response.headers)
    );
    const next = remaining.find(
      (candidate) => !accountCooldowns.resetAt(candidate)
    );
    if (!next) return result;
    remaining.splice(0, remaining.indexOf(next) + 1);
    input.signal.throwIfAborted();
    await response.body?.cancel().catch(() => undefined);
    const ready =
      next.expiresAt > Date.now()
        ? next
        : await refreshProviderAccount(input.database, next.id, Date.now(), {
            signal: input.signal,
          });
    if (!ready) throw new Error("Failover account is unavailable");
    logRateLimitFailover(account, ready);
    account = ready;
  }
};
