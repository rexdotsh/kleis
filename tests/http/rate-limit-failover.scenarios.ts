import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { Hono } from "hono";
import { migrate } from "drizzle-orm/libsql/migrator";
import { installErrorHandler } from "../../src/http/error-handler";

if (
  process.env.TURSO_CONNECTION_URL !== ":memory:" ||
  process.env.TURSO_AUTH_TOKEN
)
  throw new Error(
    "Failover scenarios require an unauthenticated in-memory database"
  );
const { db } = await import("../../src/db");
const {
  upsertProviderAccount,
  listProviderAccounts,
  deleteProviderAccount,
  updateProviderAccountProfile,
  updateProviderAccountTokens,
  setProviderAccountsEnabled,
  replaceProviderAccountCredentials,
} = await import("../../src/db/repositories/provider-accounts");
const { setRateLimitFailoverEnabled } =
  await import("../../src/db/repositories/proxy-settings");
const { invalidateLookupCaches } = await import("../../src/db/lookup-cache");
const { requestUsageBuckets, proxySettings } =
  await import("../../src/db/schema");
const { proxyRoutes, flushProxyUsage, flushProxyFailureLogs } =
  await import("../../src/http/routes/proxy");
const { adminAccountsRoutes } =
  await import("../../src/http/routes/admin-accounts");
const { recordProviderAccountLiveLimits, listProviderAccountQuotas } =
  await import("../../src/domain/providers/provider-account-tracking");
const { redeemCodexResetCredit, claimClaudeReset } =
  await import("../../src/domain/providers/reset-spends");
type Provider = "claude" | "codex";
type Account = Awaited<ReturnType<typeof upsertProviderAccount>>;
let pins: string[] | null = null;
const app = new Hono();
installErrorHandler(app);
app.route("/admin/accounts", adminAccountsRoutes);
app.use("*", async (context, next) => {
  context.set("proxyApiKeyId", "fake-key");
  context.set("proxyApiKeyAccountScopeIds", pins);
  const text = await context.req.text();
  context.set("proxyRequestBody", {
    text,
    parsed: JSON.parse(text) as unknown,
    model: "fake-model",
  });
  await next();
});
app.route("/", proxyRoutes);
beforeAll(() => migrate(db, { migrationsFolder: "./drizzle/migrations" }));
const originalFetch = globalThis.fetch;
let warn: ReturnType<typeof spyOn>;
let info: ReturnType<typeof spyOn>;
beforeEach(async () => {
  await flushProxyUsage();
  await flushProxyFailureLogs();
  await db.delete(requestUsageBuckets);
  for (const account of (await listProviderAccounts(db)).sort(
    (a, b) => Number(a.isPrimary) - Number(b.isPrimary)
  ))
    await deleteProviderAccount(db, account.id);
  await setRateLimitFailoverEnabled(db, true);
  pins = null;
  warn = spyOn(console, "warn").mockImplementation(() => undefined);
  info = spyOn(console, "info").mockImplementation(() => undefined);
  globalThis.fetch = (() => {
    throw new Error("Unexpected network request");
  }) as typeof fetch;
});
afterEach(async () => {
  await flushProxyFailureLogs();
  globalThis.fetch = originalFetch;
  warn.mockRestore();
  info.mockRestore();
});
const setup = async (provider: Provider) => {
  const accounts: Account[] = [];
  for (const [index, name] of ["primary", "second", "third"].entries()) {
    accounts.push(
      await upsertProviderAccount(db, {
        provider,
        accountId: `fake-${name}`,
        label: `Fake ${name}`,
        accessToken: `fake-${name}`,
        refreshToken: `fake-refresh-${name}`,
        expiresAt: Date.now() + 3_600_000,
        metadata:
          provider === "claude"
            ? {
                provider: "claude",
                oauthMode: "max",
                oauthHost: "claude.ai",
                organizationUuid: "00000000-0000-4000-8000-000000000001",
              }
            : null,
        now: Date.now() - index * 1000,
      })
    );
  }
  return accounts as [Account, Account, Account];
};
const request = (provider: Provider, signal?: AbortSignal) =>
  app.request(
    provider === "claude" ? "/anthropic/v1/messages" : "/openai/v1/responses",
    {
      method: "POST",
      signal,
      body: JSON.stringify({
        model: "fake-model",
        stream: true,
        messages: [{ role: "user", content: "fake prompt" }],
      }),
    }
  );
