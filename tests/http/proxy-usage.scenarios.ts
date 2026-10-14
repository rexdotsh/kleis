import { beforeAll, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { migrate } from "drizzle-orm/libsql/migrator";
import { installErrorHandler } from "../../src/http/error-handler";

// Run through proxy-usage.test.ts, which starts this file in its own process
// with an in-memory database.
if (process.env.TURSO_CONNECTION_URL !== ":memory:") {
  throw new Error("proxy usage scenarios need TURSO_CONNECTION_URL=:memory:");
}
const { db } = await import("../../src/db");
const { upsertProviderAccount, updateProviderAccountTokens } =
  await import("../../src/db/repositories/provider-accounts");
const { requestUsageBuckets } = await import("../../src/db/schema");
const { proxyRoutes, flushProxyUsage, flushProxyFailureLogs } =
  await import("../../src/http/routes/proxy");

const app = new Hono();
installErrorHandler(app);
app.use("*", async (context, next) => {
  context.set("proxyApiKeyId", "fake-key");
  context.set("proxyApiKeyAccountScopeIds", null);
  context.set("proxyRequestBody", {
    text: "{}",
    parsed: {},
    model: context.req.path.startsWith("/openai/") ? "gpt-fake" : "claude-fake",
  });
  await next();
});
app.route("/", proxyRoutes);

let account: Awaited<ReturnType<typeof upsertProviderAccount>>;
beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
  account = await upsertProviderAccount(db, {
    provider: "claude",
    accountId: "fake-account",
    accessToken: "fake-token-1",
    refreshToken: "fake-refresh-1",
    expiresAt: Date.now() + 3_600_000,
    metadata: null,
    now: Date.now(),
  });
  await upsertProviderAccount(db, {
    provider: "codex",
    accountId: "fake-codex-account",
    accessToken: "fake-codex-token",
    refreshToken: "fake-codex-refresh",
    expiresAt: Date.now() + 3_600_000,
    metadata: null,
    now: Date.now(),
  });
});

