type AuthReplayAccount = {
  id: string;
  accessToken: string;
};

type AuthReplayAttempt = {
  response: Response;
};

export class CodexAuthRefreshError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAuthRefreshError";
  }
}

export const sendCodexWithAuthReplay = async <
  Account extends AuthReplayAccount,
  Attempt extends AuthReplayAttempt,
>(input: {
  account: Account;
  send(account: Account): Promise<Attempt>;
  refresh(
    accountId: string,
    failedAccessToken: string
  ): Promise<Account | null>;
}): Promise<{ account: Account; attempt: Attempt; replayed: boolean }> => {
  const firstAttempt = await input.send(input.account);
  if (firstAttempt.response.status !== 401) {
    return {
      account: input.account,
      attempt: firstAttempt,
      replayed: false,
    };
  }

  await firstAttempt.response.body?.cancel().catch(() => undefined);

  let refreshed: Account | null;
  try {
    refreshed = await input.refresh(
      input.account.id,
      input.account.accessToken
    );
  } catch (error) {
    throw new CodexAuthRefreshError("Failed to refresh Codex credentials", {
      cause: error,
    });
  }
  if (!refreshed) {
    throw new CodexAuthRefreshError("Codex account no longer exists");
  }

  return {
    account: refreshed,
    attempt: await input.send(refreshed),
    replayed: true,
  };
};