const limited = (
  provider: Provider,
  resetsAt = Math.floor(Date.now() / 1000) * 1000 + 120_000
) =>
  Response.json(
    {
      error: {
        type:
          provider === "claude" ? "rate_limit_error" : "usage_limit_reached",
        resets_at: resetsAt / 1000,
      },
    },
    {
      status: 429,
      headers: {
        "retry-after": "18000",
        "retry-after-ms": "18000000",
        ...(provider === "claude"
          ? {
              "anthropic-ratelimit-unified-status": "rejected",
              "anthropic-ratelimit-unified-representative-claim": "five_hour",
              "anthropic-ratelimit-unified-5h-reset": String(resetsAt / 1000),
            }
          : {
              "x-codex-primary-used-percent": "100",
              "x-codex-primary-reset-at": String(resetsAt / 1000),
            }),
      },
    }
  );
const success = (provider: Provider) =>
  new Response(
    provider === "codex"
      ? 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"fake-response","status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n'
      : 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    { headers: { "content-type": "text/event-stream" } }
  );
const mockAttempts = (
  send: (token: string, init: RequestInit) => Response | Promise<Response>
) => {
  const calls: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const token = new Headers(init.headers).get("authorization") ?? "";
    calls.push(token);
    return send(token, init);
  }) as typeof fetch;
  return calls;
};
const buckets = async () => {
  await flushProxyUsage();
  return db.select().from(requestUsageBuckets);
};

