import { eq } from "drizzle-orm";
import type { Database } from "../index";
import { createLookupCache, invalidateLookupCaches } from "../lookup-cache";
import { proxySettings } from "../schema";

const cache = createLookupCache<boolean>(15_000);
const SETTINGS_ID = "global";

export const getRateLimitFailoverEnabled = (
  database: Database
): Promise<boolean> =>
  cache.get(database, SETTINGS_ID, async () => {
    const row = await database.query.proxySettings.findFirst({
      where: eq(proxySettings.id, SETTINGS_ID),
    });
    return row?.rateLimitFailover ?? false;
  });

export const setRateLimitFailoverEnabled = async (
  database: Database,
  enabled: boolean
): Promise<void> => {
  try {
    await database
      .insert(proxySettings)
      .values({
        id: SETTINGS_ID,
        rateLimitFailover: enabled,
      })
      .onConflictDoUpdate({
        target: proxySettings.id,
        set: { rateLimitFailover: enabled },
      });
  } finally {
    invalidateLookupCaches();
  }
};
