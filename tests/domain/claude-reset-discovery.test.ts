import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";

import type { Database } from "../../src/db";
import {
  findProviderAccountById,
  type ProviderAccountRecord,
} from "../../src/db/repositories/provider-accounts";
import { providerAccounts } from "../../src/db/schema";
import { describeClaudeResets } from "../../src/domain/providers/reset-spends";
import {
  listProviderAccountQuotas,
  recordProviderAccountLiveLimits,
  setAccountSnapshotStore,
} from "../../src/domain/providers/provider-account-tracking";
import { readClaudeLiveLimits } from "../../src/providers/account-tracking/live-limits";
import { createResetDatabase } from "../helpers/reset-database";

const MINUTE = 60_000;
const ORGANIZATION = "00000000-0000-4000-8000-000000000001";

const grant = (overrides: Record<string, unknown> = {}) => ({
  id: "grant_fake_1",
  label: "Fake saved reset",
  resets_left: 2,
  starts_at: "2020-01-01T00:00:00Z",
  ends_at: "2100-01-01T00:00:00Z",
  clears: ["five_hour", "seven_day", "seven_day_overage_included"],
  paused: false,
  usable_now: true,
  use_requires_limit: false,
  blocking: [],
  ...overrides,
});

const cedar = (grants: unknown[] = [grant()]) => ({
  eligible: true,
  ineligible_reason: null,
  grants,
  next_grant_id: (grants[0] as { id?: string } | undefined)?.id ?? null,
  weekly_resets_at: "2026-10-19T19:00:00+00:00",
  cooldown_until: null,
  event_props: { surface: "claude_code_cli", tier: "claude_max_5x" },
});

const usageBody = (block: unknown, fiveHour = 40) => ({
  five_hour: {
    utilization: fiveHour,
    resets_at: new Date(Date.now() + 5 * 60 * MINUTE).toISOString(),
  },
  seven_day: {
    utilization: 20,
    resets_at: new Date(Date.now() + 7 * 24 * 60 * MINUTE).toISOString(),
  },
  extra_usage: { is_enabled: true, monthly_limit: 5000 },
  limits: [],
  cedar_ember: block,
});

const upstream = {
  usage: (): Response => Response.json(usageBody(cedar())),
  usageUrls: [] as string[],
};

const originalFetch = globalThis.fetch;

const mockAnthropic = ((input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname !== "api.anthropic.com") {
    throw new Error(`Unexpected request to ${url.hostname}`);
  }
  if (url.pathname === "/api/oauth/usage") {
    upstream.usageUrls.push(url.toString());
    return Promise.resolve(upstream.usage());
  }
  if (
    url.pathname === "/api/oauth/profile" ||
    url.pathname === "/api/oauth/claude_cli/roles"
  ) {
    return Promise.resolve(Response.json({}));
  }
  throw new Error(`Unexpected Anthropic request to ${url.pathname}`);
}) as unknown as typeof fetch;

const flush = async () => {
  for (let index = 0; index < 5; index++) {
    await Bun.sleep(0);
  }
};

const live = (
  account: ProviderAccountRecord,
  headers: Record<string, string>
) =>
  recordProviderAccountLiveLimits(
    account,
    readClaudeLiveLimits(new Headers(headers))
  );

