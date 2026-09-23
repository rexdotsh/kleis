type AuthReplayAccount = {
  id: string;
  accessToken: string;
};

type AuthReplayAttempt = {
  response: Response;
};

export const sendCodexWithAuthReplay = async <
  Account extends AuthReplayAccount,
  Attempt extends AuthReplayAttempt,
>(input: {
  account: Account;
  signal?: AbortSignal;
  send(account: Account): Promise<Attempt>;
  refresh(
    accountId: string,
    failedAccessToken: string
  ): Promise<Account | null>;
}): Promise<{
  account: Account;
  attempt: Attempt;
  replayed: boolean;
  refreshFailed: boolean;
}> => {
  const firstAttempt = await input.send(input.account);
  if (firstAttempt.response.status !== 401) {
    return {
      account: input.account,
      attempt: firstAttempt,
      replayed: false,
      refreshFailed: false,
    };
  }

  let refreshed: Account | null;
  try {
    refreshed = await input.refresh(
      input.account.id,
      input.account.accessToken
    );
  } catch {
    input.signal?.throwIfAborted();
    return {
      account: input.account,
      attempt: firstAttempt,
      replayed: false,
      refreshFailed: true,
    };
  }
  if (!refreshed || refreshed.accessToken === input.account.accessToken) {
    return {
      account: refreshed ?? input.account,
      attempt: firstAttempt,
      replayed: false,
      refreshFailed: true,
    };
  }

  await firstAttempt.response.body?.cancel().catch(() => undefined);

  return {
    account: refreshed,
    attempt: await input.send(refreshed),
    replayed: true,
    refreshFailed: false,
  };
};
