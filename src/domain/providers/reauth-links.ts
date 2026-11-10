import type { Database } from "../../db";
import { deleteOAuthState } from "../../db/repositories/oauth-states";
import {
  ProviderAccountReauthorizationConflict,
  type ProviderAccountRecord,
} from "../../db/repositories/provider-accounts";
import {
  claimReauthLink,
  createReauthLink,
  findOpenReauthLink,
  recordReauthLinkFailure,
  releaseReauthLink,
  setReauthLinkOAuthState,
  type ReauthLinkSummary,
} from "../../db/repositories/reauth-links";
import { ClaudeShortSignInError } from "../../providers/claude";
import { OAuthError } from "../../providers/http";
import { errorLogFields, logWarn } from "../../utils/log";
import { expireProviderAccountTracking } from "./provider-account-tracking";
import {
  completeProviderOAuth,
  ProviderReauthorizationClaimedError,
  startProviderOAuth,
} from "./provider-service";

const REAUTH_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REAUTH_LINK_MAX_FAILED_ATTEMPTS = 10;
const REAUTH_TOKEN_PATTERN = /^[\w-]{43}$/u;

export const supportsReauthLink = (account: ProviderAccountRecord): boolean =>
  account.provider === "claude";

// What the public page may show about the account: the provider and its label.
// Claude labels default to the account's email, so an email label is hidden.
export type ReauthLinkTarget = {
  provider: ProviderAccountRecord["provider"];
  label: string | null;
};

const toTarget = (account: ProviderAccountRecord): ReauthLinkTarget => {
  const label = account.label?.trim() || null;
  return {
    provider: account.provider,
    label: label && !label.includes("@") ? label : null,
  };
};

export class ReauthLinkError extends Error {
  constructor(
    message: string,
    readonly linkUsable: boolean
  ) {
    super(message);
    this.name = "ReauthLinkError";
  }
}

const unavailable = () =>
  new ReauthLinkError("This reauthorize link is no longer valid.", false);

const generateReauthToken = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export const shareReauthLink = async (
  database: Database,
  account: ProviderAccountRecord,
  now: number
): Promise<ReauthLinkSummary & { token: string }> => {
  const token = generateReauthToken();
  const link = await createReauthLink(
    database,
    {
      providerAccountId: account.id,
      token,
      expiresAt: now + REAUTH_LINK_TTL_MS,
    },
    now
  );
  return { ...link, token };
};

const findLink = (database: Database, token: string, now: number) =>
  REAUTH_TOKEN_PATTERN.test(token)
    ? findOpenReauthLink(database, token, now)
    : Promise.resolve(null);

export const describeReauthLink = async (
  database: Database,
  token: string,
  now: number
): Promise<ReauthLinkTarget | null> => {
  const found = await findLink(database, token, now);
  return found && supportsReauthLink(found.account)
    ? toTarget(found.account)
    : null;
};

// Each start replaces the link's previous sign-in flow, so a link holds at
// most one.
export const startReauthLink = async (
  database: Database,
  token: string,
  now: number
): Promise<ReauthLinkTarget & { authorizationUrl: string }> => {
  const found = await findLink(database, token, now);
  if (!found || !supportsReauthLink(found.account)) {
    throw unavailable();
  }
  const { link, account } = found;
  const flow = await startProviderOAuth(
    database,
    account.provider,
    { options: { replaceAccountId: account.id } },
    now
  );
  if (!(await setReauthLinkOAuthState(database, link.id, flow.state, now))) {
    await deleteOAuthState(database, flow.state);
    throw unavailable();
  }
  if (link.oauthState) {
    await deleteOAuthState(database, link.oauthState);
  }
  return { ...toTarget(account), authorizationUrl: flow.authorizationUrl };
};

const failureMessage = (error: unknown): string => {
  if (error instanceof ProviderAccountReauthorizationConflict) {
    return "You signed in to a different Claude account or organization than the one this link is for. Sign in with the same account and try again.";
  }
  if (error instanceof ClaudeShortSignInError) {
    return error.message;
  }
  if (error instanceof OAuthError) {
    return `Claude didn't accept that code${error.code ? ` (${error.code})` : ""}. A code works once and expires within minutes. Get a new sign-in link and try again.`;
  }
  return "The sign-in didn't complete. Get a new sign-in link and try again.";
};

export const completeReauthLink = async (
  database: Database,
  token: string,
  code: string,
  now: number
): Promise<ReauthLinkTarget> => {
  const found = await findLink(database, token, now);
  if (!found || !supportsReauthLink(found.account)) {
    throw unavailable();
  }
  const { link, account } = found;
  if (!link.oauthState) {
    throw new ReauthLinkError("Get a sign-in link first.", true);
  }
  let claimedAt = 0;
  try {
    const updated = await completeProviderOAuth(
      database,
      account.provider,
      {
        state: link.oauthState,
        code,
        claim: {
          accountId: account.id,
          claim: () => {
            claimedAt = Date.now();
            return claimReauthLink(database, link.id, claimedAt);
          },
          release: () =>
            releaseReauthLink(database, link.id, claimedAt).catch(
              (error: unknown) => {
                logWarn("reauth_link_release_failed", {
                  providerAccountId: account.id,
                  ...errorLogFields(error),
                });
              }
            ),
        },
      },
      now
    );
    expireProviderAccountTracking(updated.id);
    return toTarget(updated);
  } catch (error) {
    if (error instanceof ProviderReauthorizationClaimedError) {
      throw unavailable();
    }
    logWarn("reauth_link_completion_failed", {
      provider: account.provider,
      providerAccountId: account.id,
      ...errorLogFields(error),
    });
    const revoked = await recordReauthLinkFailure(
      database,
      link.id,
      REAUTH_LINK_MAX_FAILED_ATTEMPTS,
      Date.now()
    );
    throw new ReauthLinkError(
      revoked
        ? "Too many failed attempts, so this link no longer works. Ask for a new one."
        : failureMessage(error),
      !revoked
    );
  }
};
