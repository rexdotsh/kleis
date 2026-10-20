import { and, eq, gt } from "drizzle-orm";

import type { Database } from "../index";
import { oauthStates, type Provider } from "../schema";

type OAuthStateRecord = typeof oauthStates.$inferSelect;

export const createOAuthState = async (
  database: Database,
  input: OAuthStateRecord
): Promise<void> => {
  await database.insert(oauthStates).values(input);
};

export const findOAuthState = async (
  database: Database,
  state: string,
  // Null matches any provider, for links that don't name one.
  provider: Provider | null,
  now: number
): Promise<OAuthStateRecord | null> => {
  const row = await database.query.oauthStates.findFirst({
    where: and(
      eq(oauthStates.state, state),
      provider ? eq(oauthStates.provider, provider) : undefined
    ),
  });

  if (!row || row.expiresAt <= now) {
    return null;
  }

  return row;
};

export const consumeOAuthState = async (
  database: Database,
  state: string,
  provider: Provider | null,
  now: number
): Promise<OAuthStateRecord | null> => {
  const [row] = await database
    .delete(oauthStates)
    .where(
      and(
        eq(oauthStates.state, state),
        provider ? eq(oauthStates.provider, provider) : undefined,
        gt(oauthStates.expiresAt, now)
      )
    )
    .returning();

  return row ?? null;
};
