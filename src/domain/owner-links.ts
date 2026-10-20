import { z } from "zod";

import type { Database } from "../db";
import {
  consumeOAuthState,
  createOAuthState,
  findOAuthState,
} from "../db/repositories/oauth-states";
import type {
  ProviderAccountOwner,
  ProviderAccountRecord,
} from "../db/repositories/provider-accounts";
import type { Provider } from "../db/schema";
import { oauthOwnerSchema } from "./owners";
import {
  completeProviderOAuth,
  startProviderOAuth,
} from "./providers/provider-service";

const LINK_TTL_MS = 15 * 60_000;

const linkMetadataSchema = z.strictObject({
  link: oauthOwnerSchema,
  app: z.string().nullable(),
});
const ownedStateMetadataSchema = z.object({ owner: oauthOwnerSchema });

const readJson = (text: string | null | undefined): unknown => {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return null;
  }
};

const readLink = (row: { metadataJson: string | null } | null) => {
  const parsed = linkMetadataSchema.safeParse(readJson(row?.metadataJson));
  return parsed.success ? parsed.data : null;
};

// The owner and the delegated app are stored with the link, so whoever opens
// it can only link an account for that owner.
export const createOwnerLink = async (
  database: Database,
  input: {
    provider: Provider;
    owner: ProviderAccountOwner;
    app: string | null;
  },
  now: number
): Promise<{ token: string; expiresAt: number }> => {
  const token = `kln_${crypto.randomUUID().replaceAll("-", "")}`;
  const expiresAt = now + LINK_TTL_MS;
  await createOAuthState(database, {
    state: token,
    provider: input.provider,
    pkceVerifier: null,
    metadataJson: JSON.stringify({ link: input.owner, app: input.app }),
    expiresAt,
  });
  return { token, expiresAt };
};

// What the consent page names, without spending the link.
export const describeOwnerLink = async (
  database: Database,
  token: string,
  now: number
) => {
  const row = await findOAuthState(database, token, null, now);
  const link = readLink(row);
  return row && link
    ? {
        provider: row.provider,
        owner: link.link.label ?? link.link.id,
        app: link.app,
      }
    : null;
};

// Continuing spends the link and starts one sign-in bound to its owner.
export const startOwnerLink = async (
  database: Database,
  token: string,
  now: number
) => {
  const row = await consumeOAuthState(database, token, null, now);
  const link = readLink(row);
  if (!row || !link) {
    return null;
  }
  const started = await startProviderOAuth(
    database,
    row.provider,
    {
      options: { mode: row.provider === "claude" ? "max" : "browser" },
      owner: link.link,
    },
    now
  );
  return {
    provider: row.provider,
    authorizationUrl: started.authorizationUrl,
    state: started.state,
  };
};

// Completes only sign-ins started from a link, so this public step can never
// finish an admin's sign-in.
export const completeOwnerLink = async (
  database: Database,
  input: { provider: Provider; state: string; code: string },
  now: number
): Promise<ProviderAccountRecord | null> => {
  const pending = await findOAuthState(
    database,
    input.state,
    input.provider,
    now
  );
  if (
    !pending ||
    !ownedStateMetadataSchema.safeParse(readJson(pending.metadataJson)).success
  ) {
    return null;
  }
  return completeProviderOAuth(database, input.provider, input, now);
};