describe("Claude saved resets", () => {
  let fixture: Awaited<ReturnType<typeof createResetDatabase>>;
  let database: Database;
  let startedAt: number;
  let warnings: ReturnType<typeof spyOn>;

  const at = (offsetMs: number) =>
    setSystemTime(new Date(startedAt + offsetMs));

  const addAccount = async (): Promise<ProviderAccountRecord> => {
    const now = Date.now();
    const id = crypto.randomUUID();
    await database.insert(providerAccounts).values({
      id,
      provider: "claude",
      accessToken: `access-${id}`,
      refreshToken: "refresh",
      expiresAt: now + 24 * 60 * MINUTE,
      metadataJson: JSON.stringify({
        provider: "claude",
        oauthMode: "max",
        oauthHost: "claude.ai",
        organizationUuid: ORGANIZATION,
      }),
      createdAt: now,
      updatedAt: now,
    });
    const account = await findProviderAccountById(database, id);
    if (!account) throw new Error("account missing");
    return account;
  };

  // Reads usage (and resets) the way the admin does, letting background
  // refreshes it starts finish.
  const read = async (account: ProviderAccountRecord) => {
    const quotas = await listProviderAccountQuotas(database, [account]);
    await flush();
    return quotas.get(account.id);
  };

  const view = describeClaudeResets;

  // Clears the shared Claude 429 pause for later tests.
  const clearRateLimitPause = async (account: ProviderAccountRecord) => {
    upstream.usage = () => Response.json(usageBody(cedar()));
    at(30 * MINUTE);
    await read(account);
    expect((await read(account))?.data).toMatchObject({
      resetCredits: { observedAt: startedAt + 30 * MINUTE },
    });
  };

  beforeEach(async () => {
    fixture = await createResetDatabase();
    database = fixture.database;
    setAccountSnapshotStore(null);
    startedAt = Date.now();
    at(0);
    upstream.usage = () => Response.json(usageBody(cedar()));
    upstream.usageUrls = [];
    globalThis.fetch = mockAnthropic;
    warnings = spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await flush();
    warnings.mockRestore();
    globalThis.fetch = originalFetch;
    setSystemTime();
    await fixture.close();
  });

  describe("discovery", () => {
    test("reads resets with the usual usage poll, keeping spend data and no event props", async () => {
      const account = await addAccount();
      const data = (await read(account))?.data;

      expect(data).toMatchObject({
        subscription: { extraUsage: { isEnabled: true, monthlyLimit: 5000 } },
        resetCredits: { observedAt: startedAt, status: { eligible: true } },
      });
      for (const secret of [
        "event_props",
        "claude_code_cli",
        ORGANIZATION,
        account.accessToken,
      ])
        expect(JSON.stringify(data)).not.toContain(secret);
      expect(view(account)).toMatchObject({
        saved: 2,
        unavailable: null,
        offer: {
          grantId: "grant_fake_1",
          earlyUse: { limit: "five_hour", percentUsed: 40 },
        },
      });
    });

    test("traffic refreshes limits but not resets, which stay due at the normal pace", async () => {
      const account = await addAccount();
      upstream.usage = () =>
        Response.json(usageBody(cedar([grant({ clears: ["mystery"] })])));
      await read(account);
      expect(view(account)?.unavailable).toBe("unsupported_limits");
      upstream.usage = () => Response.json(usageBody(cedar()));
      for (let minute = 1; minute <= 4; minute++) {
        at(minute * MINUTE);
        live(account, { "anthropic-ratelimit-unified-5h-utilization": "0.4" });
        const quota = await read(account);
        if (minute === 1)
          expect(quota).toMatchObject({
            fetchedAt: startedAt + MINUTE,
            data: { resetCredits: { observedAt: startedAt } },
          });
        if (minute < 3) expect(upstream.usageUrls).toHaveLength(1);
      }
      expect(upstream.usageUrls).toHaveLength(2);
      expect(view(account)?.offer).not.toBeNull();

      // A read without the block was not evaluated for resets.
      upstream.usage = () => Response.json(usageBody(null));
      at(7 * MINUTE);
      await read(account);
      expect(await read(account)).toMatchObject({
        fetchedAt: startedAt + 7 * MINUTE,
        data: { resetCredits: { observedAt: startedAt + 3 * MINUTE } },
      });
    });

    test("saved resets that end together count together", async () => {
      const account = await addAccount();
      upstream.usage = () =>
        Response.json(
          usageBody(
            cedar([
              grant({ id: "grant_fake_1", resets_left: 1 }),
              grant({
                id: "grant_fake_2",
                resets_left: 2,
                ends_at: "2100-01-01T00:00:00.000Z",
              }),
            ])
          )
        );
      await read(account);
      expect(view(account)?.expiries).toEqual([
        { endsAt: "2100-01-01T00:00:00Z", count: 3 },
      ]);
    });

    test("respects the shared 429 pause and retry pace under traffic", async () => {
      const account = await addAccount();
      await read(account);
      upstream.usage = () => Response.json({}, { status: 429 });
      for (let minute = 1; minute <= 4; minute++) {
        at(minute * MINUTE);
        live(account, { "anthropic-ratelimit-unified-5h-utilization": "0.4" });
        await read(account);
      }
      expect(upstream.usageUrls).toHaveLength(2);
      await clearRateLimitPause(account);
    });
  });
});
