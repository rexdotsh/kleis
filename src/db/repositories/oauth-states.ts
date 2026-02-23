import { and, eq } from "drizzle-orm";

import type { Database } from "../client";
import { oauthStates, type Provider } from "../schema";

export type OAuthStateRecord = {
  state: string;
  provider: Provider;
  pkceVerifier: string | null;
  metadataJson: string | null;
  expiresAt: number;
  createdAt: number;
};

const toRecord = (row: typeof oauthStates.$inferSelect): OAuthStateRecord => ({
  state: row.state,
  provider: row.provider,
  pkceVerifier: row.pkceVerifier,
  metadataJson: row.metadataJson,
  expiresAt: row.expiresAt,
  createdAt: row.createdAt,
});

export type CreateOAuthStateInput = {
  state: string;
  provider: Provider;
  pkceVerifier: string | null;
  metadataJson: string | null;
  expiresAt: number;
  createdAt: number;
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
    createdAt: input.createdAt,
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

  if (!row) {
    return null;
  }

  await database
    .delete(oauthStates)
    .where(
      and(eq(oauthStates.state, state), eq(oauthStates.provider, provider))
    );

  if (row.expiresAt <= now) {
    return null;
  }

  return toRecord(row);
};

export const findOAuthState = async (
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

  return toRecord(row);
};

export const deleteOAuthState = async (
  database: Database,
  state: string,
  provider: Provider
): Promise<void> => {
  await database
    .delete(oauthStates)
    .where(
      and(eq(oauthStates.state, state), eq(oauthStates.provider, provider))
    );
};
