import { createClient } from "@libsql/client";
import { expect, spyOn, test } from "bun:test";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { Hono } from "hono";

import {
  createApiKey,
  type CreateApiKeyInput,
} from "../../src/db/repositories/api-keys";
import { listProviderAccounts } from "../../src/db/repositories/provider-accounts";
import * as schema from "../../src/db/schema";
import { recordProviderAccountLiveLimits } from "../../src/domain/providers/provider-account-tracking";
import { createLimitsRoutes } from "../../src/http/routes/limits";

test("a key reads cached limits of only the accounts it may route to", async () => {
  const client = createClient({ url: ":memory:" });
  const database = drizzle(client, { schema });
  const upstream = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected upstream request")
  );
  try {
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
    const now = Date.now();
    const resetAt = Math.floor(now / 1000) * 1000 + 60 * 60_000;
    for (const [id, provider, isPrimary] of [
      ["claude-primary", "claude", true],
      ["claude-other", "claude", false],
      ["codex-primary", "codex", true],
      ["codex-pinned", "codex", false],
    ] as const) {
      await database.insert(schema.providerAccounts).values({
        id,
        provider,
        label: `${id}-label`,
        isPrimary,
        accessToken: `secret-access-${id}`,
        refreshToken: `secret-refresh-${id}`,
        expiresAt: now + 60 * 60_000,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const account of await listProviderAccounts(database)) {
      recordProviderAccountLiveLimits(
        account,
        account.provider === "codex"
          ? {
              provider: "codex",
              primaryWindow: {
                usedPercent: 40,
                resetAt: Math.floor(resetAt / 1000),
                windowSeconds: 18_000,
              },
              secondaryWindow: null,
              credits: null,
              planType: null,
            }
          : {
              provider: "claude",
              windows: {
                five_hour: {
                  utilization: 40,
                  resetsAt: new Date(resetAt).toISOString(),
                },
              },
            }
      );
    }

    const read = async (input: CreateApiKeyInput) => {
      const apiKey = await createApiKey(database, input, now);
      const app = new Hono();
      app.use("*", async (context, next) => {
        context.set("apiKey", apiKey);
        await next();
      });
      app.route("/", createLimitsRoutes(database));
      const body = await (await app.request("/")).text();
      expect(body).not.toContain("secret-");
      return (JSON.parse(body) as { accounts: { id: string }[] }).accounts;
    };

    for (const { input, ids } of [
      { input: {}, ids: ["codex-primary", "claude-primary"] },
      { input: { providerScopes: ["claude"] }, ids: ["claude-primary"] },
      {
        input: { accountScopes: ["codex-pinned"] },
        ids: ["codex-pinned", "claude-primary"],
      },
    ] satisfies { input: CreateApiKeyInput; ids: string[] }[]) {
      const accounts = await read(input);
      expect(accounts.map((account) => account.id).sort()).toEqual(ids.sort());
      expect(accounts[0]).toMatchObject({
        label: `${accounts[0]?.id}-label`,
        windows: [{ label: "5h", usedPercent: 40, resetsAt: resetAt }],
      });
    }
    await Bun.sleep(0);
    expect(upstream).not.toHaveBeenCalled();
  } finally {
    upstream.mockRestore();
    client.close();
  }
});
