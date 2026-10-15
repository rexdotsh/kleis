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
  replaceProviderAccountCredentials,
  updateProviderAccountTokens,
  type ProviderAccountRecord,
} from "../../src/db/repositories/provider-accounts";
import {
  getRateLimitFailoverEnabled,
  setRateLimitFailoverEnabled,
} from "../../src/db/repositories/proxy-settings";
import {
  failoverCandidates,
  getProviderAccountRouting,
  readRateLimitReset,
} from "../../src/domain/providers/rate-limit-failover";
import {
  accountCooldowns,
  createAccountCooldowns,
} from "../../src/providers/account-tracking/rate-limit-cooldowns";
import {
  readClaudeLiveLimits,
  readCodexLiveLimits,
} from "../../src/providers/account-tracking/live-limits";
import {
  recordProviderAccountLiveLimits,
  redeemCodexResetCredit,
} from "../../src/domain/providers/provider-account-tracking";
import { refreshProviderAccount } from "../../src/domain/providers/provider-service";
import { codexAdapter } from "../../src/providers/codex";
import { sendWithRateLimitFailover } from "../../src/http/rate-limit-failover";

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
  const entry = account("a");
  cooldowns.mark(entry, 2000, null, 1000);
  cooldowns.mark(entry, 1500, null, 1000);
  expect(cooldowns.resetAt(entry, 1999)).toBe(2000);
  expect(cooldowns.resetAt(entry, 2000)).toBe(0);
  expect(cooldowns.resetAt(entry, 1000)).toBe(0);
});

test("a replacement provider identity cannot inherit a row's cooldown", () => {
  const cooldowns = createAccountCooldowns();
  const previous = account("same-row", {
    provider: "codex",
    accountId: "old-identity",
  });
  const replacement = { ...previous, accountId: "new-identity" };
  cooldowns.mark(previous, Date.now() + 18_000_000);
  expect(cooldowns.resetAt(replacement)).toBe(0);
  expect(cooldowns.resetAt(previous)).toBeGreaterThan(Date.now());
});

test.each(["claude", "codex"] as const)(
  "%s live recovery clears only a proven recovered blocking window",
  (provider) => {
    const entry = account(crypto.randomUUID(), { provider });
    const read =
      provider === "claude" ? readClaudeLiveLimits : readCodexLiveLimits;
    const blocked = read(
      new Headers(
        provider === "claude"
          ? { "anthropic-ratelimit-unified-5h-utilization": "1" }
          : { "x-codex-primary-used-percent": "100" }
      )
    );
    const unrelated = read(
      new Headers(
        provider === "claude"
          ? { "anthropic-ratelimit-unified-7d-utilization": "0.1" }
          : { "x-codex-secondary-used-percent": "10" }
      )
    );
    const recovered = read(
      new Headers(
        provider === "claude"
          ? { "anthropic-ratelimit-unified-5h-utilization": "0.1" }
          : { "x-codex-primary-used-percent": "10" }
      )
    );
    accountCooldowns.mark(entry, Date.now() + 18_000_000, blocked);
    recordProviderAccountLiveLimits(entry, unrelated);
    expect(accountCooldowns.resetAt(entry)).toBeGreaterThan(Date.now());
    recordProviderAccountLiveLimits(entry, recovered);
    expect(accountCooldowns.resetAt(entry)).toBe(0);
  }
);

