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
import { providerAccounts, resetSpends } from "../../src/db/schema";
import {
  expireProviderAccountTracking,
  getCachedProviderAccountQuota,
  listProviderAccountQuotas,
  recordProviderAccountLiveLimits,
  setAccountSnapshotStore,
} from "../../src/domain/providers/provider-account-tracking";
import { readCodexLiveLimits } from "../../src/providers/account-tracking/live-limits";
import {
  claimClaudeReset,
  redeemCodexResetCredit,
  ResetSpendConflict,
  ResetSpendError,
} from "../../src/domain/providers/reset-spends";
import { createResetDatabase } from "../helpers/reset-database";

const MINUTE = 60_000;
const IN_PROGRESS = "A reset is already in progress for this account.";
const WAITING =
  "Waiting for the next limits check before another reset can be used.";

const providers = {
  codex: {
    items: ["credit_fake_a", "credit_fake_b"],
    metadata: { provider: "codex", chatgptAccountId: null, email: null },
    spend: redeemCodexResetCredit,
    usagePath: "/backend-api/wham/usage",
    discovery: (path: string, items: readonly string[]) =>
      path.endsWith("/rate-limit-reset-credits")
        ? {
            available_count: items.length,
            credits: items.map((id) => ({ id, status: "available" })),
          }
        : {},
    itemOf: (body: Record<string, string>) => body.credit_id,
    spent: { code: "reset", windows_reset: 2 },
    unchanged: { code: "nothing_to_reset", windows_reset: 0 },
  },
  claude: {
    items: ["grant_fake_a", "grant_fake_b"],
    metadata: {
      provider: "claude",
      oauthMode: "max",
      oauthHost: "claude.ai",
      organizationUuid: "00000000-0000-4000-8000-000000000001",
    },
    spend: claimClaudeReset,
    usagePath: "/api/oauth/usage",
    discovery: (path: string, items: readonly string[]) =>
      path === "/api/oauth/usage"
        ? {
            five_hour: { utilization: 100, resets_at: null },
            cedar_ember: {
              eligible: true,
              next_grant_id: items[0] ?? null,
              grants: items.map((id) => ({
                id,
                resets_left: 1,
                clears: ["five_hour"],
                usable_now: true,
                use_requires_limit: false,
                blocking: [],
              })),
            },
          }
        : {},
    itemOf: (body: Record<string, string>) => body.grant_id,
    spent: { result: "reset", resets_left: 1, cleared: ["five_hour"] },
    unchanged: { result: "not_limited", resets_left: 1, cleared: [] },
  },
} as const;

type Provider = keyof typeof providers;
type Sent = { requestId: string; item: string | undefined };

const originalFetch = globalThis.fetch;

