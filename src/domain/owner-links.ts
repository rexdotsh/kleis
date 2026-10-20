import { z } from "zod";

import type { Database } from "../db";
import {
  consumeOAuthStateByValue,
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

const linkMetadataSchema = z.strictObject({ link: oauthOwnerSchema });
const ownedStateMetadataSchema = z.object({ owner: oauthOwnerSchema });

const readJson = (text: string | null): unknown => {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return null;
  }
};

// The owner is stored with the link, so whoever opens it can only link an
// account for that owner.
export const createOwnerLink = async (
  database: Database,
  provider: Provider,
  owner: ProviderAccountOwner,
  now: number
): Promise<{ token: string; expiresAt: number }> => {
  const token = `kln_${crypto.randomUUID().replaceAll("-", "")}`;
  const expiresAt = now + LINK_TTL_MS;
  await createOAuthState(database, {
    state: token,
    provider,
    pkceVerifier: null,
    metadataJson: JSON.stringify({ link: owner }),
    expiresAt,
  });
  return { token, expiresAt };
};

// Opening a link spends it and starts one sign-in bound to its owner.
export const startOwnerLink = async (
  database: Database,
  token: string,
  now: number
) => {
  const link = await consumeOAuthStateByValue(database, token, now);
  const metadata = linkMetadataSchema.safeParse(
    readJson(link?.metadataJson ?? null)
  );
  if (!link || !metadata.success) {
    return null;
  }
  const started = await startProviderOAuth(
    database,
    link.provider,
    {
      options: { mode: link.provider === "claude" ? "max" : "browser" },
      owner: metadata.data.link,
    },
    now
  );
  return {
    provider: link.provider,
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
