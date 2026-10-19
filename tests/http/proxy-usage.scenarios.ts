import { beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
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
let codexAccount: typeof account;
beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
  account = await upsertProviderAccount(db, {
    provider: "claude",
    accountId: "fake-account",
    label: "Fake Claude",
    accessToken: "fake-token-1",
    refreshToken: "fake-refresh-1",
    expiresAt: Date.now() + 3_600_000,
    metadata: null,
    now: Date.now(),
  });
  codexAccount = await upsertProviderAccount(db, {
    provider: "codex",
    accountId: "fake-codex-account",
    label: "Fake Codex",
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

beforeEach(async () => {
  await flushProxyUsage();
  await flushProxyFailureLogs();
  await db.delete(requestUsageBuckets);
});

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

test("Codex HTTP-200 SSE rate limits count as failed requests", async () => {
  const original = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const body = event({
    type: "error",
    error: { type: "rate_limit_error", message: "Try again later" },
  });
  globalThis.fetch = (async () =>
    new Response(body, {
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
  try {
    const response = await app.request("/openai/v1/responses", {
      method: "POST",
      body: '{"stream":true}',
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    await flushProxyUsage();
    expect(await db.select().from(requestUsageBuckets)).toMatchObject([
      { requestCount: 1, successCount: 0, rateLimitCount: 1 },
    ]);
  } finally {
    warn.mockRestore();
    globalThis.fetch = original;
  }
});

test("route auth replay records only final stream with refreshed account", async () => {
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
  test(`${provider} defers SSE accounting until downstream cancellation`, async () => {
    const original = globalThis.fetch;
    let cancelled = 0;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(new TextEncoder().encode(": ping\n\n"));
          },
          cancel(): void {
            cancelled++;
          },
        }),
        provider === "codex"
          ? {}
          : { headers: { "content-type": "text/event-stream" } }
      )) as typeof fetch;
    try {
      const response = await app.request(path, {
        method: "POST",
        body: '{"stream":true}',
      });
      await flushProxyUsage();
      expect(await db.select().from(requestUsageBuckets)).toEqual([]);
      await response.body?.cancel();
      await flushProxyUsage();
      expect(cancelled).toBe(1);
      expect(await db.select().from(requestUsageBuckets)).toMatchObject([
        { requestCount: 1, successCount: 0, clientErrorCount: 1 },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

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

test("exhausted 429s expose only the blocking window's reset and account", async () => {
  const originalFetch = globalThis.fetch;
  const now = Math.floor(Date.now() / 1000) * 1000;
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const seconds = 3 * 3600 + 12 * 60;
  const reset = now + seconds * 1000;
  const resetsAt = new Date(reset).toISOString();
  const cases = [
    {
      provider: "claude",
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-reset": String(reset / 1000),
      },
    },
    {
      provider: "claude",
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-5h-reset": String(reset / 1000),
        "anthropic-ratelimit-unified-7d-utilization": "0.2",
        "anthropic-ratelimit-unified-7d-reset": String(reset / 1000 + 86400),
        "anthropic-ratelimit-unified-reset": String(reset / 1000 + 86400),
      },
    },
    {
      provider: "claude",
      headers: {
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-5h-utilization": "1",
        "anthropic-ratelimit-unified-5h-reset": String(reset / 1000),
        "anthropic-ratelimit-unified-7d-utilization": "0.2",
        "anthropic-ratelimit-unified-7d-reset": String(reset / 1000 + 86400),
      },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-at": String(reset / 1000),
        "x-codex-secondary-used-percent": "20",
        "x-codex-secondary-reset-at": String(reset / 1000 + 86400),
      },
      type: "rate_limit_error",
      error: { resets_in_seconds: seconds * 2 },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-after-seconds": String(seconds),
      },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-primary-used-percent": "20",
        "x-codex-primary-reset-at": String(reset / 1000 + 86400),
      },
      error: { resets_in_seconds: seconds },
    },
    {
      provider: "codex",
      error: { resets_at: reset / 1000 },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-active-limit": "bengalfox",
        "x-codex-bengalfox-primary-used-percent": "100",
        "x-codex-bengalfox-primary-reset-at": String(reset / 1000),
        "x-codex-bengalfox-secondary-used-percent": "20",
        "x-codex-bengalfox-secondary-reset-at": String(reset / 1000 + 86400),
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-at": String(reset / 1000 + 86400),
      },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-active-limit": " CODEX_BENGALFOX ",
        "x-codex-bengalfox-secondary-used-percent": "100",
        "x-codex-bengalfox-secondary-reset-after-seconds": String(seconds),
      },
      type: "rate_limit_error",
    },
    {
      provider: "codex",
      headers: {
        "x-codex-primary-used-percent": "100",
        "x-codex-primary-reset-at": String(now / 1000 - 30),
      },
      error: { resets_at: reset / 1000 },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-active-limit": "premium",
        "x-codex-premium-primary-used-percent": "20",
        "x-codex-premium-primary-reset-at": String(reset / 1000 + 86400),
        "x-codex-bengalfox-primary-used-percent": "100",
        "x-codex-bengalfox-primary-reset-at": String(reset / 1000 + 86400),
      },
      error: { resets_at: reset / 1000 },
    },
    {
      provider: "codex",
      headers: {
        "x-codex-primary-used-percent": "20",
        "x-codex-bengalfox-primary-used-percent": "100",
        "x-codex-bengalfox-primary-reset-at": String(reset / 1000 + 86400),
      },
      error: { resets_at: reset / 1000 },
    },
  ] as const;
  try {
    for (const entry of cases) {
      const selected = entry.provider === "claude" ? account : codexAccount;
      globalThis.fetch = (async () =>
        Response.json(
          {
            error: {
              type:
                entry.provider === "claude"
                  ? "rate_limit_error"
                  : "type" in entry
                    ? entry.type
                    : "usage_limit_reached",
              code:
                "type" in entry ? "rate_limit_exceeded" : "usage_limit_reached",
              message: "PRIVATESECRETTOKEN",
              ...("error" in entry ? entry.error : {}),
            },
          },
          {
            status: 429,
            headers: {
              ...("headers" in entry ? entry.headers : {}),
              "retry-after": "61",
              "retry-after-ms": "61000",
              "x-request-id": "fake-request",
              "content-encoding": "gzip",
              "content-length": "999",
            },
          }
        )) as typeof fetch;
      const response = await app.request(
        entry.provider === "claude"
          ? "/anthropic/v1/messages"
          : "/openai/v1/responses",
        { method: "POST", body: '{"stream":true}' }
      );
      expect(response.status).toBe(429);
      for (const header of [
        "retry-after",
        "retry-after-ms",
        "content-encoding",
        "content-length",
      ]) {
        expect(response.headers.has(header)).toBe(false);
      }
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      expect(response.headers.get("x-request-id")).toBe("fake-request");
      const body = await response.json();
      expect(body).toEqual({
        ...(entry.provider === "claude" ? { type: "error" } : {}),
        error: {
          type:
            entry.provider === "claude"
              ? "rate_limit_error"
              : "type" in entry
                ? entry.type
                : "usage_limit_reached",
          ...(entry.provider === "codex"
            ? {
                code:
                  "type" in entry
                    ? "rate_limit_exceeded"
                    : "usage_limit_reached",
              }
            : {}),
          message: `${entry.provider === "claude" ? "Claude" : "Codex"} usage limit reached for account "${selected.label}". Resets at ${resetsAt} (in 3h 12m).`,
          resets_at: resetsAt,
          account: selected.label,
        },
      });
      expect(JSON.stringify(body)).not.toContain("PRIVATESECRETTOKEN");
    }
    await flushProxyUsage();
    const rows = await db.select().from(requestUsageBuckets);
    for (const provider of ["claude", "codex"] as const) {
      const count = cases.filter((entry) => entry.provider === provider).length;
      expect(rows.find((row) => row.provider === provider)).toMatchObject({
        requestCount: count,
        rateLimitCount: count,
        successCount: 0,
      });
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATESECRETTOKEN");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Fake Claude");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Fake Codex");
  } finally {
    clock.mockRestore();
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("short or missing retry hints preserve non-exhausted 429 bytes and headers", async () => {
  const originalFetch = globalThis.fetch;
  const now = Math.floor(Date.now() / 1000) * 1000;
  const clock = spyOn(Date, "now").mockReturnValue(now);
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const body =
    '{ "error": { "type": "rate_limit_error", "message": "Try later", "resets_in_seconds": 7200 } }';
  try {
    for (const entry of [
      {
        path: "/anthropic/v1/messages",
        headers: { "retry-after": "60", "retry-after-ms": "60000" },
      },
      { path: "/openai/v1/responses", headers: { "retry-after-ms": "60000" } },
      {
        path: "/anthropic/v1/messages",
        headers: {
          "anthropic-ratelimit-unified-5h-reset": String(now / 1000 + 60),
        },
      },
      {
        path: "/openai/v1/responses",
        headers: { "x-codex-primary-reset-at": String(now / 1000 + 10800) },
      },
      {
        path: "/openai/v1/responses",
        headers: {
          "retry-after": "3",
          "x-codex-active-limit": "premium",
          "x-codex-premium-primary-used-percent": "20",
          "x-codex-premium-primary-reset-at": String(now / 1000 + 10800),
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-reset-at": String(now / 1000 + 10800),
          "x-codex-bengalfox-primary-used-percent": "100",
          "x-codex-bengalfox-primary-reset-at": String(now / 1000 + 10800),
        },
      },
      {
        path: "/openai/v1/responses",
        headers: {
          "retry-after": "3",
          "x-codex-primary-used-percent": "20",
          "x-codex-bengalfox-primary-used-percent": "100",
          "x-codex-bengalfox-primary-reset-at": String(now / 1000 + 10800),
        },
      },
      {
        path: "/openai/v1/responses",
        headers: {
          "retry-after": "3",
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-reset-at": String(now / 1000 - 30),
        },
      },
      {
        path: "/anthropic/v1/messages",
        headers: {
          "retry-after": "3",
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-5h-utilization": "1",
          "anthropic-ratelimit-unified-5h-reset": String(now / 1000 - 30),
          "anthropic-ratelimit-unified-reset": String(now / 1000 + 10800),
        },
      },
      {
        path: "/openai/v1/responses",
        headers: {
          "retry-after": "3",
          "x-codex-primary-used-percent": "100",
        },
      },
      {
        path: "/anthropic/v1/messages",
        headers: {
          "retry-after": "3",
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-5h-utilization": "1",
        },
      },
    ]) {
      const headers = new Headers({
        ...entry.headers,
        "content-type": "application/json",
        "x-request-id": "fake-short-throttle",
      });
      globalThis.fetch = (async () =>
        new Response(body, { status: 429, headers })) as typeof fetch;
      const response = await app.request(entry.path, {
        method: "POST",
        body: '{"stream":true}',
      });
      expect(response.status).toBe(429);
      expect([...response.headers]).toEqual([...headers]);
      expect(await response.text()).toBe(body);
    }
  } finally {
    clock.mockRestore();
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("explicitly exhausted 429s never borrow retry hints, expired or allowed resets", async () => {
  const originalFetch = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (const entry of [
      {
        provider: "claude",
        path: "/anthropic/v1/messages",
        selected: account,
        type: "rate_limit_error",
        code: null,
        headers: {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-5h-utilization": "1",
          "anthropic-ratelimit-unified-5h-reset": String(
            Date.now() / 1000 - 30
          ),
          "anthropic-ratelimit-unified-7d-utilization": "0.2",
          "anthropic-ratelimit-unified-7d-reset": String(
            Date.now() / 1000 + 10800
          ),
        },
      },
      {
        provider: "codex",
        path: "/openai/v1/responses",
        selected: codexAccount,
        type: "usage_limit_reached",
        code: "usage_limit_reached",
        resets_at: Date.now() / 1000 - 30,
        headers: {
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-reset-at": String(Date.now() / 1000 - 30),
          "x-codex-secondary-used-percent": "20",
          "x-codex-secondary-reset-at": String(Date.now() / 1000 + 10800),
        },
      },
      {
        provider: "codex",
        path: "/openai/v1/responses",
        selected: codexAccount,
        type: "usage_limit_reached",
        code: "usage_limit_reached",
        headers: {
          "x-codex-active-limit": "premium",
          "x-codex-premium-primary-used-percent": "20",
          "x-codex-bengalfox-primary-used-percent": "100",
          "x-codex-bengalfox-primary-reset-at": String(
            Date.now() / 1000 + 10800
          ),
        },
      },
    ]) {
      globalThis.fetch = (async () =>
        Response.json(
          {
            error: {
              type: entry.type,
              code: entry.code,
              message: "PRIVATESECRETTOKEN",
              ...("resets_at" in entry ? { resets_at: entry.resets_at } : {}),
            },
          },
          {
            status: 429,
            headers: {
              ...entry.headers,
              "retry-after": "61",
              "retry-after-ms": "61000",
            },
          }
        )) as typeof fetch;
      const response = await app.request(entry.path, {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(429);
      expect(response.headers.has("retry-after")).toBe(false);
      expect(response.headers.has("retry-after-ms")).toBe(false);
      expect(await response.json()).toEqual({
        ...(entry.provider === "claude" ? { type: "error" } : {}),
        error: {
          type: entry.type,
          ...(entry.provider === "codex" ? { code: entry.code } : {}),
          message: `${entry.provider === "claude" ? "Claude" : "Codex"} usage limit reached for account "${entry.selected.label}". Reset time unknown.`,
          resets_at: null,
          account: entry.selected.label,
        },
      });
    }
  } finally {
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("long ordinary throttles retain their retryable upstream error body", async () => {
  const originalFetch = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const body =
    '{ "error": { "type": "rate_limit_error", "message": "Rate limit exceeded. Try again later." } }';
  try {
    for (const entry of [
      { path: "/anthropic/v1/messages", headers: { "retry-after": "61" } },
      { path: "/openai/v1/responses", headers: { "retry-after": "61" } },
      {
        path: "/anthropic/v1/messages",
        headers: { "retry-after-ms": "61000" },
      },
      {
        path: "/openai/v1/responses",
        headers: {
          "retry-after": new Date(Date.now() + 120000).toUTCString(),
          "retry-after-ms": "invalid",
        },
      },
    ]) {
      const headers = new Headers({
        ...entry.headers,
        "content-type": "application/json",
        "x-request-id": "fake-throttle",
        "x-should-retry": "true",
      });
      globalThis.fetch = (async () =>
        new Response(body, { status: 429, headers })) as typeof fetch;
      const response = await app.request(entry.path, {
        method: "POST",
        body: '{"stream":true}',
      });
      expect(response.status).toBe(429);
      expect(response.headers.has("retry-after")).toBe(false);
      expect(response.headers.has("retry-after-ms")).toBe(false);
      headers.delete("retry-after");
      headers.delete("retry-after-ms");
      expect([...response.headers]).toEqual([...headers]);
      expect(await response.text()).toBe(body);
    }
  } finally {
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("allowed Claude quota resets cannot turn a throttle into subscription exhaustion", async () => {
  const originalFetch = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const body =
    '{ "type": "error", "error": { "type": "rate_limit_error", "message": "Rate limit exceeded" } }';
  try {
    for (const utilization of ["0.2", "0.99999"]) {
      const headers = new Headers({
        "content-type": "application/json",
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
        "anthropic-ratelimit-unified-5h-utilization": utilization,
        "anthropic-ratelimit-unified-reset": String(Date.now() / 1000 + 10800),
      });
      globalThis.fetch = (async () =>
        new Response(body, { status: 429, headers })) as typeof fetch;
      const response = await request();
      expect(response.status).toBe(429);
      expect([...response.headers]).toEqual([...headers]);
      expect(await response.text()).toBe(body);
    }
  } finally {
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});

test("synthesized quota errors discard upstream retry overrides and hints", async () => {
  const originalFetch = globalThis.fetch;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    for (const entry of [
      {
        path: "/anthropic/v1/messages",
        type: "rate_limit_error",
        headers: { "anthropic-ratelimit-unified-status": "rejected" },
      },
      {
        path: "/openai/v1/responses",
        type: "usage_limit_reached",
        headers: {},
      },
    ]) {
      globalThis.fetch = (async () =>
        Response.json(
          { error: { type: entry.type, message: "Limit reached" } },
          {
            status: 429,
            headers: {
              ...entry.headers,
              "retry-after": "61",
              "retry-after-ms": "61000",
              "x-should-retry": "true",
              "x-ms-retry-after-ms": "61000",
              "x-request-id": "fake-quota",
            },
          }
        )) as typeof fetch;
      const response = await app.request(entry.path, {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(429);
      expect(response.headers.get("x-request-id")).toBe("fake-quota");
      for (const header of [
        "retry-after",
        "retry-after-ms",
        "x-should-retry",
        "x-ms-retry-after-ms",
      ]) {
        expect(response.headers.has(header)).toBe(false);
      }
      expect(await response.json()).toMatchObject({
        error: {
          type: entry.type,
          resets_at: null,
          account: expect.any(String),
        },
      });
    }
  } finally {
    warn.mockRestore();
    globalThis.fetch = originalFetch;
  }
});