describe.each(["claude", "codex"] as const)("%s failover", (provider) => {
  test("replays the buffered request and counts tokens only on the serving account", async () => {
    const [, second] = await setup(provider);
    const bodies: unknown[] = [];
    const calls = mockAttempts((token, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return token === "Bearer fake-primary"
        ? limited(provider)
        : success(provider);
    });
    const response = await request(provider);
    expect(response.status).toBe(200);
    await response.text();
    expect(calls).toEqual(["Bearer fake-primary", "Bearer fake-second"]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(await buckets()).toMatchObject([
      {
        providerAccountId: second.id,
        requestCount: 1,
        successCount: 1,
        rateLimitCount: 0,
        inputTokens: 3,
        outputTokens: 2,
      },
    ]);
  });

  test("last upstream rejection and all-cooling responses expose the account/reset without retry hints", async () => {
    await setup(provider);
    const reset = Math.floor(Date.now() / 1000) * 1000 + 120_000;
    const calls = mockAttempts(() => limited(provider, reset));
    for (const label of ["Fake third", "Fake primary"]) {
      const response = await request(provider);
      expect(response.status).toBe(429);
      expect(response.headers.has("retry-after")).toBe(false);
      expect(response.headers.has("retry-after-ms")).toBe(false);
      expect(await response.json()).toMatchObject({
        error: { account: label, resets_at: new Date(reset).toISOString() },
      });
      expect(calls).toHaveLength(3);
    }
  });

  test("network failure on the alternate is attributed to that attempt, without another replay", async () => {
    const [, second] = await setup(provider);
    const calls = mockAttempts((token) => {
      if (token === "Bearer fake-primary") return limited(provider);
      throw new Error("Fake connection failure");
    });
    expect((await request(provider)).status).toBe(500);
    expect(calls).toEqual(["Bearer fake-primary", "Bearer fake-second"]);
    expect(await buckets()).toMatchObject([
      { providerAccountId: second.id, requestCount: 1 },
    ]);
  });

  test.each(["default", "disabled"])(
    "%s setting never retries",
    async (setting) => {
      await setup(provider);
      if (setting === "default") {
        await db.delete(proxySettings);
        invalidateLookupCaches();
      } else await setRateLimitFailoverEnabled(db, false);
      const calls = mockAttempts(() => limited(provider));
      await (await request(provider)).text();
      await (await request(provider)).text();
      expect(calls).toEqual(["Bearer fake-primary", "Bearer fake-primary"]);
    }
  );

  test.each([1, 2])(
    "%i account pins are a hard failover boundary",
    async (count) => {
      const [primary, second] = await setup(provider);
      await setup(provider === "claude" ? "codex" : "claude");
      pins = [primary.id, second.id].slice(0, count);
      const calls = mockAttempts(() => limited(provider));
      expect((await request(provider)).status).toBe(429);
      expect(calls).toEqual(
        ["Bearer fake-primary", "Bearer fake-second"].slice(0, count)
      );
    }
  );

  test("exclusion blocks fallback, not explicit preferred traffic", async () => {
    const [primary, second] = await setup(provider);
    for (const account of [primary, second])
      await updateProviderAccountProfile(db, account.id, {
        label: account.label,
        accountId: account.accountId,
        metadata: account.metadata,
        excludeFromFailover: true,
        now: Date.now(),
      });
    const calls = mockAttempts((token) =>
      token === "Bearer fake-primary" ? limited(provider) : success(provider)
    );
    await (await request(provider)).text();
    expect(calls).toEqual(["Bearer fake-primary", "Bearer fake-third"]);
  });

  test("disabled provider accounts are never fallback candidates", async () => {
    await setup(provider);
    const other = provider === "claude" ? "codex" : "claude";
    await setup(other);
    await setProviderAccountsEnabled(db, provider, false, Date.now());
    const calls = mockAttempts(() => success(provider));
    expect((await request(provider)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("preferred account resumes after its cooldown expires", async () => {
    await setup(provider);
    const calls = mockAttempts((token) =>
      token === "Bearer fake-primary" ? limited(provider) : success(provider)
    );
    await (await request(provider)).text();
    await (await request(provider)).text();
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
    try {
      await (await request(provider)).text();
    } finally {
      clock.mockRestore();
    }
    expect(calls).toEqual([
      "Bearer fake-primary",
      "Bearer fake-second",
      "Bearer fake-second",
      "Bearer fake-primary",
      "Bearer fake-second",
    ]);
  });

  test("live-limit recovery makes the preferred account routable again", async () => {
    const [primary] = await setup(provider);
    const calls = mockAttempts((token) =>
      token === "Bearer fake-primary" ? limited(provider) : success(provider)
    );
    await (await request(provider)).text();
    recordProviderAccountLiveLimits(
      primary,
      provider === "claude"
        ? { provider, windows: { five_hour: { utilization: 10 } } }
        : {
            provider,
            primaryWindow: {
              usedPercent: 10,
              windowSeconds: null,
              resetAt: null,
            },
            secondaryWindow: null,
            credits: null,
            planType: null,
          }
    );
    await (await request(provider)).text();
    expect(
      calls.filter((token) => token === "Bearer fake-primary")
    ).toHaveLength(2);
  });

  test.each([403, 500, 429])(
    "unrelated HTTP %i never fails over",
    async (status) => {
      await setup(provider);
      const body = {
        error: {
          type:
            provider === "claude" ? "rate_limit_error" : "rate_limit_exceeded",
        },
      };
      const calls = mockAttempts(() =>
        Response.json(body, { status, headers: { "retry-after": "60" } })
      );
      const response = await request(provider);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
      expect(calls).toHaveLength(1);
    }
  );

  test("auth replay on an alternate composes with failover", async () => {
    const [, second] = await setup(provider);
    const calls = mockAttempts(async (token) => {
      if (token === "Bearer fake-primary") return limited(provider);
      if (token === "Bearer fake-second") {
        await updateProviderAccountTokens(db, second.id, {
          accessToken: "fake-refreshed",
          refreshToken: second.refreshToken,
          expiresAt: second.expiresAt,
          lastRefreshStatus: "success",
          now: Date.now(),
        });
        return Response.json(
          { error: { type: "authentication_error" } },
          { status: 401 }
        );
      }
      return success(provider);
    });
    await (await request(provider)).text();
    expect(calls).toEqual([
      "Bearer fake-primary",
      "Bearer fake-second",
      "Bearer fake-refreshed",
    ]);
    expect(await buckets()).toMatchObject([
      { providerAccountId: second.id, requestCount: 1, successCount: 1 },
    ]);
  });

  test("stream errors after the first output never replay", async () => {
    await setup(provider);
    let finish = () => {};
    const calls = mockAttempts(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  provider === "claude"
                    ? 'event: message_start\ndata: {"type":"message_start","message":{}}\n\n'
                    : 'event: response.created\ndata: {"type":"response.created","response":{"id":"fake"}}\n\n'
                )
              );
              finish = () => {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","code":"usage_limit_reached"}}\n\n'
                  )
                );
                controller.close();
              };
            },
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
    );
    const response = await request(provider);
    if (!response.body) throw new Error("Expected a streaming response");
    const reader = response.body.getReader();
    expect((await reader.read()).value?.length).toBeGreaterThan(0);
    finish();
    while (!(await reader.read()).done) {
      /* Drain the relay. */
    }
    expect(calls).toHaveLength(1);
    expect(await buckets()).toMatchObject([
      { requestCount: 1, rateLimitCount: 1 },
    ]);
  });

  test("successful reset spend clears the cooldown", async () => {
    const [primary] = await setup(provider);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input)).pathname;
      if (url.endsWith("/rate-limit-reset-credits"))
        return Response.json({
          available_count: 1,
          credits: [{ id: "fake-credit", status: "available" }],
        });
      if (url.endsWith("/api/oauth/usage"))
        return Response.json({
          five_hour: { utilization: 100 },
          cedar_ember: {
            eligible: true,
            next_grant_id: "fake-grant",
            grants: [
              {
                id: "fake-grant",
                resets_left: 1,
                clears: ["five_hour"],
                usable_now: true,
                use_requires_limit: false,
                blocking: [],
              },
            ],
          },
        });
      if (url.endsWith("/rate-limit-reset-credits/consume"))
        return Response.json({ code: "reset", windows_reset: 1 });
      if (url.endsWith("/reset_rate_limits"))
        return Response.json({
          result: "reset",
          resets_left: 0,
          cleared: ["five_hour"],
        });
      return Response.json({});
    }) as typeof fetch;
    await listProviderAccountQuotas(db, [primary]);
    const spendFetch = globalThis.fetch;
    mockAttempts((token) =>
      token === "Bearer fake-primary" ? limited(provider) : success(provider)
    );
    await (await request(provider)).text();
    globalThis.fetch = spendFetch;
    if (provider === "codex")
      await redeemCodexResetCredit(db, primary.id, "fake-credit");
    else await claimClaudeReset(db, primary.id, "fake-grant");
    const calls = mockAttempts(() => success(provider));
    await (await request(provider)).text();
    expect(calls).toEqual(["Bearer fake-primary"]);
  });

  test("reauthorization clears the cooldown", async () => {
    const [primary] = await setup(provider);
    mockAttempts((token) =>
      token === "Bearer fake-primary" ? limited(provider) : success(provider)
    );
    await (await request(provider)).text();
    await replaceProviderAccountCredentials(db, primary.id, {
      provider,
      accountId: primary.accountId,
      accessToken: "fake-reconnected",
      refreshToken: primary.refreshToken,
      expiresAt: primary.expiresAt,
      metadata: primary.metadata,
      now: Date.now(),
    });
    const calls = mockAttempts(() => success(provider));
    await (await request(provider)).text();
    expect(calls).toEqual(["Bearer fake-reconnected"]);
  });
});

