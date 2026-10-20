import { Hono } from "hono";

import type { Database } from "../../db";
import { providers } from "../../db/schema";
import { describeAccountLimits } from "../../domain/providers/account-limits";
import { providerAccountSnapshotsRestored } from "../../domain/providers/provider-account-tracking";
import { findRoutingCandidates } from "../../domain/providers/provider-service";

// Limits of the accounts this key's requests may route to, from cached
// snapshots only.
export const createLimitsRoutes = (database: Database) =>
  new Hono().get("/", async (context) => {
    const apiKey = context.get("apiKey");
    await providerAccountSnapshotsRestored();
    const accounts = [];
    for (const provider of apiKey.providerScopes ?? providers) {
      accounts.push(
        ...(await findRoutingCandidates(
          database,
          provider,
          apiKey.accountScopes
        ))
      );
    }
    return context.json({ accounts: accounts.map(describeAccountLimits) });
  });
