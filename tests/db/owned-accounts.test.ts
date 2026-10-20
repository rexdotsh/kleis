import { afterEach, beforeEach, expect, test } from "bun:test";

import {
  unlinkOwnedProviderAccount,
  upsertProviderAccount,
} from "../../src/db/repositories/provider-accounts";
import { providerAccounts } from "../../src/db/schema";
import { createResetDatabase } from "../helpers/reset-database";

let fixture: Awaited<ReturnType<typeof createResetDatabase>>;
beforeEach(async () => {
  fixture = await createResetDatabase();
});
afterEach(async () => {
  await fixture.close();
});

const claude = (
  database: typeof fixture.database,
  accessToken: string,
  owner?: { id: string; label: string }
) =>
  upsertProviderAccount(database, {
    provider: "claude",
    accountId: null,
    accessToken,
    refreshToken: `refresh-${accessToken}`,
    expiresAt: Date.now() + 3_600_000,
    metadata: {
      provider: "claude",
      scope: null,
      oauthMode: "max",
      oauthHost: "claude.ai",
      accountUuid: "fake-user",
      organizationUuid: "fake-org",
    },
    ...(owner ? { owner } : {}),
    now: Date.now(),
  });

// Two processes write at once; each stands in for one of them.
test("a shared add and an owner link of one Claude subscription never both land", async () => {
  await Promise.allSettled([
    claude(fixture.database, "shared-access"),
    claude(fixture.contender, "owned-access", { id: "alice", label: "Alice" }),
  ]);
  const rows = await fixture.database.select().from(providerAccounts);
  expect(rows.filter((row) => row.accessToken)).toHaveLength(1);
});

test("a relink racing an unlink never puts credentials back on the unlinked row", async () => {
  const owner = { id: "alice", label: "Alice" };
  const linked = await claude(fixture.database, "first-access", owner);
  await Promise.allSettled([
    claude(fixture.database, "relinked-access", owner),
    unlinkOwnedProviderAccount(
      fixture.contender,
      { id: linked.id, ownerId: "alice", providerScopes: null },
      Date.now()
    ),
  ]);
  const rows = await fixture.database.select().from(providerAccounts);
  expect(
    rows.filter((row) => row.unlinkedAt !== null && row.accessToken)
  ).toEqual([]);
});