test("delayed Codex body-only usage-limit evidence is read once before retrying", async () => {
  await setup("codex");
  const calls = mockAttempts((token) =>
    token === "Bearer fake-primary"
      ? new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.enqueue(
                  new TextEncoder().encode(
                    '{"error":{"code":"usage_limit_reached"}}'
                  )
                );
                controller.close();
              }, 350);
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        )
      : success("codex")
  );
  const response = await request("codex");
  expect(response.status).toBe(200);
  await response.text();
  expect(calls).toEqual(["Bearer fake-primary", "Bearer fake-second"]);
});

test("oversized Codex rejection bodies never trigger replay", async () => {
  await setup("codex");
  const body = {
    error: { code: "usage_limit_reached", message: "x".repeat(9000) },
  };
  const calls = mockAttempts(() => Response.json(body, { status: 429 }));
  const response = await request("codex");
  expect(await response.json()).toEqual(body);
  expect(calls).toHaveLength(1);
});

test("client cancellation interrupts a stalled Codex rejection read without replaying", async () => {
  await setup("codex");
  const controller = new AbortController();
  let started = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const calls = mockAttempts(
    () =>
      new Response(
        new ReadableStream({
          start() {
            started();
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } }
      )
  );
  const pending = request("codex", controller.signal);
  await entered;
  const abortedAt = performance.now();
  controller.abort();
  const response = await pending;
  response.body?.cancel().catch(() => undefined);
  expect(performance.now() - abortedAt).toBeLessThan(1000);
  expect(calls).toHaveLength(1);
});

test("admin API validates and persists failover and account exclusion", async () => {
  const [primary] = await setup("claude");
  for (const [body, status] of [
    [{ enabled: false }, 200],
    [{ enabled: "true" }, 400],
  ] as const) {
    expect(
      (
        await app.request("/admin/accounts/failover", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status
    ).toBe(status);
  }
  expect(await (await app.request("/admin/accounts/failover")).json()).toEqual({
    enabled: false,
  });
  const response = await app.request(`/admin/accounts/${primary.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: '{"excludeFromFailover":true}',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    account: { excludeFromFailover: true },
  });
});
