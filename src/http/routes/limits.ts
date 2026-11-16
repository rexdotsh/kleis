import { Hono } from "hono";

import type { Database } from "../../db";
import { providers } from "../../db/schema";
import { describeAccountLimits } from "../../domain/providers/account-limits";
import { providerAccountSnapshotsRestored } from "../../domain/providers/provider-account-tracking";
import {
  findRoutingCandidates,
  selectRoutedAccount,
} from "../../domain/providers/provider-service";

// Limits of the accounts this key's requests may route to, from cached
// snapshots only. `routed` marks the account the key's next request for that
// provider would use.
export const createLimitsRoutes = (database: Database) =>
  new Hono().get("/", async (context) => {
    const apiKey = context.get("apiKey");
    await providerAccountSnapshotsRestored();
    const accounts = [];
    for (const provider of apiKey.providerScopes ?? providers) {
      const candidates = await findRoutingCandidates(
        database,
        provider,
        apiKey.accountScopes
      );
      const routed = selectRoutedAccount(candidates);
      for (const account of candidates) {
        accounts.push({
          ...describeAccountLimits(account),
          routed: account.id === routed?.id,
        });
      }
    }
    return context.json({ accounts });
  });