test("partial live readings retain each blocking window until it recovers", () => {
  const cooldowns = createAccountCooldowns();
  const entry = account("two-windows", { provider: "codex" });
  const blocked = readCodexLiveLimits(
    new Headers({
      "x-codex-primary-used-percent": "100",
      "x-codex-secondary-used-percent": "100",
    })
  );
  cooldowns.mark(entry, Date.now() + 18_000_000, blocked);
  const primary = readCodexLiveLimits(
    new Headers({ "x-codex-primary-used-percent": "10" })
  );
  const secondary = readCodexLiveLimits(
    new Headers({ "x-codex-secondary-used-percent": "10" })
  );
  if (!primary || !secondary) throw new Error("Missing live limits");
  cooldowns.observe(entry, primary);
  expect(cooldowns.resetAt(entry)).toBeGreaterThan(Date.now());
  cooldowns.observe(entry, secondary);
  expect(cooldowns.resetAt(entry)).toBe(0);
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
  const originalFetch = globalThis.fetch;
  const originalRefresh = codexAdapter.refreshAccount;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "kleis-failover-test-"));
    client = createClient({ url: `file:${directory}/test.db` });
    database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: "./drizzle/migrations" });
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    codexAdapter.refreshAccount = originalRefresh;
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

  test("reauthorization and credential import clear same-identity cooldowns", async () => {
    const primary = await insert("codex", "one");
    accountCooldowns.mark(primary, Date.now() + 18_000_000);
    const updated = await replaceProviderAccountCredentials(
      database,
      primary.id,
      {
        provider: primary.provider,
        accountId: primary.accountId,
        accessToken: "fake-reauthorized",
        refreshToken: "fake-reauthorized-refresh",
        expiresAt: Date.now() + 3_600_000,
        metadata: null,
        now: Date.now(),
      }
    );
    expect(updated).not.toBeNull();
    expect(accountCooldowns.resetAt(primary)).toBe(0);
    accountCooldowns.mark(primary, Date.now() + 18_000_000);
    await insert("codex", "one");
    expect(accountCooldowns.resetAt(primary)).toBe(0);
  });

  test("editing identity restores preferred routing immediately", async () => {
    const primary = await insert("codex", "one");
    await setRateLimitFailoverEnabled(database, true);
    accountCooldowns.mark(primary, Date.now() + 18_000_000);
    expect(
      (await getProviderAccountRouting(database, "codex", null))
        .retryAfterSeconds
    ).toBeGreaterThan(17_999);
    await updateProviderAccountProfile(database, primary.id, {
      label: null,
      accountId: "replacement-identity",
      metadata: null,
      now: Date.now(),
    });
    const routing = await getProviderAccountRouting(database, "codex", null);
    expect(routing.accounts[0]?.id).toBe(primary.id);
    expect(routing.retryAfterSeconds).toBe(0);
    expect(accountCooldowns.resetAt(primary)).toBe(0);
  });

  test("token rotation and label edits preserve cooldowns, but a refreshed identity clears them", async () => {
    const primary = await insert("codex", "one");
    accountCooldowns.mark(primary, Date.now() + 18_000_000);
    const tokens = {
      accessToken: "fake-rotated",
      refreshToken: "fake-rotated-refresh",
      expiresAt: Date.now() + 3_600_000,
      lastRefreshStatus: "success" as const,
      now: Date.now(),
    };
    await updateProviderAccountTokens(database, primary.id, tokens);
    await updateProviderAccountProfile(database, primary.id, {
      label: "Fake label",
      accountId: primary.accountId,
      metadata: null,
      now: Date.now(),
    });
    expect(accountCooldowns.resetAt(primary)).toBeGreaterThan(Date.now());
    await updateProviderAccountTokens(database, primary.id, {
      ...tokens,
      accountId: "refreshed-identity",
    });
    expect(accountCooldowns.resetAt(primary)).toBe(0);
  });

  test("re-enabling a provider clears its cooldowns but not another provider's", async () => {
    const primary = await insert("codex", "one");
    const claude = await insert("claude", "two");
    await setRateLimitFailoverEnabled(database, true);
    accountCooldowns.mark(primary, Date.now() + 18_000_000);
    accountCooldowns.mark(claude, Date.now() + 18_000_000);
    await setProviderAccountsEnabled(database, "codex", false, Date.now());
    await setProviderAccountsEnabled(database, "codex", true, Date.now());
    expect(accountCooldowns.resetAt(primary)).toBe(0);
    expect(accountCooldowns.resetAt(claude)).toBeGreaterThan(Date.now());
    expect(
      (await getProviderAccountRouting(database, "codex", null)).accounts[0]?.id
    ).toBe(primary.id);
  });

  test.each(["reset", "nothing_to_reset", "no_credit"])(
    "reset-credit result %s updates cooldown eligibility",
    async (code) => {
      const primary = await insert("codex", "one");
      await setRateLimitFailoverEnabled(database, true);
      accountCooldowns.mark(primary, Date.now() + 18_000_000);
      expect(
        (await getProviderAccountRouting(database, "codex", null))
          .retryAfterSeconds
      ).toBeGreaterThan(17_999);
      globalThis.fetch = (async (input: string | URL | Request) => {
        if (String(input).endsWith("/rate-limit-reset-credits/consume"))
          return Response.json({
            code,
            windows_reset: code === "reset" ? 1 : 0,
          });
        return Response.json({});
      }) as typeof fetch;
      expect(
        await redeemCodexResetCredit(database, primary.id, {})
      ).toMatchObject({ code });
      const routing = await getProviderAccountRouting(database, "codex", null);
      if (code === "no_credit")
        expect(routing.retryAfterSeconds).toBeGreaterThan(17_999);
      else {
        expect(routing.retryAfterSeconds).toBe(0);
        expect(routing.accounts[0]?.id).toBe(primary.id);
      }
    }
  );

  test("cancelling alternate refresh detaches the request while shared refresh finishes", async () => {
    const primary = await insert("codex", "one");
    const alternate = await insert("codex", "two");
    const expired = await updateProviderAccountTokens(database, alternate.id, {
      accessToken: alternate.accessToken,
      refreshToken: alternate.refreshToken,
      expiresAt: Date.now() - 1000,
      lastRefreshStatus: "success",
      now: Date.now(),
    });
    if (!expired) throw new Error("Missing alternate account");
    let release = () => {};
    let started = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let refreshCalls = 0;
    codexAdapter.refreshAccount = async (current, now) => {
      refreshCalls++;
      started();
      await held;
      return {
        accessToken: "fake-refreshed",
        refreshToken: "fake-new-refresh",
        expiresAt: now + 3_600_000,
        accountId: current.accountId,
        metadata: current.metadata,
      };
    };
    const controller = new AbortController();
    const reason = new Error("fake client disconnected");
    let attempts = 0;
    const request = sendWithRateLimitFailover({
      database,
      account: primary,
      remaining: [expired],
      enabled: true,
      signal: controller.signal,
      send: async () => {
        attempts++;
        return {
          response: Response.json(
            { error: { code: "usage_limit_reached" } },
            { status: 429 }
          ),
        };
      },
      onResponse: async () => {},
    });
    const outcome = request.then(
      () => null,
      (error: unknown) => error
    );
    await entered;
    const shared = refreshProviderAccount(database, alternate.id, Date.now());
    try {
      controller.abort(reason);
      expect(
        await Promise.race([
          outcome,
          Bun.sleep(250).then(() => "still waiting"),
        ])
      ).toBe(reason);
      expect(attempts).toBe(1);
      expect(refreshCalls).toBe(1);
    } finally {
      release();
      expect((await shared)?.accessToken).toBe("fake-refreshed");
      await outcome;
    }
  });
});
