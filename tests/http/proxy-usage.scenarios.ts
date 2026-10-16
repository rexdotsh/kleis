import { beforeAll, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { migrate } from "drizzle-orm/libsql/migrator";
import { installErrorHandler } from "../../src/http/error-handler";

// Run through proxy-usage.test.ts, which starts this file in its own process
// with an in-memory database.
if (
  process.env.TURSO_CONNECTION_URL !== ":memory:" ||
  process.env.TURSO_AUTH_TOKEN
) {
  throw new Error(
    "proxy usage scenarios need an unauthenticated in-memory database"
  );
}
const { db } = await import("../../src/db");
const { upsertProviderAccount, updateProviderAccountTokens } =
  await import("../../src/db/repositories/provider-accounts");
const { requestUsageBuckets } = await import("../../src/db/schema");
const { createApiKey } = await import("../../src/db/repositories/api-keys");
const { requireProxyApiKey } =
  await import("../../src/http/middleware/api-key-auth");
const { proxyRoutes, flushProxyUsage, flushProxyFailureLogs } =
  await import("../../src/http/routes/proxy");

const app = new Hono();
installErrorHandler(app);
app.use("*", async (context, next) => {
  context.set("proxyApiKeyId", "fake-key");
  context.set("proxyApiKeyAccountScopeIds", null);
  const text = await context.req.text();
  context.set("proxyRequestBody", {
    text,
    parsed: JSON.parse(text) as unknown,
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

test("proxy authorization enforces credentials, provider and model scopes before forwarding", async () => {
  const key = await createApiKey(
    db,
    {
      providerScopes: ["codex"],
      modelScopes: ["openai/gpt-fake"],
    },
    Date.now()
  );
  const authenticated = new Hono();
  authenticated.use("*", requireProxyApiKey);
  authenticated.route("/", proxyRoutes);
  const original = globalThis.fetch;
  let forwarded = 0;
  globalThis.fetch = (async () => {
    forwarded++;
    return Response.json({ output: [] });
  }) as typeof fetch;
  try {
    for (const { path, token, model, status } of [
      {
        path: "/openai/v1/responses",
        token: "",
        model: "gpt-fake",
        status: 401,
      },
      {
        path: "/openai/v1/responses",
        token: "Bearer wrong",
        model: "gpt-fake",
        status: 401,
      },
      {
        path: "/anthropic/v1/messages",
        token: `Bearer ${key.key}`,
        model: "claude-fake",
        status: 403,
      },
      {
        path: "/openai/v1/responses",
        token: `Bearer ${key.key}`,
        model: "gpt-other",
        status: 403,
      },
      {
        path: "/openai/v1/responses",
        token: `Bearer ${key.key}`,
        model: "anthropic/gpt-fake",
        status: 403,
      },
      {
        path: "/openai/v1/responses",
        token: `Bearer ${key.key}`,
        model: "",
        status: 400,
      },
      {
        path: "/openai/v1/responses",
        token: `bEaReR ${key.key}`,
        model: "openai/gpt-fake",
        status: 200,
      },
      {
        path: "/openai/v1/responses/compact",
        token: `Bearer ${key.key}`,
        model: "codex/gpt-fake",
        status: 200,
      },
    ]) {
      const before = forwarded;
      const response = await authenticated.request(path, {
        method: "POST",
        headers: { authorization: token },
        body: JSON.stringify({ model }),
      });
      expect(response.status).toBe(status);
      await response.text();
      expect(forwarded - before).toBe(status === 200 ? 1 : 0);
    }
    await flushProxyUsage();
  } finally {
    globalThis.fetch = original;
  }
});

test("the proxy forwards its selected credential, never client secrets, spoofed accounts or IPs", async () => {
  const original = globalThis.fetch;
  let upstream = new Headers();
  globalThis.fetch = (async (_input, init) => {
    upstream = new Headers(init?.headers);
    return Response.json({ output: [] });
  }) as typeof fetch;
  try {
    const response = await app.request("/openai/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer kleis_private",
        "x-api-key": "kleis_private",
        "ChatGPT-Account-Id": "spoofed",
        cookie: "session=private",
        forwarded: "for=192.0.2.4",
        "x-forwarded-for": "192.0.2.4",
        "cf-connecting-ip": "192.0.2.4",
      },
      body: "{}",
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(upstream.get("authorization")).toBe("Bearer fake-codex-token");
    expect(upstream.get("ChatGPT-Account-Id")).toBe("fake-codex-account");
    for (const name of [
      "x-api-key",
      "cookie",
      "forwarded",
      "x-forwarded-for",
      "cf-connecting-ip",
    ]) {
      expect(upstream.has(name)).toBe(false);
    }
    await flushProxyUsage();
  } finally {
    globalThis.fetch = original;
  }
});

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

test("Codex streaming HTTP errors without content-type retain bytes and log safe metadata once", async () => {
  await flushProxyUsage();
  await db.delete(requestUsageBuckets);
  const original = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const error = spyOn(console, "error").mockImplementation(() => undefined);
  const body =
    '{ "error": { "type": "server_error", "code": "overloaded_error", "message": "PRIVATESECRETTOKEN" } }';
  globalThis.fetch = (async () =>
    new Response(new TextEncoder().encode(body), {
      status: 503,
      headers: { "retry-after": "3" },
    })) as typeof fetch;
  try {
    const response = await app.request("/openai/v1/responses", {
      method: "POST",
      body: '{"stream":true}',
    });
    expect(response.status).toBe(503);
    expect(response.headers.has("content-type")).toBe(false);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(await response.text()).toBe(body);
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: "proxy_upstream_response_failed",
      provider: "codex",
      status: 503,
      errorType: "server_error",
      errorCode: "overloaded_error",
    });
    expect(line).not.toContain("PRIVATESECRETTOKEN");
    await flushProxyUsage();
    expect(await db.select().from(requestUsageBuckets)).toMatchObject([
      { requestCount: 1, successCount: 0, serverErrorCount: 1 },
    ]);
  } finally {
    warn.mockRestore();
    error.mockRestore();
    globalThis.fetch = original;
  }
});

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