describe.each(Object.keys(providers) as Provider[])(
  "%s reset spends",
  (name) => {
    const provider = providers[name];
    let fixture: Awaited<ReturnType<typeof createResetDatabase>>;
    let database: Database;
    let startedAt: number;
    let clock: number;
    let available: string[];
    let sent: Sent[];
    let answer: () => Response | Promise<Response>;
    let warnings: ReturnType<typeof spyOn>;
    let timerSpy: ReturnType<typeof spyOn>;
    let timers: { due: number; run: () => void }[];
    let usageReads: number;
    let usage: () => Response | Promise<Response>;

    const at = (offsetMs: number) => {
      clock = offsetMs;
      setSystemTime(new Date(startedAt + offsetMs));
    };

    const settleBackground = async () => {
      for (let index = 0; index < 5; index++) await Bun.sleep(0);
    };

    // Moves the clock on, running the timers that came due.
    const advance = async (ms: number) => {
      at(clock + ms);
      const due = timers.filter((timer) => timer.due <= Date.now());
      timers = timers.filter((timer) => !due.includes(timer));
      for (const timer of due) timer.run();
      await settleBackground();
    };

    // A scheduled limits check, a second after whatever happened last.
    const poll = async (account: ProviderAccountRecord) => {
      at(clock + 1000);
      expireProviderAccountTracking(account.id);
      await listProviderAccountQuotas(database, [account]);
      await settleBackground();
    };

    const addAccount = async () => {
      const id = crypto.randomUUID();
      const now = Date.now();
      await database.insert(providerAccounts).values({
        id,
        provider: name,
        accessToken: `fake-access-${id}`,
        refreshToken: "fake-refresh",
        expiresAt: now + 24 * 60 * MINUTE,
        metadataJson: JSON.stringify(provider.metadata),
        createdAt: now,
        updatedAt: now,
      });
      const account = await findProviderAccountById(database, id);
      if (!account) throw new Error("account missing");
      await poll(account);
      return account;
    };

    const spend = (
      account: ProviderAccountRecord,
      item = available[0] ?? "",
      client = database
    ) => provider.spend(client, account.id, item);

    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => {
          throw new Error("expected the spend to fail");
        },
        (error: unknown) => error as Error
      );

    beforeEach(async () => {
      fixture = await createResetDatabase();
      database = fixture.database;
      setAccountSnapshotStore(null);
      startedAt = Date.now();
      at(0);
      available = [...provider.items];
      sent = [];
      answer = () => Response.json(provider.spent);
      usageReads = 0;
      usage = () =>
        Response.json(provider.discovery(provider.usagePath, available));
      timers = [];
      timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
        run: () => void,
        delay = 0
      ) => {
        timers.push({ due: Date.now() + delay, run });
        return { unref: () => undefined };
      }) as unknown as typeof setTimeout);
      globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit
      ) => {
        const path = new URL(String(input)).pathname;
        if (
          !(
            path.endsWith("/rate-limit-reset-credits/consume") ||
            path.endsWith("/reset_rate_limits")
          )
        ) {
          if (path !== provider.usagePath)
            return Response.json(provider.discovery(path, available));
          usageReads++;
          return usage();
        }
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        sent.push({
          requestId: body.redeem_request_id ?? body.request_id ?? "",
          item: provider.itemOf(body),
        });
        return answer();
      }) as typeof fetch;
      warnings = spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(async () => {
      await settleBackground();
      timerSpy.mockRestore();
      warnings.mockRestore();
      globalThis.fetch = originalFetch;
      setSystemTime();
      await fixture.close();
    });

    test("two spends at once from two processes send one request", async () => {
      const account = await addAccount();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached: () => void = () => undefined;
      const sending = new Promise<void>((resolve) => {
        reached = resolve;
      });
      answer = async () => {
        reached();
        await held;
        return Response.json(provider.spent);
      };
      const first = spend(account);
      await sending;
      const second = await failure(
        spend(account, undefined, fixture.contender)
      );
      release();
      await first;
      expect(second).toBeInstanceOf(ResetSpendConflict);
      expect(second.message).toBe(IN_PROGRESS);
      expect(sent).toHaveLength(1);
    });

    test.each([409, 503])(
      "a %i answer keeps the account blocked until it expires, even after a newer limits check",
      async (status) => {
        const account = await addAccount();
        answer = () => Response.json({}, { status });
        expect(await failure(spend(account))).toBeInstanceOf(ResetSpendError);
        await poll(account);
        expect((await failure(spend(account))).message).toBe(IN_PROGRESS);
        expect(sent).toHaveLength(1);
      }
    );

    test("a spend another process settled after this process's last limits check blocks a spend, even if it started before", async () => {
      const account = await addAccount();
      await database.insert(resetSpends).values({
        requestId: "other-process-request",
        provider: name,
        providerAccountId: account.id,
        itemId: provider.items[0],
        status: "completed",
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() + 1000,
      });
      expect((await failure(spend(account))).message).toBe(WAITING);
      expect(sent).toHaveLength(0);
    });

    test("after a lost response, the next pick is sent with a new request ID", async () => {
      const account = await addAccount();
      answer = () => {
        available = available.slice(1);
        return Response.json({}, { status: 503 });
      };
      expect(await failure(spend(account))).toBeInstanceOf(ResetSpendError);
      answer = () => Response.json(provider.spent);
      at(4 * MINUTE);
      await poll(account);
      await spend(account, provider.items[1]);
      expect(sent).toHaveLength(2);
      expect(sent[1]?.requestId).not.toBe(sent[0]?.requestId);
      expect(sent[1]?.item).toBe(provider.items[1]);
    });

    test.skipIf(name === "codex").each([
      ["completed", () => Response.json(provider.spent)],
      ["refused", () => Response.json({}, { status: 422 })],
    ])(
      "after a %s spend, the next one waits for a newer limits check",
      async (_kind, respond) => {
        const account = await addAccount();
        answer = respond;
        await spend(account).catch(() => undefined);
        answer = () => Response.json(provider.spent);
        expect((await failure(spend(account))).message).toBe(WAITING);
        expect(sent).toHaveLength(1);
        await poll(account);
        await spend(account);
        expect(sent).toHaveLength(2);
        expect(sent[1]?.requestId).not.toBe(sent[0]?.requestId);
      }
    );

    test.skipIf(name !== "codex")(
      "under steady traffic, a remaining credit can be spent right after a spend",
      async () => {
        const account = await addAccount();
        answer = () => {
          available = available.slice(1);
          return Response.json(provider.spent);
        };
        await spend(account);
        for (let index = 0; index < 3; index++) {
          at(clock + 30_000);
          recordProviderAccountLiveLimits(
            account,
            readCodexLiveLimits(
              new Headers({
                "x-codex-primary-used-percent": "50",
                "x-codex-primary-window-minutes": "300",
              })
            )
          );
          await listProviderAccountQuotas(database, [account]);
          await settleBackground();
        }
        await spend(account, provider.items[1]);
        expect(sent.map((call) => call.item)).toEqual([...provider.items]);
      }
    );

    test("a pending spend left by another process expires", async () => {
      const account = await addAccount();
      await database.insert(resetSpends).values({
        requestId: "other-process-request",
        provider: name,
        providerAccountId: account.id,
        itemId: provider.items[0],
        status: "pending",
        createdAt: startedAt,
        updatedAt: startedAt,
      });
      expect((await failure(spend(account))).message).toBe(IN_PROGRESS);
      at(4 * MINUTE);
      await poll(account);
      await spend(account);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.requestId).not.toBe("other-process-request");
    });

    test("a reset is confirmed by one more limits read a few seconds later", async () => {
      const account = await addAccount();
      const before = usageReads;
      await spend(account);
      const immediate = usageReads - before;
      await advance(3000);
      expect(usageReads - before).toBe(immediate);
      await advance(3000);
      expect(usageReads - before).toBe(immediate + 1);
      await advance(10 * MINUTE);
      expect(usageReads - before).toBe(immediate + 1);
    });

    test.each([
      ["refused", () => Response.json({}, { status: 422 })],
      ["unanswered", () => Response.json({}, { status: 503 })],
    ])("a %s spend gets no confirming read", async (_kind, respond) => {
      const account = await addAccount();
      answer = respond;
      await spend(account).catch(() => undefined);
      const after = usageReads;
      await advance(10 * MINUTE);
      expect(usageReads).toBe(after);
    });

    test("an answer that nothing needed a reset reads nothing and keeps the shown limits and resets", async () => {
      const account = await addAccount();
      const shown = getCachedProviderAccountQuota(account)?.data;
      const before = usageReads;
      answer = () => Response.json(provider.unchanged);
      await spend(account);
      await advance(10 * MINUTE);
      expect(usageReads).toBe(before);
      expect(getCachedProviderAccountQuota(account)?.data).toEqual(shown);
    });

    test.skipIf(name !== "claude").each([
      [
        "during the shared 429 pause",
        async (account: ProviderAccountRecord) => {
          usage = () => Response.json({}, { status: 429 });
          await advance(4 * MINUTE);
          await listProviderAccountQuotas(database, [account]);
          await settleBackground();
        },
        async () => undefined,
      ],
      [
        "when a poll ran since",
        async () => undefined,
        (account: ProviderAccountRecord) => poll(account),
      ],
      [
        "while an earlier poll is still running",
        async (account: ProviderAccountRecord) => {
          usage = () => new Promise<Response>(() => undefined);
          await advance(4 * MINUTE);
          await listProviderAccountQuotas(database, [account]);
        },
        async () => undefined,
      ],
    ])(
      "the confirming read is skipped %s",
      async (_kind, beforeClaim, afterClaim) => {
        const account = await addAccount();
        await beforeClaim(account);
        await spend(account);
        await afterClaim(account);
        const after = usageReads;
        await advance(6000);
        expect(usageReads).toBe(after);
        // Ends any 429 pause for later tests.
        usage = () =>
          Response.json(provider.discovery(provider.usagePath, available));
        at(clock + 30 * MINUTE);
        await poll(account);
      }
    );

    test("a pick missing from the latest discovery data sends nothing", async () => {
      const account = await addAccount();
      const stale = await failure(spend(account, "fake_spent_elsewhere"));
      expect(stale).toBeInstanceOf(ResetSpendConflict);
      expect(sent).toHaveLength(0);
    });
  }
);
