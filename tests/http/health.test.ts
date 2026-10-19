import { createClient } from "@libsql/client";
import { expect, setSystemTime, spyOn, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import { upsertProviderAccountSnapshots } from "../../src/db/repositories/provider-account-snapshots";
import * as schema from "../../src/db/schema";
import { createAccountSnapshotStore } from "../../src/domain/providers/account-snapshot-store";
import {
  recordProviderAccountLiveLimits,
  restoreProviderAccountSnapshots,
  setAccountSnapshotStore,
} from "../../src/domain/providers/provider-account-tracking";
import { createHealthRoutes } from "../../src/http/routes/health";

test("opt-in health reports only aggregate account issues without contacting providers", async () => {
  const client = createClient({ url: ":memory:" });
  const database = drizzle(client, { schema });
  const now = Date.now();
  const day = 24 * 60 * 60_000;
  const upstream = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected upstream request")
  );
  setSystemTime(now);
  try {
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    const fixtures: {
      provider: schema.Provider;
      enabled?: boolean;
      expired?: boolean;
      status?: string;
      deadline?: number;
      authError?: number;
      usedPercent?: number;
      resetAt?: number;
    }[] = [
      { provider: "codex" },
      { provider: "codex", enabled: false },
      { provider: "codex", expired: true },
      { provider: "codex", status: "reauthorize" },
      { provider: "codex", usedPercent: 100, resetAt: now + day },
      { provider: "codex", authError: 401 },
      { provider: "claude", deadline: now + day },
      { provider: "claude", status: "account_on_hold" },
      { provider: "claude", authError: 403 },
      { provider: "claude", usedPercent: 100, resetAt: now + day },
      {
        provider: "claude",
        usedPercent: 100,
        resetAt: now - day,
        deadline: now + 30 * day,
      },
    ];
    const fixturesById = new Map<string, (typeof fixtures)[number]>();
    for (const fixture of fixtures) {
      const id = crypto.randomUUID();
      fixturesById.set(id, fixture);
      await database.insert(schema.providerAccounts).values({
        id,
        provider: fixture.provider,
        label: `private-label-${id}`,
        accountId: `private-account-${id}`,
        accessToken: `secret-access-${id}`,
        refreshToken: `secret-refresh-${id}`,
        enabled: fixture.enabled ?? true,
        expiresAt: now + (fixture.expired ? -day : day),
        lastRefreshStatus: fixture.status ?? "success",
        metadataJson: JSON.stringify(
          fixture.provider === "claude"
            ? {
                provider: "claude",
                oauthMode: "max",
                oauthHost: "claude.ai",
                email: `${id}@example.com`,
                organizationName: `private-organization-${id}`,
                refreshTokenExpiresAt: fixture.deadline,
              }
            : {
                provider: "codex",
                chatgptAccountId: `private-account-${id}`,
                email: `${id}@example.com`,
                planTypeClaim: "private-plan",
              }
        ),
        createdAt: now,
        updatedAt: now,
      });
      if (fixture.authError) {
        await upsertProviderAccountSnapshots(database, [
          {
            providerAccountId: id,
            accountIdentity: `private-account-${id}`,
            quota: {
              json: JSON.stringify({ provider: fixture.provider }),
              fetchedAt: now - day,
              error: `private-error-${id}`,
              errorStatus: fixture.authError,
            },
            updatedAt: now,
          },
        ]);
      }
    }
    const accounts = await restoreProviderAccountSnapshots(
      database,
      createAccountSnapshotStore(database)
    );
    setAccountSnapshotStore(null);
    for (const account of accounts ?? []) {
      const fixture = fixturesById.get(account.id);
      if (fixture?.usedPercent === undefined) continue;
      recordProviderAccountLiveLimits(
        account,
        account.provider === "codex"
          ? {
              provider: "codex",
              primaryWindow: {
                usedPercent: fixture.usedPercent,
                resetAt: fixture.resetAt ?? null,
                windowSeconds: 18_000,
              },
              secondaryWindow: null,
              credits: null,
              planType: "private-plan",
            }
          : {
              provider: "claude",
              windows: {
                seven_day_sonnet: {
                  utilization: fixture.usedPercent,
                  resetsAt: new Date(fixture.resetAt ?? now).toISOString(),
                },
              },
            }
      );
    }

    let draining = false;
    const health = createHealthRoutes(() => draining, database);
    const expected = {
      ok: true,
      service: "kleis",
      now,
      accounts: {
        codex: {
          total: 6,
          enabled: 5,
          healthy: 1,
          needsReauth: 3,
          onHold: 0,
          limited: 1,
        },
        claude: {
          total: 5,
          enabled: 5,
          healthy: 1,
          needsReauth: 3,
          onHold: 1,
          limited: 1,
        },
      },
    };
    const response = await health.request("/healthz?accounts=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);

    client.close();
    expect(await (await health.request("/healthz?accounts=1")).json()).toEqual(
      expected
    );
    for (const path of ["/healthz", "/healthz?accounts=0"]) {
      expect(await (await health.request(path)).json()).toEqual({
        ok: true,
        service: "kleis",
        now,
      });
    }
    draining = true;
    const drained = await health.request("/healthz?accounts=1");
    expect(drained.status).toBe(503);
    expect(await drained.json()).toEqual({
      ok: false,
      service: "kleis",
      draining: true,
      now,
    });
    await Bun.sleep(0);
    expect(upstream).not.toHaveBeenCalled();
  } finally {
    upstream.mockRestore();
    setSystemTime();
    setAccountSnapshotStore(null);
    client.close();
  }
});
