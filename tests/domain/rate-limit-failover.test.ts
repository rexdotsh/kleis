import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "../../src/db/schema";
import {
  upsertProviderAccount,
  updateProviderAccountProfile,
  setProviderAccountsEnabled,
  type ProviderAccountRecord,
} from "../../src/db/repositories/provider-accounts";
import {
  getRateLimitFailoverEnabled,
  setRateLimitFailoverEnabled,
} from "../../src/db/repositories/proxy-settings";
import {
  createAccountCooldowns,
  failoverCandidates,
  getProviderAccountRouting,
  readRateLimitReset,
} from "../../src/domain/providers/rate-limit-failover";

const account = (
  id: string,
  patch: Partial<ProviderAccountRecord> = {}
): ProviderAccountRecord => ({
  id,
  provider: "claude",
  label: null,
  accountId: null,
  enabled: true,
  excludeFromFailover: false,
  isPrimary: false,
  accessToken: "fake",
  refreshToken: "fake",
  refreshLockToken: null,
  refreshLockExpiresAt: null,
  expiresAt: 1e15,
  metadata: null,
  lastRefreshAt: null,
  lastRefreshStatus: null,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
});

test("candidates are same-provider, enabled, included, unique and preferred first", () => {
  const preferred = account("primary", {
    isPrimary: true,
    excludeFromFailover: true,
  });
  const older = account("older", { createdAt: 1 });
  const newer = account("newer", { createdAt: 2 });
  expect(
    failoverCandidates(
      preferred,
      [
        preferred,
        older,
        newer,
        account("disabled", { enabled: false }),
        account("excluded", { excludeFromFailover: true }),
        account("codex", { provider: "codex" }),
      ],
      []
    ).map((entry) => entry.id)
  ).toEqual(["primary", "newer", "older"]);
});

test("pins restrict alternates even when another primary is available", () => {
  const pin = account("pin");
  const other = account("other");
  expect(failoverCandidates(pin, [other], [pin])).toEqual([pin]);
  expect(failoverCandidates(pin, [other], [pin, other])).toEqual([pin, other]);
});

test("cooldowns expire and concurrent marks cannot shorten them", () => {
  const cooldowns = createAccountCooldowns();
  cooldowns.mark("a", 2000, 1000);
  cooldowns.mark("a", 1500, 1000);
  expect(cooldowns.resetAt("a", 1999)).toBe(2000);
  expect(cooldowns.resetAt("a", 2000)).toBe(0);
  expect(cooldowns.resetAt("a", 1000)).toBe(0);
});

test.each(["claude", "codex"] as const)(
  "%s cooldown accepts retry-after seconds and HTTP dates",
  (provider) => {
    expect(
      readRateLimitReset(
        provider,
        new Headers({ "retry-after": "90" }),
        1_000_000
      )
    ).toBe(1_090_000);
    expect(
      readRateLimitReset(
        provider,
        new Headers({ "retry-after": new Date(2_000_000).toUTCString() }),
        1_000_000
      )
    ).toBe(2_000_000);
  }
);

test("Claude uses the exhausted window, not a later unexhausted one", () => {
  expect(
    readRateLimitReset(
      "claude",
      new Headers({
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-5h-reset": "2000",
        "anthropic-ratelimit-unified-7d-utilization": "0.2",
        "anthropic-ratelimit-unified-7d-reset": "9000",
      }),
      1_000_000
    )
  ).toBe(2_000_000);
});

test("Codex waits for all exhausted windows to reset", () => {
  expect(
    readRateLimitReset(
      "codex",
      new Headers({
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-at": "2000",
        "x-codex-secondary-used-percent": "100",
        "x-codex-secondary-reset-at": "3000",
      }),
      1_000_000
    )
  ).toBe(3_000_000);
});

test.each(["claude", "codex"] as const)(
  "%s missing, invalid or past reset uses a 30s cooldown",
  (provider) => {
    for (const value of ["", "nope", "-1", "Infinity", "0"]) {
      expect(
        readRateLimitReset(
          provider,
          new Headers({ "retry-after": value }),
          1_000_000
        )
      ).toBe(1_030_000);
    }
  }
);

describe("failover routing persistence", () => {
  let client: ReturnType<typeof createClient>;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kleis-failover-test-"));
    client = createClient({ url: `file:${directory}/test.db` });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
  });
  afterEach(async () => {
    client.close();
    await rm(directory, { recursive: true });
  });

  const insert = (provider: schema.Provider, id: string) =>
    upsertProviderAccount(database, {
      provider,
      accountId: id,
      accessToken: "fake-access",
      refreshToken: "fake-refresh",
      expiresAt: Date.now() + 3_600_000,
      metadata: null,
      now: Date.now(),
    });

  test("settings default off and repository changes invalidate routing immediately", async () => {
    const primary = await insert("claude", "one");
    const alternate = await insert("claude", "two");
    expect(await getRateLimitFailoverEnabled(database)).toBe(false);
    expect(
      (await getProviderAccountRouting(database, "claude", null)).accounts.map(
        (entry) => entry.id
      )
    ).toEqual([primary.id]);
    await setRateLimitFailoverEnabled(database, true);
    expect(
      (await getProviderAccountRouting(database, "claude", null)).accounts
    ).toHaveLength(2);
    await updateProviderAccountProfile(database, alternate.id, {
      label: null,
      accountId: alternate.accountId,
      metadata: null,
      excludeFromFailover: true,
      now: Date.now(),
    });
    expect(
      (await getProviderAccountRouting(database, "claude", null)).accounts.map(
        (entry) => entry.id
      )
    ).toEqual([primary.id]);
    expect((await insert("claude", "two")).excludeFromFailover).toBe(true);
    await setRateLimitFailoverEnabled(database, false);
    expect(await getRateLimitFailoverEnabled(database)).toBe(false);
  });

  test("other-provider pins use the primary, but disabled same-provider pins cannot escape", async () => {
    const primary = await insert("claude", "one");
    const pin = await insert("codex", "two");
    await setRateLimitFailoverEnabled(database, true);
    expect(
      (await getProviderAccountRouting(database, "claude", [pin.id])).preferred
        ?.id
    ).toBe(primary.id);
    await setProviderAccountsEnabled(database, "codex", false, Date.now());
    expect(
      (await getProviderAccountRouting(database, "codex", [pin.id])).preferred
    ).toBeNull();
  });
});
