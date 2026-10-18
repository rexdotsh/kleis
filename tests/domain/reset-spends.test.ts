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
import {
  claudeResetClaims,
  codexResetCreditRedemptions,
  providerAccounts,
} from "../../src/db/schema";
import {
  expireProviderAccountTracking,
  listProviderAccountQuotas,
  setAccountSnapshotStore,
} from "../../src/domain/providers/provider-account-tracking";
import {
  claimClaudeReset,
  redeemCodexResetCredit,
  ResetSpendConflict,
  ResetSpendError,
} from "../../src/domain/providers/reset-spends";
import { createResetDatabase } from "../helpers/reset-database";

const MINUTE = 60_000;
const ORGANIZATION = "00000000-0000-4000-8000-000000000001";

const providers = {
  codex: {
    resetId: "credit_fake_1",
    ledger: codexResetCreditRedemptions,
    metadata: { provider: "codex", chatgptAccountId: null, email: null },
    spend: redeemCodexResetCredit,
    discovery: (path: string) =>
      path.endsWith("/rate-limit-reset-credits")
        ? {
            available_count: 1,
            credits: [{ id: "credit_fake_1", status: "available" }],
          }
        : {},
    spent: { code: "reset", windows_reset: 2 },
    replayed: { code: "already_redeemed" },
  },
  claude: {
    resetId: "grant_fake_1",
    ledger: claudeResetClaims,
    metadata: {
      provider: "claude",
      oauthMode: "max",
      oauthHost: "claude.ai",
      organizationUuid: ORGANIZATION,
    },
    spend: claimClaudeReset,
    discovery: (path: string) =>
      path === "/api/oauth/usage"
        ? {
            five_hour: { utilization: 100, resets_at: null },
            cedar_ember: {
              eligible: true,
              next_grant_id: "grant_fake_1",
              grants: [
                {
                  id: "grant_fake_1",
                  resets_left: 1,
                  clears: ["five_hour"],
                  usable_now: true,
                  use_requires_limit: false,
                  blocking: [],
                },
              ],
            },
          }
        : {},
    spent: { result: "reset", resets_left: 0, cleared: ["five_hour"] },
    replayed: { result: "already_used" },
  },
} as const;

type Provider = keyof typeof providers;

const isSpend = (path: string) =>
  path.endsWith("/rate-limit-reset-credits/consume") ||
  path.endsWith("/reset_rate_limits");

const originalFetch = globalThis.fetch;

describe.each(Object.keys(providers) as Provider[])(
  "%s reset spends",
  (name) => {
    const provider = providers[name];
    let fixture: Awaited<ReturnType<typeof createResetDatabase>>;
    let database: Database;
    let startedAt: number;
    // Request IDs sent to the upstream, and those it acted on.
    let sent: string[];
    let spent: Set<string>;
    let answer: (requestId: string) => Response | Promise<Response>;
    let warnings: ReturnType<typeof spyOn>;

    const at = (offsetMs: number) =>
      setSystemTime(new Date(startedAt + offsetMs));

    const settleBackground = async () => {
      for (let index = 0; index < 5; index++) await Bun.sleep(0);
    };

    const poll = async (account: ProviderAccountRecord) => {
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

    const spend = (account: ProviderAccountRecord, client = database) =>
      provider.spend(client, account.id, provider.resetId);

    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => {
          throw new Error("expected the spend to fail");
        },
        (error: unknown) => error
      );

    beforeEach(async () => {
      fixture = await createResetDatabase();
      database = fixture.database;
      setAccountSnapshotStore(null);
      startedAt = Date.now();
      at(0);
      sent = [];
      spent = new Set();
      answer = (requestId) => {
        if (spent.has(requestId)) return Response.json(provider.replayed);
        spent.add(requestId);
        return Response.json(provider.spent);
      };
      globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit
      ) => {
        const path = new URL(String(input)).pathname;
        if (!isSpend(path)) return Response.json(provider.discovery(path));
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        const requestId = body.redeem_request_id ?? body.request_id ?? "";
        sent.push(requestId);
        return answer(requestId);
      }) as typeof fetch;
      warnings = spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(async () => {
      await settleBackground();
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
      const second = await failure(spend(account, fixture.contender));
      release();
      await first;
      expect(second).toBeInstanceOf(ResetSpendConflict);
      expect((second as Error).message).toBe(
        "A reset is already in progress for this account."
      );
      expect(sent).toHaveLength(1);
    });

    test("an unknown outcome blocks the account, then a retry resends the same request ID", async () => {
      const account = await addAccount();
      answer = (requestId) => {
        spent.add(requestId);
        return Response.json({}, { status: 503 });
      };
      expect(await failure(spend(account))).toBeInstanceOf(ResetSpendError);
      expect(await failure(spend(account))).toBeInstanceOf(ResetSpendConflict);

      answer = (requestId) =>
        Response.json(
          spent.has(requestId) ? provider.replayed : provider.spent
        );
      at(4 * MINUTE);
      await poll(account);
      await spend(account);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toBe(sent[0]);
      expect(spent.size).toBe(1);
    });

    test("a definitive refusal frees the account at once", async () => {
      const account = await addAccount();
      answer = () => Response.json({}, { status: 422 });
      expect(await failure(spend(account))).toBeInstanceOf(ResetSpendError);
      answer = () => Response.json(provider.spent);
      await poll(account);
      await spend(account);
      expect(sent).toHaveLength(2);
      expect(sent[1]).not.toBe(sent[0]);
    });

    test("a pending spend left by another process expires and its request ID is reused", async () => {
      const account = await addAccount();
      const row = {
        requestId: "other-process-request",
        providerAccountId: account.id,
        itemId: provider.resetId,
        status: "pending" as const,
        createdAt: startedAt,
        updatedAt: startedAt,
      };
      await database.insert(provider.ledger).values(row);
      expect(await failure(spend(account))).toBeInstanceOf(ResetSpendConflict);
      at(4 * MINUTE);
      await poll(account);
      await spend(account);
      expect(sent).toEqual(["other-process-request"]);
    });

    test("a pick missing from the latest discovery data sends nothing", async () => {
      const account = await addAccount();
      const stale = await failure(
        provider.spend(database, account.id, "fake_spent_elsewhere")
      );
      expect(stale).toBeInstanceOf(ResetSpendConflict);
      expect(sent).toHaveLength(0);
    });
  }
);
