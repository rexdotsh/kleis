import {
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { Hono } from "hono";
import { migrate } from "drizzle-orm/libsql/migrator";
import { installErrorHandler } from "../../src/http/error-handler";

if (process.env.TURSO_CONNECTION_URL !== ":memory:")
  throw new Error("Failover scenarios require an in-memory database");
const { db } = await import("../../src/db");
const {
  upsertProviderAccount,
  listProviderAccounts,
  deleteProviderAccount,
  updateProviderAccountProfile,
  updateProviderAccountTokens,
} = await import("../../src/db/repositories/provider-accounts");
const { setRateLimitFailoverEnabled } =
  await import("../../src/db/repositories/proxy-settings");
const { requestUsageBuckets } = await import("../../src/db/schema");
const { proxyRoutes, flushProxyUsage } =
  await import("../../src/http/routes/proxy");
const { adminAccountsRoutes } =
  await import("../../src/http/routes/admin-accounts");
const { accountCooldowns } =
  await import("../../src/providers/account-tracking/rate-limit-cooldowns");
type Account = Awaited<ReturnType<typeof upsertProviderAccount>>;
type Provider = "claude" | "codex";
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
  await db.delete(requestUsageBuckets);
  const previous = await listProviderAccounts(db);
  for (const account of previous.sort(
    (left, right) => Number(left.isPrimary) - Number(right.isPrimary)
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
afterEach(() => {
  globalThis.fetch = originalFetch;
  warn.mockRestore();
  info.mockRestore();
});
const setup = async (provider: Provider) => {
  const accounts: Account[] = [];
  for (const [index, name] of ["primary", "second", "third"].entries()) {
    const created = await upsertProviderAccount(db, {
      provider,
      accountId: `fake-${name}`,
      accessToken: `fake-${name}`,
      refreshToken: `fake-refresh-${name}`,
      expiresAt: Date.now() + 3_600_000,
      metadata: null,
      now: Date.now() - index * 1000,
    });
    await updateProviderAccountTokens(db, created.id, {
      accessToken: created.accessToken,
      refreshToken: created.refreshToken,
      expiresAt: created.expiresAt,
      lastRefreshStatus: "success",
      now: Date.now(),
    });
    accounts.push(created);
  }
  return accounts as [Account, Account, Account];
};
const path = (provider: Provider) =>
  provider === "claude" ? "/anthropic/v1/messages" : "/openai/v1/responses";
const request = (provider: Provider) =>
  app.request(path(provider), {
    method: "POST",
    body: JSON.stringify({
      model: "fake-model",
      stream: true,
      messages: [{ role: "user", content: "fake prompt" }],
    }),
  });
const limited = (provider: Provider, marker = "limited") =>
  Response.json(
    {
      error: {
        type:
          provider === "claude" ? "rate_limit_error" : "usage_limit_reached",
        message: marker,
      },
    },
    {
      status: 429,
      headers: {
        "retry-after": "90",
        "x-fake-attempt": marker,
        ...(provider === "claude"
          ? { "anthropic-ratelimit-unified-status": "rejected" }
          : {}),
      },
    }
  );
const success = () =>
  Response.json({
    id: "fake-response",
    content: [],
    usage: { input_tokens: 3, output_tokens: 2 },
  });
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

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: 429 then success records one request on the serving account`, async () => {
    const [primary, second] = await setup(provider);
    const bodies: unknown[] = [];
    const calls = mockAttempts((token, init) => {
      bodies.push(JSON.parse(String(init.body)));
      if (token === "Bearer fake-primary")
        return limited(provider, "PRIVATE CONTENT");
      return new Response(
        provider === "codex"
          ? 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"fake-response","status":"completed","usage":{"input_tokens":3,"output_tokens":2}}}\n\n'
          : 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        { headers: { "content-type": "text/event-stream" } }
      );
    });
    const response = await request(provider);
    expect(response.status).toBe(200);
    await response.text();
    expect(calls).toEqual(["Bearer fake-primary", "Bearer fake-second"]);
    expect(bodies).toHaveLength(2);
    for (const body of bodies)
      expect(body).toMatchObject({ model: "fake-model" });
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
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      event: "proxy_rate_limit_failover",
      provider,
      fromAccountId: primary.id,
      toAccountId: second.id,
      resetInSeconds: 90,
    });
    expect(
      JSON.stringify([...warn.mock.calls, ...info.mock.calls])
    ).not.toContain("PRIVATE CONTENT");
  });

  test(`${provider}: all limited returns last 429, then skips every cooled account`, async () => {
    const [, , third] = await setup(provider);
    const calls = mockAttempts((token) => limited(provider, token));
    const response = await request(provider);
    expect(response.status).toBe(429);
    expect(response.headers.get("x-fake-attempt")).toBe("Bearer fake-third");
    expect(await response.json()).toMatchObject({
      error: { message: "Bearer fake-third" },
    });
    expect(calls).toHaveLength(3);
    expect(await buckets()).toMatchObject([
      { providerAccountId: third.id, requestCount: 1, rateLimitCount: 1 },
    ]);
    const next = await request(provider);
    expect(next.status).toBe(429);
    expect(Number(next.headers.get("retry-after"))).toBeGreaterThan(0);
    await next.text();
    expect(calls).toHaveLength(3);
  });

  test(`${provider}: excluded alternate is skipped`, async () => {
    const [, second] = await setup(provider);
    await updateProviderAccountProfile(db, second.id, {
      label: null,
      accountId: second.accountId,
      metadata: null,
      excludeFromFailover: true,
      now: Date.now(),
    });
    const calls = mockAttempts((token) =>
      token === "Bearer fake-primary" ? limited(provider) : success()
    );
    await (await request(provider)).text();
    expect(calls).toEqual(["Bearer fake-primary", "Bearer fake-third"]);
  });

  test(`${provider}: toggle off forwards 429 without retry or cooldown`, async () => {
    const [primary] = await setup(provider);
    await setRateLimitFailoverEnabled(db, false);
    const calls = mockAttempts(() => limited(provider));
    for (let index = 0; index < 2; index++) {
      const response = await request(provider);
      expect(response.status).toBe(429);
      await response.text();
    }
    expect(calls).toEqual(["Bearer fake-primary", "Bearer fake-primary"]);
    expect(accountCooldowns.resetAt(primary)).toBe(0);
    expect(info).not.toHaveBeenCalled();
  });

  test(`${provider}: a single pin never escapes to other accounts`, async () => {
    const [, second] = await setup(provider);
    pins = [second.id];
    const calls = mockAttempts(() => limited(provider));
    expect((await request(provider)).status).toBe(429);
    expect(calls).toEqual(["Bearer fake-second"]);
  });

  test(`${provider}: multiple pins retry only their allowed accounts`, async () => {
    const [primary, second] = await setup(provider);
    pins = [primary.id, second.id];
    const calls = mockAttempts(() => limited(provider));
    await (await request(provider)).text();
    expect(calls).toEqual(["Bearer fake-primary", "Bearer fake-second"]);
  });

  test(`${provider}: cooldown skips preferred on next request and restores it after reset`, async () => {
    const [primary, second] = await setup(provider);
    const calls = mockAttempts((token) =>
      token === "Bearer fake-primary" ? limited(provider) : success()
    );
    await (await request(provider)).text();
    await (await request(provider)).text();
    expect(calls).toEqual([
      "Bearer fake-primary",
      "Bearer fake-second",
      "Bearer fake-second",
    ]);
    expect(await buckets()).toMatchObject([
      { providerAccountId: second.id, requestCount: 2, successCount: 2 },
    ]);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 91_000);
    try {
      mockAttempts(() => success());
      await (await request(provider)).text();
      expect(accountCooldowns.resetAt(primary)).toBe(0);
      expect(
        (await buckets()).find((row) => row.providerAccountId === primary.id)
          ?.requestCount
      ).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  test.each([401, 403, 500])(
    `${provider}: does not fail over HTTP %s`,
    async (status) => {
      await setup(provider);
      const calls = mockAttempts(() =>
        Response.json({ error: { type: "permission_error" } }, { status })
      );
      const response = await request(provider);
      expect(response.status).toBe(status);
      await response.text();
      expect(calls).toHaveLength(1);
    }
  );

  test(`${provider}: unrelated 429 is never retried`, async () => {
    await setup(provider);
    const calls = mockAttempts(() =>
      Response.json({ error: { type: "overloaded_error" } }, { status: 429 })
    );
    expect((await request(provider)).status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  test(`${provider}: per-minute throttling neither fails over nor cools the account`, async () => {
    const [primary] = await setup(provider);
    const body = {
      error: {
        type:
          provider === "claude" ? "rate_limit_error" : "rate_limit_exceeded",
        code: "rate_limit_exceeded",
      },
    };
    const calls = mockAttempts(() =>
      Response.json(body, {
        status: 429,
        headers: {
          "retry-after": "60",
          ...(provider === "claude"
            ? { "anthropic-ratelimit-unified-status": "allowed" }
            : { "x-codex-primary-used-percent": "10" }),
        },
      })
    );
    for (let index = 0; index < 2; index++) {
      const response = await request(provider);
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual(body);
    }
    expect(calls).toEqual(["Bearer fake-primary", "Bearer fake-primary"]);
    expect(accountCooldowns.resetAt(primary)).toBe(0);
    expect(info).not.toHaveBeenCalled();
  });

  test(`${provider}: auth replay on the alternate composes with failover`, async () => {
    const [, second] = await setup(provider);
    const calls = mockAttempts(async (token) => {
      if (token === "Bearer fake-primary") return limited(provider);
      if (token === "Bearer fake-second") {
        await updateProviderAccountTokens(db, second.id, {
          accessToken: "fake-refreshed",
          refreshToken: second.refreshToken,
          expiresAt: Date.now() + 3_600_000,
          lastRefreshStatus: "success",
          now: Date.now(),
        });
        return Response.json(
          { error: { type: "authentication_error" } },
          { status: 401 }
        );
      }
      return success();
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

  test(`${provider}: a rate-limit error after streaming output starts is not replayed`, async () => {
    const [primary] = await setup(provider);
    let finish: () => void = () => undefined;
    const calls = mockAttempts(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const first =
                provider === "claude"
                  ? {
                      type: "message_start",
                      message: { usage: { input_tokens: 3 } },
                    }
                  : { type: "response.created", response: { id: "fake" } };
              controller.enqueue(
                new TextEncoder().encode(
                  `event: ${first.type}\ndata: ${JSON.stringify(first)}\n\n`
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
    if (!response.body) throw new Error("Expected a response body");
    const reader = response.body.getReader();
    expect((await reader.read()).value?.length).toBeGreaterThan(0);
    finish();
    let result = await reader.read();
    while (!result.done) result = await reader.read();
    expect(calls).toHaveLength(1);
    expect(accountCooldowns.resetAt(primary)).toBe(0);
    expect(
      (await buckets()).reduce((sum, row) => sum + row.requestCount, 0)
    ).toBe(1);
  });

  test(`${provider}: auth replay can lead to a rate-limit failover`, async () => {
    const [primary, second] = await setup(provider);
    const calls = mockAttempts(async (token) => {
      if (token === "Bearer fake-primary") {
        await updateProviderAccountTokens(db, primary.id, {
          accessToken: "fake-refreshed",
          refreshToken: primary.refreshToken,
          expiresAt: Date.now() + 3_600_000,
          lastRefreshStatus: "success",
          now: Date.now(),
        });
        return Response.json(
          { error: { type: "authentication_error" } },
          { status: 401 }
        );
      }
      return token === "Bearer fake-refreshed" ? limited(provider) : success();
    });
    await (await request(provider)).text();
    expect(calls).toEqual([
      "Bearer fake-primary",
      "Bearer fake-refreshed",
      "Bearer fake-second",
    ]);
    expect(await buckets()).toMatchObject([
      { providerAccountId: second.id, requestCount: 1, successCount: 1 },
    ]);
  });

  test(`${provider}: excluded preferred still serves primary traffic and can fail away`, async () => {
    const [primary] = await setup(provider);
    await updateProviderAccountProfile(db, primary.id, {
      label: null,
      accountId: primary.accountId,
      metadata: null,
      excludeFromFailover: true,
      now: Date.now(),
    });
    const calls = mockAttempts((token) =>
      token === "Bearer fake-primary" ? limited(provider) : success()
    );
    await (await request(provider)).text();
    expect(calls).toEqual(["Bearer fake-primary", "Bearer fake-second"]);
  });

  test(`${provider}: missing reset headers use a short cooldown`, async () => {
    const [primary] = await setup(provider);
    mockAttempts((token) => {
      if (token !== "Bearer fake-primary") return success();
      const response = limited(provider);
      response.headers.delete("retry-after");
      return response;
    });
    const now = Date.now();
    await (await request(provider)).text();
    expect(accountCooldowns.resetAt(primary)).toBeGreaterThanOrEqual(
      now + 30_000
    );
    expect(accountCooldowns.resetAt(primary)).toBeLessThanOrEqual(
      Date.now() + 30_000
    );
  });
}

test("Codex delayed usage-limit JSON still fails over after the logging read expires", async () => {
  const [, second] = await setup("codex");
  const calls = mockAttempts((token) =>
    token !== "Bearer fake-primary"
      ? success()
      : new Response(
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
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "retry-after": "18000",
            },
          }
        )
  );
  const response = await request("codex");
  expect(response.status).toBe(200);
  await response.text();
  expect(calls).toEqual(["Bearer fake-primary", "Bearer fake-second"]);
  expect(await buckets()).toMatchObject([
    { providerAccountId: second.id, requestCount: 1, successCount: 1 },
  ]);
});

test("Claude header-only subscription rejection cancels the discarded stream before retry", async () => {
  const [, second] = await setup("claude");
  let cancelled = 0;
  const calls = mockAttempts((token) =>
    token === "Bearer fake-primary"
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'event: error\ndata: {"type":"error"}\n\n'
                )
              );
            },
            cancel() {
              cancelled++;
            },
          }),
          {
            status: 429,
            headers: {
              "content-type": "text/event-stream",
              "anthropic-ratelimit-unified-status": "rejected",
              "retry-after": "90",
            },
          }
        )
      : success()
  );
  await (await request("claude")).text();
  expect(calls).toEqual(["Bearer fake-primary", "Bearer fake-second"]);
  expect(cancelled).toBe(1);
  expect(await buckets()).toMatchObject([
    { providerAccountId: second.id, requestCount: 1, successCount: 1 },
  ]);
});

test("admin API persists the off-by-default toggle and account exclusion with validation", async () => {
  const [primary] = await setup("claude");
  await setRateLimitFailoverEnabled(db, false);
  expect(await (await app.request("/admin/accounts/failover")).json()).toEqual({
    enabled: false,
  });
  const update = await app.request("/admin/accounts/failover", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: '{"enabled":true}',
  });
  expect(await update.json()).toEqual({ enabled: true });
  const exclusion = await app.request(`/admin/accounts/${primary.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: '{"excludeFromFailover":true}',
  });
  expect(await exclusion.json()).toMatchObject({
    account: { excludeFromFailover: true },
  });
  const invalid = await app.request("/admin/accounts/failover", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: '{"enabled":"true"}',
  });
  expect(invalid.status).toBe(400);
});
