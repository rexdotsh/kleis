import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import * as schema from "../../src/db/schema";

export const createResetDatabase = async () => {
  // libSQL transactions detach their connection, so an anchor keeps the shared
  // in-memory database alive while independent clients record spends.
  const clients = [0, 1, 2].map(() =>
    createClient({ url: "file::memory:?cache=shared" })
  );
  const [anchor, database, contender] = clients.map((client) =>
    drizzle(client, { schema })
  );
  if (!anchor || !database || !contender)
    throw new Error("Reset database clients missing");
  const clear = () =>
    anchor.batch([
      anchor.delete(schema.resetSpends),
      anchor.delete(schema.providerAccounts),
    ]);
  try {
    await migrate(anchor, { migrationsFolder: "./drizzle/migrations" });
    await clear();
  } catch (error) {
    for (const client of clients) client.close();
    throw error;
  }
  return {
    database,
    contender,
    async close() {
      try {
        await clear();
      } finally {
        for (const client of clients) client.close();
      }
    },
  };
};