const event = (payload: { type: string; [field: string]: unknown }) =>
  `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
const usage = {
  input_tokens: 3,
  output_tokens: 2,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 7,
};
const complete =
  event({ type: "message_start", message: { usage } }) +
  event({ type: "message_delta", usage: { output_tokens: 11 } }) +
  event({ type: "message_stop" });
const request = () =>
  app.request("/anthropic/v1/messages", { method: "POST", body: "{}" });

test("route records one successful SSE request including latest tokens", async () => {
  await db.delete(requestUsageBuckets);
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(complete, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
  try {
    const response = await request();
    expect(response.status).toBe(200);
    await response.text();
    await flushProxyUsage();
    expect(await db.select().from(requestUsageBuckets)).toMatchObject([
      {
        requestCount: 1,
        successCount: 1,
        inputTokens: 3,
        outputTokens: 11,
        cacheReadTokens: 5,
        cacheWriteTokens: 7,
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("route auth replay records only final stream with refreshed account", async () => {
  await db.delete(requestUsageBuckets);
  const original = globalThis.fetch;
  let calls = 0;
  let firstCancelled = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    expect(String(url).includes("api.anthropic.com/")).toBe(true);
    calls++;
    if (calls === 1) {
      await updateProviderAccountTokens(db, account.id, {
        accessToken: "fake-token-2",
        refreshToken: "fake-refresh-2",
        expiresAt: Date.now() + 3_600_000,
        now: Date.now(),
        accountId: account.accountId,
        metadata: null,
      });
      return new Response(
        new ReadableStream({
          cancel() {
            firstCancelled++;
          },
        }),
        { status: 401, headers: { "content-type": "text/event-stream" } }
      );
    }
    return new Response(complete, {
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    const response = await request();
    await response.text();
    await flushProxyUsage();
    expect(calls).toBe(2);
    expect(firstCancelled).toBe(1);
    expect(await db.select().from(requestUsageBuckets)).toMatchObject([
      {
        requestCount: 1,
        successCount: 1,
        inputTokens: 3,
        outputTokens: 11,
        cacheReadTokens: 5,
        cacheWriteTokens: 7,
      },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("route preserves non-2xx SSE classification in the usage bucket", async () => {
  await db.delete(requestUsageBuckets);
  const original = globalThis.fetch;
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  globalThis.fetch = (async () =>
    new Response(
      'event: error\ndata: {"type":"error","error":{"type":"permission_error","message":"Forbidden"}}\n\n',
      { status: 403, headers: { "content-type": "text/event-stream" } }
    )) as typeof fetch;
  try {
    const response = await request();
    expect(response.status).toBe(403);
    await response.text();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      event: "proxy_upstream_response_failed",
      provider: "claude",
      providerAccountId: account.id,
      status: 403,
    });
    await flushProxyUsage();
    expect(await db.select().from(requestUsageBuckets)).toMatchObject([
      {
        requestCount: 1,
        authErrorCount: 1,
        serverErrorCount: 0,
      },
    ]);
  } finally {
    log.mockRestore();
    globalThis.fetch = original;
  }
});

for (const [provider, path] of [
  ["codex", "/openai/v1/responses"],
  ["claude", "/anthropic/v1/messages"],
] as const) {
  test.each([403, 429, 503])(
    `${provider} non-2xx %s is logged once without provider content`,
    async (status) => {
      const original = globalThis.fetch;
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      const error = spyOn(console, "error").mockImplementation(() => undefined);
      const body = {
        error: {
          type: "permission_error",
          code: "private-code",
          message: "private prompt",
        },
      };
      globalThis.fetch = (async () =>
        Response.json(body, { status })) as typeof fetch;
      try {
        const response = await app.request(path, {
          method: "POST",
          body: "{}",
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(body);
        const calls = [...warn.mock.calls, ...error.mock.calls];
        expect(calls).toHaveLength(1);
        const line = String(calls[0]?.[0]);
        expect(JSON.parse(line)).toMatchObject({
          event: "proxy_upstream_response_failed",
          level: status >= 500 ? "error" : "warn",
          provider,
          providerAccountId: expect.any(String),
          status,
          errorType: "permission_error",
          errorCode: null,
          elapsedMs: expect.any(Number),
        });
        expect(line).not.toContain("private");
      } finally {
        warn.mockRestore();
        error.mockRestore();
        globalThis.fetch = original;
      }
    }
  );
}

test("thrown upstream failures reach the global error handler exactly once", async () => {
  const original = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  globalThis.fetch = (() =>
    Promise.reject(
      new Error("ConnectionRefused: upstream socket")
    )) as typeof fetch;
  try {
    expect((await request()).status).toBe(500);
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      event: "http_request_failed",
      provider: "claude",
      providerAccountId: account.id,
      errorMessage: "ConnectionRefused: upstream socket",
    });
  } finally {
    warn.mockRestore();
    log.mockRestore();
    globalThis.fetch = original;
  }
});

test("100 identical Claude 429s do not flood the logs or change client responses", async () => {
  const originalFetch = globalThis.fetch;
  const log = spyOn(console, "warn").mockImplementation(() => undefined);
  const body = {
    error: {
      type: "rate_limit_error",
      code: "rate_limit_exceeded",
      message: "PRIVATESECRETTOKEN",
    },
  };
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json(body, {
        status: 429,
        headers: { "x-request-id": "PRIVATESECRETTOKEN" },
      })
    )) as typeof fetch;
  try {
    for (let index = 0; index < 100; index++) {
      const response = await request();
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual(body);
    }
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: "proxy_upstream_response_failed",
      status: 429,
      errorCode: "rate_limit_exceeded",
    });
    expect(line).not.toContain("PRIVATESECRETTOKEN");
    await flushProxyFailureLogs();
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({
      suppressedCount: 99,
      summaryReason: "shutdown",
      errorCode: "rate_limit_exceeded",
    });
    expect(String(log.mock.calls[1]?.[0])).not.toContain("PRIVATESECRETTOKEN");
    await flushProxyFailureLogs();
    expect(log).toHaveBeenCalledTimes(2);
  } finally {
    log.mockRestore();
    globalThis.fetch = originalFetch;
  }
});
