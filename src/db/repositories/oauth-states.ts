import { and, eq } from "drizzle-orm";

import type { Database } from "../index";
import { oauthStates, type Provider } from "../schema";

type OAuthStateRecord = {
  state: string;
  provider: Provider;
  pkceVerifier: string | null;
  metadataJson: string | null;
  expiresAt: number;
};

const toRecord = (row: typeof oauthStates.$inferSelect): OAuthStateRecord => ({
  state: row.state,
  provider: row.provider,
  pkceVerifier: row.pkceVerifier,
  metadataJson: row.metadataJson,
  expiresAt: row.expiresAt,
});

type CreateOAuthStateInput = {
  state: string;
  provider: Provider;
  pkceVerifier: string | null;
  metadataJson: string | null;
  expiresAt: number;
};

export const createOAuthState = async (
  database: Database,
  input: CreateOAuthStateInput
): Promise<void> => {
  await database.insert(oauthStates).values({
    state: input.state,
    provider: input.provider,
    pkceVerifier: input.pkceVerifier,
    metadataJson: input.metadataJson,
    expiresAt: input.expiresAt,
  });
};

export const consumeOAuthState = async (
  database: Database,
  state: string,
  provider: Provider,
  now: number
): Promise<OAuthStateRecord | null> => {
  const row = await database.query.oauthStates.findFirst({
    where: and(
      eq(oauthStates.state, state),
      eq(oauthStates.provider, provider)
    ),
  });

  if (!row || row.expiresAt <= now) {
    return null;
  }

  const deleteResult = await database
    .delete(oauthStates)
    .where(
      and(eq(oauthStates.state, state), eq(oauthStates.provider, provider))
    );

  if (deleteResult.rowsAffected < 1) {
    return null;
  }

  return toRecord(row);
};
